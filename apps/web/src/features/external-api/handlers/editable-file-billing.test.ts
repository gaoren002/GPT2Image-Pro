/** 文件计费错误传输契约：真实 handler/保活编码；隔离上游、鉴权、日志与异步任务。 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: async () => true,
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: async () => ({
    userId: "user-1",
    apiKeyId: "key-1",
    plan: "ultra",
  }),
}));
vi.mock("@/features/image-generation/editable-file-operations", () => ({
  runEditableFileForUser: state.run,
  prepareEditableFileExecution: state.prepare,
}));
vi.mock("@/features/external-api/async-image-tasks", () => ({
  AsyncImageTaskCapacityError: class extends Error {},
  createAsyncEditableFileTask: state.create,
  completeAsyncImageTask: state.complete,
  toAsyncImageTaskResponse: (task: unknown) => task,
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn() }));

import {
  postExternalPptGenerations,
  postExternalPsdGenerations,
} from "./editable-file-generations";

/** 构造最小 JSON 请求，signal 经 NextRequest 传给真实同步编排入口。 */
function request(async = false, signal?: AbortSignal) {
  return new NextRequest("https://example.invalid/v1/ppts", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_task_id: "task-1",
      prompt: "slides",
      async,
      base64_images: ["aW1hZ2U="],
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  state.run.mockResolvedValue({
    conversationId: "c1",
    primaryUrl: "https://storage.invalid/file",
    zipUrl: null,
    creditsCharged: 25,
  });
  state.prepare.mockImplementation(async (params: unknown) => ({
    requestFingerprint: "a".repeat(64),
    publicTaskId: "async-1",
    execute: () => state.run(params),
  }));
  state.create.mockReturnValue({ id: "async-1", status: "processing" });
});

describe("异步ACK丢失的恢复ID", () => {
  it.each([
    "running",
    "refunded",
  ])("服务核验过的%s重放409返回原ID和GET路径，不执行", async () => {
    const pollId = "task_original_opaque_id_123456";
    state.prepare.mockRejectedValue(
      Object.assign(new Error("Task already exists"), {
        code: "editable_file_task_already_consumed",
        publicTaskId: pollId,
      })
    );
    const response = await postExternalPptGenerations(request(true));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      poll_id: pollId,
      poll_url: `/v1/editable-file-tasks/${pollId}`,
    });
    expect(state.run).not.toHaveBeenCalled();
  });
  it.each([
    "different key",
    "changed fingerprint",
  ])("%s的冲突未附恢复ID，不泄露新旧opaque ID", async () => {
    state.prepare.mockRejectedValue(
      Object.assign(new Error("Task identity conflict"), {
        code: "editable_file_task_already_consumed",
      })
    );
    const response = await postExternalPptGenerations(request(true));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).not.toHaveProperty("poll_id");
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("poll_url");
    expect(state.run).not.toHaveBeenCalled();
  });
});

describe.each([
  postExternalPptGenerations,
  postExternalPsdGenerations,
])("PPT/PSD 财务错误响应", (handler) => {
  it("重放错误保留 409 与专属 code", async () => {
    state.run.mockRejectedValue(
      Object.assign(
        new Error(
          "Editable file task ID is already in use. Please start a new task."
        ),
        { code: "editable_file_task_already_consumed" }
      )
    );
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { status: 409, code: "editable_file_task_already_consumed" },
    });
  });

  it("Key 额度不足映射为 402", async () => {
    state.run.mockRejectedValue(
      new Error("API key quota exceeded: required 25, remaining 0")
    );
    const response = await handler(request());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "api_key_quota_exceeded" },
    });
  });

  it.each([
    "editable_file_delivery_pending",
    "editable_file_refund_pending",
    "editable_file_quota_release_pending",
  ])("%s 暴露稳定的待处理 code", async (code) => {
    state.run.mockRejectedValue(
      Object.assign(new Error("Editable file billing settlement is pending"), {
        code,
      })
    );
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code, status: 503 },
    });
  });

  it("同步 signal 传到编排，异步被接受后独立于 HTTP 生命周期", async () => {
    const controller = new AbortController();
    await handler(request(false, controller.signal));
    const signal = (state.run.mock.calls[0]?.[0] as { signal?: AbortSignal })
      .signal;
    expect(signal).toBeDefined();
    controller.abort();
    expect(signal?.aborted).toBe(true);
    await handler(request(true, controller.signal));
    expect(
      (state.run.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal
    ).toBeUndefined();
  });

  it("异步错误完成记录也保留幂等 code", async () => {
    state.run.mockRejectedValue(
      Object.assign(new Error("Editable file task ID is already in use"), {
        code: "editable_file_task_already_consumed",
      })
    );
    await handler(request(true));
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalled());
    expect(state.complete).toHaveBeenCalledWith(
      "async-1",
      expect.objectContaining({
        error: expect.objectContaining({
          error: expect.objectContaining({
            code: "editable_file_task_already_consumed",
            status: 409,
          }),
        }),
      })
    );
  });
});
