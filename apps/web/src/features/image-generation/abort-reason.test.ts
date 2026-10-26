/** 生成中止原因判定回归：客户端断开与截止超时必须给出不同文案，不能都记成超时。 */
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_CLOSED_REQUEST_ERROR,
  GENERATION_ABORTED_ERROR,
  resolveGenerationAbortError,
} from "./abort-reason";

/** 与 Next 在连接先于响应结束关闭时给 request.signal 的 reason 同形：name 为 ResponseAborted 的 Error。 */
function responseAborted() {
  const error = new Error();
  error.name = "ResponseAborted";
  return error;
}

describe("resolveGenerationAbortError", () => {
  it("没有信号或信号未中止时沿用历史文案", () => {
    expect(resolveGenerationAbortError(undefined)).toBe(
      GENERATION_ABORTED_ERROR
    );
    expect(resolveGenerationAbortError(new AbortController().signal)).toBe(
      GENERATION_ABORTED_ERROR
    );
  });

  it("客户端断开（ResponseAborted）使用客户端取消文案", () => {
    const controller = new AbortController();
    controller.abort(responseAborted());
    expect(resolveGenerationAbortError(controller.signal)).toBe(
      CLIENT_CLOSED_REQUEST_ERROR
    );
  });

  it("无理由的中止和未知理由保持历史文案，不冒充客户端取消", () => {
    const plain = new AbortController();
    plain.abort();
    expect(resolveGenerationAbortError(plain.signal)).toBe(
      GENERATION_ABORTED_ERROR
    );

    const custom = new AbortController();
    custom.abort(new Error("other reason"));
    expect(resolveGenerationAbortError(custom.signal)).toBe(
      GENERATION_ABORTED_ERROR
    );

    const nonObject = new AbortController();
    nonObject.abort("ResponseAborted");
    expect(resolveGenerationAbortError(nonObject.signal)).toBe(
      GENERATION_ABORTED_ERROR
    );
  });

  it("截止信号超时保持历史文案", async () => {
    const deadline = AbortSignal.timeout(1);
    await vi.waitFor(() => expect(deadline.aborted).toBe(true));
    expect(resolveGenerationAbortError(deadline)).toBe(
      GENERATION_ABORTED_ERROR
    );
  });

  it("合成信号取先中止的那一个的理由", async () => {
    // 与 operations.ts 的 generationSignal 同构：AbortSignal.any([截止, 请求])。
    const request = new AbortController();
    const clientFirst = AbortSignal.any([
      AbortSignal.timeout(60_000),
      request.signal,
    ]);
    request.abort(responseAborted());
    expect(resolveGenerationAbortError(clientFirst)).toBe(
      CLIENT_CLOSED_REQUEST_ERROR
    );

    const idle = new AbortController();
    const deadlineFirst = AbortSignal.any([
      AbortSignal.timeout(1),
      idle.signal,
    ]);
    await vi.waitFor(() => expect(deadlineFirst.aborted).toBe(true));
    expect(resolveGenerationAbortError(deadlineFirst)).toBe(
      GENERATION_ABORTED_ERROR
    );
  });
});
