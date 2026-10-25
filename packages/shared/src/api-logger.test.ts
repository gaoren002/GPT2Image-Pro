/** withApiLogging：错误响应的原因并入访问日志，且不改变响应本身。 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ api: vi.fn(), error: vi.fn() }));
vi.mock("./logger/index", () => ({
  logApiResponse: logs.api,
  logError: logs.error,
}));
vi.mock("./rate-limit/index", () => ({
  checkRateLimit: vi.fn(),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn(),
  getRateLimitHeaders: vi.fn(),
}));
vi.mock("./rate-limit/large-body-routes", () => ({
  getHandlerRateLimitType: () => null,
}));

import { withApiLogging } from "./api-logger";

/** 用给定响应构造一次真实的包装调用。 */
async function call(response: Response) {
  const handler = withApiLogging(
    async (_request: NextRequest, _context: never) => response
  );
  return handler(
    new Request("https://example.test/v1/images/edits", {
      method: "POST",
    }) as unknown as NextRequest,
    undefined as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("错误原因日志", () => {
  it("4xx JSON 把类型与信息并入访问日志，客户端拿到的正文不变", async () => {
    const body = {
      error: {
        message: "Image URL must be publicly reachable.",
        type: "invalid_request_error",
        code: null,
        status: 400,
      },
    };
    const response = await call(Response.json(body, { status: 400 }));
    expect(await response.json()).toEqual(body);
    await vi.waitFor(() => expect(logs.api).toHaveBeenCalledOnce());
    expect(logs.api.mock.calls[0]?.[3]).toEqual({
      errorType: "invalid_request_error",
      errorMessage: "Image URL must be publicly reachable.",
    });
  });

  it("记录错误码；站内 {error:string} 也能取到信息", async () => {
    await call(
      Response.json(
        { error: { message: "Task not found.", code: "task_not_found" } },
        { status: 404 }
      )
    );
    await call(Response.json({ error: "Not found" }, { status: 404 }));
    await vi.waitFor(() => expect(logs.api).toHaveBeenCalledTimes(2));
    expect(logs.api.mock.calls.map((args) => args[3])).toEqual(
      expect.arrayContaining([
        { errorCode: "task_not_found", errorMessage: "Task not found." },
        { errorMessage: "Not found" },
      ])
    );
  });

  it("信息压成单行并截断到 300 字符", async () => {
    await call(
      Response.json(
        { error: { message: `第一行\n第二行 ${"长".repeat(400)}` } },
        { status: 400 }
      )
    );
    await vi.waitFor(() => expect(logs.api).toHaveBeenCalledOnce());
    const message = logs.api.mock.calls[0]?.[3]?.errorMessage as string;
    expect(message.startsWith("第一行 第二行 ")).toBe(true);
    expect(message).toHaveLength(300);
  });

  it("成功响应同步记录，不读正文", async () => {
    await call(Response.json({ data: [] }));
    expect(logs.api).toHaveBeenCalledOnce();
    expect(logs.api.mock.calls[0]).toHaveLength(3);
  });

  it("流式错误响应不复制正文，直接记录基础日志", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: error\n\n"));
      },
    });
    const response = await call(
      new Response(stream, {
        status: 400,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
    expect(logs.api).toHaveBeenCalledOnce();
    expect(logs.api.mock.calls[0]).toHaveLength(3);
    // 未被复制的流仍可完整读取，说明没有被日志层锁定或消费。
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();
  });

  it("超过 16KB 的错误体不解析，只记录基础日志", async () => {
    await call(
      Response.json(
        { error: { message: "x".repeat(20 * 1024) } },
        { status: 400 }
      )
    );
    await vi.waitFor(() => expect(logs.api).toHaveBeenCalledOnce());
    expect(logs.api.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("不结束的 JSON 错误流在 5 秒后放弃读取，只记录基础日志", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
        },
      });
      await call(
        new Response(stream, {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      );
      expect(logs.api).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(logs.api).toHaveBeenCalledOnce();
      expect(logs.api.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("非法 JSON 错误体不影响请求，只记录基础日志", async () => {
    await call(
      new Response("{not json", {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    await vi.waitFor(() => expect(logs.api).toHaveBeenCalledOnce());
    expect(logs.api.mock.calls[0]?.[3]).toBeUndefined();
  });
});
