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
  reserveKey: vi.fn(),
  releaseKey: vi.fn(),
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
vi.mock("@/features/external-api/quota", () => ({
  reserveExternalApiKeyCredits: state.reserveKey,
  refundExternalApiKeyCredits: state.releaseKey,
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
    assertEditableTaskExecutable: async () => 30 * 60_000,
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

import { runEditableFileForUser } from "./editable-file-operations";

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
  state.reserveKey.mockImplementation(
    async (params: { apiKeyId?: string; amount: number }) => {
      if (!params.apiKeyId) return;
      state.events.push("key-reserve");
      if (state.keyLimit - state.keyUsed < params.amount)
        throw new Error("API key quota exceeded");
      state.keyUsed += params.amount;
    }
  );
  state.releaseKey.mockImplementation(
    async (params: { apiKeyId?: string; amount: number }) => {
      if (params.apiKeyId) state.keyUsed -= params.amount;
    }
  );
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
  // 专用退款模拟净额封顶与钱包/原 Key 同事务退额；额外 releaseKey 会被断言发现。
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

describe("可编辑文件的固定费与任务认领", () => {
  it("旧 editable-file:taskId 消费存在时不再生成或重新收费", async () => {
    state.legacyEntries.add(
      JSON.stringify(["user-1", "consumption", "editable-file:task-1"])
    );
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_task_already_consumed",
    });
    expect(state.legacyReads).toContainEqual([
      "user-1",
      "consumption",
      "editable-file:task-1",
    ]);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
  });

  it("旧键按用户隔离，不阻止另一用户的相同 taskId", async () => {
    state.legacyEntries.add(
      JSON.stringify(["user-1", "consumption", "editable-file:task-1"])
    );
    await runEditableFileForUser(request({ userId: "user-2" }));
    expect(state.legacyReads).toContainEqual([
      "user-2",
      "consumption",
      "editable-file:task-1",
    ]);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
  });

  it("原子消费钱包和 Key 后调用上游，无独立预留或补偿", async () => {
    const result = await runEditableFileForUser(request());
    expect(result.creditsCharged).toBe(25);
    expect(state.events).toEqual(["wallet-consume", "key-capture", "upstream"]);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    const debit = state.consume.mock.calls[0]?.[0] as ConsumeCreditsParams;
    expect(debit.externalApiKeyId).toBe("key-1");
    expect(debit.sourceRef).toBeTruthy();
    expect(debit.metadata).toMatchObject({
      kind: "ppt",
    });
    expect(debit.metadata?.generationId).toEqual(expect.any(String));
  });

  it("串行重放或修改 prompt 都拒绝再次执行，Key 不增加也不独立退额", async () => {
    await runEditableFileForUser(request());
    await expect(
      runEditableFileForUser(request({ prompt: "changed" }))
    ).rejects.toMatchObject({ code: "editable_file_task_already_consumed" });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
  });

  it("并发同任务只允许一个上游和一份扣费", async () => {
    const results = await Promise.allSettled([
      runEditableFileForUser(request()),
      runEditableFileForUser(request()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
  });

  it("同 taskId 的 PPT、PSD 分别认领，避免旧公共前缀少扣", async () => {
    await runEditableFileForUser(request());
    await runEditableFileForUser(
      request({ kind: "psd", base64Images: ["aW1hZ2U="] })
    );
    expect(
      new Set(
        state.consume.mock.calls.map(
          ([params]) => (params as ConsumeCreditsParams).sourceRef
        )
      ).size
    ).toBe(2);
    expect(state.wallet).toBe(950);
    expect(state.keyUsed).toBe(50);
  });

  it("新 Key 重放旧任务也不 capture 或退还任何 Key", async () => {
    await runEditableFileForUser(request());
    await expect(
      runEditableFileForUser(request({ apiKeyId: "key-2" }))
    ).rejects.toThrow();
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.keyUsed).toBe(25);
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("无有效固定费 %s 时失败关闭，不绕过认领", async (price) => {
    state.price = price;
    await expect(runEditableFileForUser(request())).rejects.toThrow();
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("PSD 缺图在扣费前拒绝", async () => {
    await expect(
      runEditableFileForUser(request({ kind: "psd" }))
    ).rejects.toThrow("base64_images is empty");
    expect(state.consume).not.toHaveBeenCalled();
  });

  it("内部无 Key 调用仍先扣固定费", async () => {
    await runEditableFileForUser(request({ apiKeyId: undefined }));
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(0);
    expect(state.events).toEqual(["wallet-consume", "upstream"]);
  });

  it("生成期间价格变化不补扣，本次保留执行前固定费快照", async () => {
    state.generate.mockImplementationOnce(async () => {
      state.price = 50;
      return output();
    });
    const result = await runEditableFileForUser(request());
    expect(result.creditsCharged).toBe(25);
    expect(state.setting).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
  });

  it("本地价格读取失败不调用上游，也不预留 Key", async () => {
    state.setting.mockRejectedValue(new Error("settings unavailable"));
    await expect(runEditableFileForUser(request())).rejects.toThrow(
      "settings unavailable"
    );
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.reserveKey).not.toHaveBeenCalled();
  });
});

describe("Key 额度与失败补偿", () => {
  it("creditLimit=0 不消费钱包、不执行上游", async () => {
    state.keyLimit = 0;
    await expect(runEditableFileForUser(request())).rejects.toThrow("quota");
    expect(state.consume).toHaveBeenCalledTimes(1);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.wallet).toBe(1000);
  });

  it("钱包不足时 Key 同事务不变，无上游与健康误报", async () => {
    state.wallet = 0;
    await expect(runEditableFileForUser(request())).rejects.toThrow(
      "insufficient credits"
    );
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.report).not.toHaveBeenCalled();
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.keyUsed).toBe(0);
    expect(state.refund).not.toHaveBeenCalled();
  });

  it("Key 额度不足的并发独立任务只有一个执行", async () => {
    state.keyLimit = 25;
    const results = await Promise.allSettled([
      runEditableFileForUser(request()),
      runEditableFileForUser(request({ taskId: "task-2" })),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.keyUsed).toBe(25);
  });

  it("上游耗尽四次后只结算一次专用退款，Key 不额外退", async () => {
    state.generate.mockRejectedValue(new Error("upstream failed"));
    await expect(runEditableFileForUser(request())).rejects.toThrow(
      "upstream failed"
    );
    expect(state.generate).toHaveBeenCalledTimes(4);
    expect(state.consume).toHaveBeenCalledTimes(1);
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
    expect(state.release).toHaveBeenCalledTimes(4);
  });

  it("失败已退款的任务重放仍拒绝，不能免费生成或重复退款", async () => {
    state.generate.mockRejectedValue(new Error("upstream failed"));
    await expect(runEditableFileForUser(request())).rejects.toThrow();
    state.generate.mockResolvedValue(output());
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_task_already_consumed",
    });
    expect(state.generate).toHaveBeenCalledTimes(4);
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });

  it("跨用户相同 taskId 的退款 sourceRef 不冲突且准确关联原消费", async () => {
    state.put.mockRejectedValue(new Error("storage unavailable"));
    await expect(runEditableFileForUser(request())).rejects.toThrow();
    await expect(
      runEditableFileForUser(request({ userId: "user-2" }))
    ).rejects.toThrow();
    const calls = state.refund.mock.calls.map(
      ([params]) => params as Parameters<typeof refundGenerationCredits>[0]
    );
    expect(new Set(calls.map((params) => params.sourceRef)).size).toBe(2);
    for (const params of calls) {
      const debit = Array.from(state.entries.values()).find(
        (entry) => entry.userId === params.userId
      );
      expect(params.generationId).toBe(debit?.metadata?.generationId);
    }
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });

  it("退款失败显式保留待处理错误和任务，不能换号或重复执行", async () => {
    state.put.mockRejectedValue(new Error("storage unavailable"));
    state.refund.mockRejectedValue(new Error("refund database unavailable"));
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_refund_pending",
    });
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_task_already_consumed",
    });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
  });

  it("退款接口仍有 remainingDebited 时不能假报已退清", async () => {
    state.put.mockRejectedValue(new Error("storage unavailable"));
    state.refund.mockResolvedValue({
      refunded: false,
      amount: 0,
      remainingDebited: 25,
    });
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_refund_pending",
    });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
  });

  it("独立 Key 预留/退额接口故障不影响原子 capture，因为编排不再调用它们", async () => {
    state.reserveKey.mockRejectedValue(new Error("key database unavailable"));
    state.releaseKey.mockRejectedValue(new Error("key database unavailable"));
    await runEditableFileForUser(request());
    expect(state.reserveKey).not.toHaveBeenCalled();
    expect(state.releaseKey).not.toHaveBeenCalled();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
    expect(state.refund).not.toHaveBeenCalled();
  });
});

describe("本地失败与池健康隔离", () => {
  it.each([
    "primary",
    "zip",
  ])("%s 存储失败只生成一次，健康按上游成功上报", async (stage) => {
    state.generate.mockResolvedValue(output(true));
    if (stage === "zip") state.put.mockResolvedValueOnce(undefined);
    state.put.mockRejectedValue(new Error("storage unavailable"));
    await expect(runEditableFileForUser(request())).rejects.toThrow(
      "storage unavailable"
    );
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.report).toHaveBeenCalledTimes(1);
    expect(state.report).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });

  it("完成态签名失败保留付费结果，恢复签名可重取", async () => {
    state.sign.mockReturnValue(null);
    await expect(runEditableFileForUser(request())).rejects.toMatchObject({
      code: "editable_file_delivery_pending",
    });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
    expect(state.refund).not.toHaveBeenCalled();
    state.sign.mockReturnValue("fresh-result");
    expect((await runEditableFileForUser(request())).primaryUrl).toBe(
      "fresh-result"
    );
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("本地池读取失败不误记账号失败，扣费经专用退款归还", async () => {
    state.resolve.mockRejectedValue(new Error("pool database unavailable"));
    await expect(runEditableFileForUser(request())).rejects.toThrow(
      "pool database unavailable"
    );
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.report).not.toHaveBeenCalled();
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });

  it("池无候选会退清已扣固定费", async () => {
    state.resolve.mockResolvedValue(null);
    await expect(runEditableFileForUser(request())).rejects.toThrow();
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });

  it("真正上游失败可换号，固定费只扣一次", async () => {
    state.generate.mockRejectedValueOnce(new Error("upstream failed"));
    await runEditableFileForUser(request());
    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(state.consume).toHaveBeenCalledTimes(1);
    expect(
      state.report.mock.calls.map(
        ([params]) => (params as { success: boolean }).success
      )
    ).toEqual([false, true]);
    expect(state.resolve.mock.calls[1]?.[0]).toMatchObject({
      excludedMemberKeys: ["account:web-1"],
    });
    expect(state.wallet).toBe(975);
    expect(state.keyUsed).toBe(25);
  });

  it("非 Web 候选只释放租约，不误报失败", async () => {
    state.resolve.mockResolvedValueOnce({
      config: config("responses-1", "responses"),
    });
    await runEditableFileForUser(request());
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.release).toHaveBeenCalledTimes(2);
    expect(state.report).toHaveBeenCalledTimes(1);
  });

  it("已取消请求不扣费、不执行", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("执行中取消不换号、不误报账号失败，并退回固定费", async () => {
    const controller = new AbortController();
    state.generate.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("cancelled by caller");
    });
    await expect(
      runEditableFileForUser(request({ signal: controller.signal }))
    ).rejects.toThrow();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.report).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.wallet).toBe(1000);
    expect(state.keyUsed).toBe(0);
  });
});
