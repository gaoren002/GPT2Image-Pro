/** R05/R06/R07：运行真实文件编排，隔离账本、Key、存储和上游，不访问数据库或网络。 */

import type { ConsumeCreditsParams } from "@repo/shared/credits/core";
import type { refundGenerationCredits } from "@repo/shared/generation-maintenance";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditableFileResult } from "./chatgpt-web";
import type { ApiConfig } from "./types";

type FixtureTask = {
  id: string;
  publicId: string;
  userId: string;
  apiKeyId: string | undefined;
  kind: string;
  fingerprint: string;
  amount: number;
  state: string;
  refs?: import("../../../../../packages/shared/src/editable-task-contract").EditableResultReferences;
};

const state = vi.hoisted(() => ({
  tasks: new Map<string, FixtureTask>(),
  checkWork: vi.fn(),
  price: 25,
  wallet: 1000,
  keyLimit: 1000,
  keyUsed: 0,
  entries: new Map<string, ConsumeCreditsParams>(),
  refunds: new Set<string>(),
  legacyEntries: new Set<string>(),
  legacyReads: [] as unknown[][],
  events: [] as string[],
  consume: vi.fn(),
  refund: vi.fn(),
  generate: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
  report: vi.fn(),
  put: vi.fn(),
  storage: vi.fn(),
  sign: vi.fn(),
  setting: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          const params = new PgDialect().sqlToQuery(condition).params;
          state.legacyReads.push(params);
          return {
            limit: async () =>
              state.legacyEntries.has(JSON.stringify(params))
                ? [{ id: "legacy-debit" }]
                : [],
          };
        },
      }),
    }),
  },
}));

vi.mock("@repo/shared/credits/core", () => ({ consumeCredits: state.consume }));
vi.mock("@repo/shared/generation-maintenance", () => ({
  refundGenerationCredits: state.refund,
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn() }));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: state.storage,
}));
vi.mock("@repo/shared/storage/signed-url", () => ({
  buildSignedStorageImageUrl: state.sign,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: state.setting,
  getRuntimeSettingString: async () => "generations",
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  ImageBackendPoolUnavailableError: class extends Error {},
  resolveImageBackendPoolConfig: state.resolve,
  releaseImageBackendInflightLease: state.release,
  reportImageBackendResult: state.report,
}));
vi.mock("./chatgpt-web", () => ({
  generateFileWithChatGptWeb: state.generate,
}));

// 本文件只验证 Web 编排边界；真实任务SQL/事务/账本交错在 shared lifecycle 专项执行。
vi.mock("@repo/shared/editable-task-lifecycle", async () => {
  const contract = await import(
    "../../../../../packages/shared/src/editable-task-contract"
  );
  type Identity =
    import("../../../../../packages/shared/src/editable-task-contract").EditableTaskIdentity;
  type References =
    import("../../../../../packages/shared/src/editable-task-contract").EditableResultReferences;
  const deliver = async (task: FixtureTask) => {
    if (!task.refs) throw new contract.EditableFileTaskAlreadyConsumedError();
    const primaryUrl = state.sign(
      task.refs.primary.key,
      task.refs.primary.bucket
    ) as string | null;
    const zipUrl = task.refs.zip
      ? (state.sign(task.refs.zip.key, task.refs.zip.bucket) as string | null)
      : null;
    if (!primaryUrl || (task.refs.zip && !zipUrl))
      throw new contract.EditableTaskPendingError(
        "editable_file_delivery_pending"
      );
    return {
      conversationId: task.refs.conversationId,
      primaryUrl,
      zipUrl,
      creditsCharged: task.amount,
    };
  };
  return {
    ...contract,
    editableExecutionSignal: async (_claim: unknown, signal?: AbortSignal) =>
      signal ?? new AbortController().signal,
    assertEditableTaskExecutable: state.checkWork,
    getEditableTask: async (identity: Identity) => {
      const task = state.tasks.get(
        contract.editableTaskId(identity.userId, identity.kind, identity.taskId)
      );
      if (
        !task ||
        task.apiKeyId !== identity.apiKeyId ||
        task.fingerprint !== identity.requestFingerprint
      )
        return null;
      return {
        publicId: task.publicId,
        status: task.state,
        result: task.state === "completed" ? await deliver(task) : null,
      };
    },
    prepareEditableTask: async (identity: Identity, amount: number) => {
      const id = contract.editableTaskId(
        identity.userId,
        identity.kind,
        identity.taskId
      );
      const existing = state.tasks.get(id);
      if (existing) throw new contract.EditableFileTaskAlreadyConsumedError();
      const legacy = [
        identity.userId,
        "consumption",
        `editable-file:${identity.taskId}`,
      ];
      state.legacyReads.push(legacy);
      if (state.legacyEntries.has(JSON.stringify(legacy)))
        throw new contract.EditableFileTaskAlreadyConsumedError();
      const task: FixtureTask = {
        id,
        publicId: "task_fixture",
        userId: identity.userId,
        apiKeyId: identity.apiKeyId,
        kind: identity.kind,
        fingerprint: identity.requestFingerprint,
        amount,
        state: "prepared",
      };
      state.tasks.set(id, task);
      return { task, claim: { taskId: id, claimToken: "owner" } };
    },
    captureEditableTask: async (task: FixtureTask) => {
      if (task.state !== "prepared")
        throw new contract.EditableFileTaskAlreadyConsumedError();
      if (task.amount > 0) {
        const result = await state.consume({
          userId: task.userId,
          amount: task.amount,
          sourceRef: task.id,
          ...(task.apiKeyId ? { externalApiKeyId: task.apiKeyId } : {}),
          serviceName: "editable",
          metadata: { kind: task.kind, generationId: task.id },
        });
        if (result.alreadyConsumed)
          throw new contract.EditableFileTaskAlreadyConsumedError();
      }
      task.state = "running";
    },
    completeEditableTask: async (
      claim: { taskId: string },
      refs: References
    ) => {
      const task = state.tasks.get(claim.taskId);
      if (task?.state !== "running")
        throw new contract.EditableFileTaskAlreadyConsumedError();
      task.state = "completed";
      task.refs = refs;
      return task;
    },
    failEditableTask: async (id: string) => {
      const task = state.tasks.get(id);
      if (!task) throw new contract.EditableFileTaskAlreadyConsumedError();
      if (task.state === "completed") return task;
      if (task.state === "prepared") {
        task.state = "failed";
        return task;
      }
      task.state = "refund_pending";
      try {
        if (task.amount > 0) {
          const result = await state.refund({
            userId: task.userId,
            generationId: id,
            amount: task.amount,
            targetCredits: 0,
            sourceRef: `${id}:lifecycle-refund`,
          });
          if (result.remainingDebited !== 0) throw new Error("Unsettled debit");
        }
        task.state = "refunded";
        return task;
      } catch {
        throw new contract.EditableTaskPendingError(
          "editable_file_refund_pending"
        );
      }
    },
    deliverEditableTask: deliver,
  };
});
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "ultra" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  getPlanBillingConfig: async () => ({ chatRoundCredits: 3 }),
}));

import {
  runEditableFileForUser,
  prepareEditableFileExecution,
} from "./editable-file-operations";

/** 提供真实编排需要的最小付费 Web 账号，租约标识用于核对释放次数。 */
function config(
  id = "web-1",
  accountBackend: "web" | "responses" = "web"
): ApiConfig {
  return {
    baseUrl: "https://upstream.invalid",
    apiKey: "test-fixture",
    backend: {
      id,
      type: "pool-account",
      accountBackend,
      inflightLeaseId: `lease-${id}`,
      inflightLeasePersisted: true,
    },
  };
}

/** 固定二进制产物不触网，zip 可单独注入失败。 */
function output(zip = false): EditableFileResult {
  const binary = {
    buffer: Buffer.from("editable-file"),
    fileName: "fixture.pptx",
    mimeType: "application/octet-stream",
    size: 13,
  };
  return {
    conversationId: "conversation-1",
    primary: binary,
    zip: zip ? binary : null,
  };
}

/** 同一 taskId 默认带 Key；覆盖内部调用时可显式移除。 */
function request(
  overrides: Partial<Parameters<typeof runEditableFileForUser>[0]> = {}
) {
  return {
    userId: "user-1",
    apiKeyId: "key-1",
    kind: "ppt" as const,
    prompt: "fixture slides",
    base64Images: [],
    taskId: "task-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.checkWork.mockResolvedValue(30 * 60_000);
  state.tasks.clear();
  state.price = 25;
  state.wallet = 1000;
  state.keyLimit = 1000;
  state.keyUsed = 0;
  state.entries.clear();
  state.refunds.clear();
  state.legacyEntries.clear();
  state.legacyReads.length = 0;
  state.events.length = 0;
  state.setting.mockImplementation(async () => state.price);
  // 模拟消费唯一索引：认领在同一同步步骤完成，并发调用只允许一笔消费。
  state.consume.mockImplementation(async (params: ConsumeCreditsParams) => {
    state.events.push("wallet-consume");
    const key = JSON.stringify([params.userId, params.sourceRef]);
    if (state.entries.has(key))
      return { alreadyConsumed: true, consumedAmount: params.amount };
    if (state.wallet < params.amount) throw new Error("insufficient credits");
    if (params.externalApiKeyId !== undefined) {
      if (state.keyLimit - state.keyUsed < params.amount)
        throw new Error("API key quota exceeded");
      state.keyUsed += params.amount;
      state.events.push("key-capture");
    }
    state.entries.set(key, {
      ...params,
      metadata: {
        ...params.metadata,
        ...(params.externalApiKeyId !== undefined
          ? { externalApiKeyId: params.externalApiKeyId }
          : {}),
      },
    });
    state.wallet -= params.amount;
    return {
      success: true,
      consumedAmount: params.amount,
      alreadyConsumed: false,
    };
  });
  // 专用退款模拟净额封顶与钱包/原 Key 同事务退额。
  state.refund.mockImplementation(
    async (params: Parameters<typeof refundGenerationCredits>[0]) => {
      const debit = Array.from(state.entries.values()).find(
        (entry) =>
          entry.userId === params.userId &&
          entry.metadata?.generationId === params.generationId
      );
      const amount =
        debit && !state.refunds.has(params.sourceRef)
          ? Math.min(debit.amount, params.amount)
          : 0;
      state.refunds.add(params.sourceRef);
      state.wallet += amount;
      if (debit?.metadata?.externalApiKeyId) state.keyUsed -= amount;
      return { refunded: amount > 0, amount, remainingDebited: 0 };
    }
  );
  state.resolve.mockImplementation(async () => ({ config: config() }));
  state.release.mockResolvedValue(undefined);
  state.report.mockResolvedValue(undefined);
  state.generate.mockImplementation(async () => {
    state.events.push("upstream");
    return output();
  });
  state.storage.mockImplementation(async () => ({ putObject: state.put }));
  state.sign.mockImplementation(() => "https://storage.invalid/signed");
});

describe("R05 持久任务交付", () => {
  it("池查询await期间取消，上游/存储均不开始且正常释放池租约", async () => {
    const controller = new AbortController();
    state.resolve.mockImplementationOnce(async () => {
      controller.abort();
      return { config: config() };
    });
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.report).not.toHaveBeenCalled();
  });
  it("开工状态复核await期间取消，不再进入远端调用", async () => {
    const controller = new AbortController();
    state.checkWork.mockImplementationOnce(async () => {
      controller.abort();
      return 1000;
    });
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
  });
  it("上游返回后、存储provider await期间取消，不写主产物/ZIP", async () => {
    const controller = new AbortController();
    state.storage.mockImplementationOnce(async () => {
      controller.abort();
      return { putObject: state.put };
    });
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.put).not.toHaveBeenCalled();
  });
  it("primary写入后取消，不启动第二个ZIP存储写入", async () => {
    const controller = new AbortController();
    state.generate.mockResolvedValue(output(true));
    state.put.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.put).toHaveBeenCalledTimes(1);
  });
  it("异步接受前持久prepared，尚未扣费或执行上游", async () => {
    const prepared = await prepareEditableFileExecution(request());
    expect(state.tasks.size).toBe(1);
    expect([...state.tasks.values()][0]?.state).toBe("prepared");
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
    expect(prepared.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await prepared.execute();
    expect(state.generate).toHaveBeenCalledTimes(1);
  });
  it("chatRound与固定价先合并capture，交付后没有第二笔可能吞产物的扣费", async () => {
    const result = await runEditableFileForUser(
      request({ apiKeyId: undefined, chatRound: true })
    );
    expect(result.creditsCharged).toBe(28);
    expect(state.consume).toHaveBeenCalledTimes(1);
    expect(state.consume.mock.calls[0]?.[0]).toMatchObject({ amount: 28 });
    expect(state.events).toEqual(["wallet-consume", "upstream"]);
    expect(
      (
        await runEditableFileForUser(
          request({ apiKeyId: undefined, chatRound: true })
        )
      ).creditsCharged
    ).toBe(28);
    expect(state.consume).toHaveBeenCalledTimes(1);
  });
  it("chatRound额不足在上游之前失败，无已付产物被错误吞掉", async () => {
    state.wallet = 25;
    await expect(
      runEditableFileForUser(request({ apiKeyId: undefined, chatRound: true }))
    ).rejects.toThrow("insufficient");
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
    expect(state.wallet).toBe(25);
  });
  it("已完成任务变更chatRound意图为冲突，不绕过原请求指纹", async () => {
    await runEditableFileForUser(request({ apiKeyId: undefined }));
    await expect(
      runEditableFileForUser(request({ apiKeyId: undefined, chatRound: true }))
    ).rejects.toMatchObject({ code: "editable_file_task_already_consumed" });
    expect(state.generate).toHaveBeenCalledTimes(1);
  });
  it("零价仍认领，重复同一请求只执行一次并回放结果", async () => {
    state.price = 0;
    const first = await runEditableFileForUser(request());
    const second = await runEditableFileForUser(request());
    expect(first.creditsCharged).toBe(0);
    expect(second.primaryUrl).toBeTruthy();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(1000);
  });
  it("付费成功结果重签重取，不重复上游或扣费", async () => {
    await runEditableFileForUser(request());
    state.sign.mockReturnValue("https://storage.invalid/fresh");
    const second = await runEditableFileForUser(request());
    expect(second.primaryUrl).toBe("https://storage.invalid/fresh");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
  });
});
