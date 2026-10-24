/** 外接GET兼容契约：不要求新增查询参数，持久查询优先且精确校验Key，旧内存仍可轮询。 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  legacy: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/uol", () => ({ invokeOperation: state.invoke }));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: state.auth,
}));
vi.mock("@/features/external-api/async-image-tasks", () => ({
  getAsyncImageTask: state.legacy,
  toAsyncImageTaskResponse: (task: {
    userId: string;
    apiKeyId: string;
    id: string;
    status: string;
  }) => ({ id: task.id, status: task.status }),
}));
import { getExternalEditableFileTask } from "./editable-file-tasks";
const id = "task_opaque_previous_contract";
/** URL只带旧路径，不带kind/fingerprint；认证身份由服务端mock返回。 */
async function poll() {
  return getExternalEditableFileTask(
    new NextRequest(`https://example.invalid/v1/editable-file-tasks/${id}`),
    { params: Promise.resolve({ taskId: id }) }
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  state.auth.mockResolvedValue({
    userId: "u1",
    apiKeyId: "k1",
    plan: "ultra",
    relayOnly: false,
  });
  state.invoke.mockResolvedValue(null);
});
describe("editable task GET compatibility", () => {
  it("原async ID直接轮询旧内存，不增加必填参数", async () => {
    state.legacy.mockReturnValue({
      id,
      object: "editable_file_task",
      userId: "u1",
      apiKeyId: "k1",
      status: "processing",
    });
    const response = await poll();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: "processing" });
    expect(state.invoke).toHaveBeenCalledWith(
      "file.getTask",
      { taskId: id },
      expect.objectContaining({ userId: "u1", apiKeyId: "k1" })
    );
  });
  it("重启无内存时从持久结果重取，不强制客户端再传指纹", async () => {
    state.invoke.mockResolvedValue({
      publicId: id,
      taskId: id,
      kind: "ppt",
      status: "completed",
      requestFingerprint: "a".repeat(64),
      creditsCharged: 25,
      result: { conversationId: "c", primaryUrl: "fresh-url", zipUrl: null },
    });
    const response = await poll();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      status: "completed",
      result: { primary_url: "fresh-url" },
      credits_charged: 25,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.legacy).not.toHaveBeenCalled();
  });
  it("prepared过早轮询仍返回processing，不误404或触发重生成", async () => {
    state.invoke.mockResolvedValue({
      publicId: id,
      taskId: id,
      kind: "ppt",
      status: "prepared",
      requestFingerprint: "a".repeat(64),
      creditsCharged: 0,
      result: null,
    });
    expect(await (await poll()).json()).toMatchObject({
      status: "processing",
      lifecycle_status: "prepared",
      credits_charged: 0,
    });
  });
  it.each([
    "k2",
    undefined,
  ])("旧任务不同Key %s 也404，缺Key不能作为通配", async (apiKeyId) => {
    state.legacy.mockReturnValue({
      id,
      object: "editable_file_task",
      userId: "u1",
      apiKeyId,
      status: "completed",
    });
    expect((await poll()).status).toBe(404);
  });
  it("持久不同Key查不到，不能兜底泄露另一个内存任务", async () => {
    state.auth.mockResolvedValue({
      userId: "u1",
      apiKeyId: "k2",
      plan: "ultra",
      relayOnly: false,
    });
    state.legacy.mockReturnValue({
      id,
      object: "editable_file_task",
      userId: "u1",
      apiKeyId: "k1",
      status: "completed",
    });
    expect((await poll()).status).toBe(404);
  });
  it("待退映射旧failed状态并保留明确生命周期，不能谎报退款完成", async () => {
    state.invoke.mockResolvedValue({
      publicId: id,
      taskId: id,
      kind: "ppt",
      status: "refund_pending",
      requestFingerprint: "a".repeat(64),
      creditsCharged: 25,
      result: null,
    });
    expect(await (await poll()).json()).toMatchObject({
      status: "failed",
      lifecycle_status: "refund_pending",
      credits_charged: 25,
      error: { code: "editable_file_refund_pending" },
    });
  });
});
