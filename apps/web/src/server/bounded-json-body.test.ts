/** readJsonBodyWithinLimit：声明长度、实际字节、分块传输与非法输入的边界。 */

import { describe, expect, it } from "vitest";
import { readJsonBodyWithinLimit } from "./bounded-json-body";

/** 以指定分块构造无 Content-Length 的流式请求，模拟分块传输。 */
function streamedRequest(chunks: string[], onCancel?: () => void) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("https://app.example.test/api/mcp/user", {
    method: "POST",
    body,
    // Node 的 fetch 规范要求流式请求体显式声明半双工。
    duplex: "half",
  } as RequestInit);
}

describe("readJsonBodyWithinLimit", () => {
  it("上限内的 JSON 正常解析", async () => {
    const request = new Request("https://app.example.test/moderate", {
      method: "POST",
      body: JSON.stringify({ prompt: "cat" }),
    });
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: true,
      value: { prompt: "cat" },
    });
  });

  it("恰好等于上限仍接受", async () => {
    const payload = JSON.stringify({ text: "x".repeat(20) });
    const request = new Request("https://app.example.test/moderate", {
      method: "POST",
      body: payload,
    });
    expect(
      await readJsonBodyWithinLimit(request, Buffer.byteLength(payload))
    ).toMatchObject({ ok: true });
  });

  it("声明长度超限时不读取请求体即拒绝", async () => {
    const request = new Request("https://app.example.test/api/mcp/admin", {
      method: "POST",
      body: "x".repeat(2048),
      headers: { "content-length": "2048" },
    });
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: false,
      reason: "too_large",
    });
    // 未获取读取器：请求体没有被消费。
    expect(request.bodyUsed).toBe(false);
  });

  it("缺少 Content-Length 的分块传输按实际字节超限后取消读取", async () => {
    let cancelled = false;
    const request = streamedRequest(
      ['{"data":"', "a".repeat(600), "a".repeat(600), '"}'],
      () => {
        cancelled = true;
      }
    );
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("分块传输在上限内时拼接后解析", async () => {
    const request = streamedRequest(['{"jsonrpc":"2.0",', '"method":"ping"}']);
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: true,
      value: { jsonrpc: "2.0", method: "ping" },
    });
  });

  it.each([
    ["非法 JSON", "{not json"],
    ["空请求体", ""],
  ])("%s 返回 invalid_json", async (_label, payload) => {
    const request = new Request("https://app.example.test/moderate", {
      method: "POST",
      body: payload,
    });
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });

  it("读取中断时返回 invalid_json，不向调用方抛出原始错误", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client aborted with secret-token"));
      },
    });
    const request = new Request("https://app.example.test/api/mcp/user", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBodyWithinLimit(request, 1024)).toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });
});
