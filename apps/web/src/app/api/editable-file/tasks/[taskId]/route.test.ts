/** 站内尝试ID查询：刷新前没有fingerprint仍可按session恢复，浏览器入口提供实际下载链接。 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: vi.fn(), invoke: vi.fn() }));
vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: state.session } },
}));
vi.mock("@repo/shared/uol", () => ({ invokeOperation: state.invoke }));
import { GET } from "./route";
beforeEach(() => {
  vi.resetAllMocks();
  state.session.mockResolvedValue({ user: { id: "u1", role: "user" } });
});
/** userMessageId在提交前产生；不要求客户端已收到响应或请求指纹。 */
function poll(accept = "application/json") {
  return GET(
    new NextRequest(
      "https://example.invalid/api/editable-file/tasks/message-1?kind=ppt",
      { headers: { accept } }
    ),
    { params: Promise.resolve({ taskId: "message-1" }) }
  );
}
describe("session editable task query", () => {
  it("只传尝试ID/kind；principal从会话取得", async () => {
    state.invoke.mockResolvedValue({
      taskId: "message-1",
      status: "prepared",
      result: null,
    });
    const response = await poll();
    expect(response.status).toBe(200);
    expect(state.invoke).toHaveBeenCalledWith(
      "file.getTask",
      { taskId: "message-1", kind: "ppt" },
      { type: "user", userId: "u1", role: "user" }
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("查询链接可在浏览器打开并直接下载重签文件", async () => {
    state.invoke.mockResolvedValue({
      taskId: "message-1",
      kind: "ppt",
      status: "completed",
      creditsCharged: 28,
      result: {
        primaryUrl: "/api/storage/generations/u1/file?sig=new&exp=1",
        zipUrl: null,
      },
    });
    const response = await poll("text/html");
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(
      'href="/api/storage/generations/u1/file?sig=new&amp;exp=1"'
    );
    expect(html).toContain("本次净扣费：28");
  });
  it("不存在/无权访问均404，不显示另一Key的结果", async () => {
    state.invoke.mockResolvedValue(null);
    expect((await poll()).status).toBe(404);
  });
  it("未登录不调用任务UOL", async () => {
    state.session.mockResolvedValue(null);
    expect((await poll()).status).toBe(401);
    expect(state.invoke).not.toHaveBeenCalled();
  });
});
