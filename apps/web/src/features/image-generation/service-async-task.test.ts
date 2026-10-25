/**
 * service.ts 接入池 API 异步任务模式（速度马兼容）：受理只回任务号时轮询 /tasks 交付图片，
 * 不发 stream；上游直接回图、提交即报错、开关关闭时行为与原来一致。安全连接层另有单测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./safe-api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-api-fetch")>()),
  fetchApiRequest: (_config: unknown, url: string, init?: RequestInit) =>
    fetch(url, init),
}));

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async () => false),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

import type { ApiConfig } from "./types";

const BASE = "https://upstream.example.test/v1";
const IMAGE_URL = "https://img.example.test/i/result.png";

type Call = { url: string; init?: RequestInit };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function poolConfig(
  requestKind: "image_generation" | "image_edit",
  asyncTaskMode = true
): ApiConfig {
  return {
    baseUrl: BASE,
    apiKey: "test-key",
    model: "gpt-image-2",
    // 管理员同时开着流式：异步模式下仍不得发 stream。
    useStream: true,
    backend: {
      type: "pool-api",
      id: "api_async",
      groupId: "group_1",
      requestKind,
      apiInterfaceMode: "images",
      imagesUpstreamMode: "images",
      asyncTaskMode,
      reportResult: false,
    },
  };
}

/** 依次返回给定响应，记录每次请求。 */
function stubUpstream(responses: Response[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next;
    })
  );
  return calls;
}

async function loadService() {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
  return import("./service");
}

/** 让轮询的等待推进完，直到结果返回。 */
async function settle<T>(pending: Promise<T>) {
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("池 API 异步任务模式", () => {
  it("生图：受理回任务号后轮询 /tasks/{id}，成功交付 data[].url，且不发 stream", async () => {
    const { generateImage } = await loadService();
    const calls = stubUpstream([
      json({ requestId: "req_1", status: "created" }),
      json({ id: "req_1", status: "processing", progress: 40, data: [] }),
      json({
        id: "req_1",
        status: "succeeded",
        progress: 100,
        error: "",
        data: [{ type: "image", url: IMAGE_URL }],
      }),
    ]);

    const result = await settle(
      generateImage(poolConfig("image_generation"), { prompt: "cat" })
    );

    expect(result.error).toBeUndefined();
    expect(result.imageUrl).toBe(IMAGE_URL);
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["POST", `${BASE}/images/generations`],
      ["GET", `${BASE}/tasks/req_1`],
      ["GET", `${BASE}/tasks/req_1`],
    ]);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("partial_images");
    expect(
      (calls[1]?.init?.headers as Record<string, string>).Authorization
    ).toBe("Bearer test-key");
  });

  it("改图（multipart）同样轮询交付，表单里不带 stream", async () => {
    const { editImage } = await loadService();
    const calls = stubUpstream([
      json({ requestId: "req_2", status: "created" }),
      json({ status: "succeeded", data: [{ url: IMAGE_URL }] }),
    ]);

    const result = await settle(
      editImage(poolConfig("image_edit"), {
        prompt: "make it blue",
        images: [
          { data: Buffer.from("image"), name: "a.png", type: "image/png" },
        ],
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.imageUrl).toBe(IMAGE_URL);
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/images/edits`,
      `${BASE}/tasks/req_2`,
    ]);
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("stream")).toBeNull();
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("任务失败：返回带任务号与原因的错误", async () => {
    const { generateImage } = await loadService();
    stubUpstream([
      json({ requestId: "req_3", status: "created" }),
      json({ status: "failed", error: "provider request invalid", data: [] }),
    ]);

    const result = await settle(
      generateImage(poolConfig("image_generation"), { prompt: "cat" })
    );

    expect(result.error).toBe(
      "Upstream Images API task req_3 failed: provider request invalid"
    );
  });

  it("上游直接回图时照常使用，不再轮询", async () => {
    const { generateImage } = await loadService();
    const calls = stubUpstream([
      json({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }),
    ]);

    const result = await settle(
      generateImage(poolConfig("image_generation"), { prompt: "cat" })
    );

    expect(result.imageBase64).toBe("aW1hZ2U=");
    expect(calls).toHaveLength(1);
  });

  it("提交即报错时沿用原错误文案，不轮询", async () => {
    const { generateImage } = await loadService();
    const calls = stubUpstream([
      json({ error: { message: "没有匹配的价格" } }, 400),
    ]);

    const result = await settle(
      generateImage(poolConfig("image_generation"), { prompt: "cat" })
    );

    expect(result.error).toBe(
      "Upstream Images API returned HTTP 400: 没有匹配的价格"
    );
    expect(calls).toHaveLength(1);
  });

  it("开关关闭时行为不变：任务号响应仍按“没有图片”失败，并照常发 stream", async () => {
    const { generateImage } = await loadService();
    const calls = stubUpstream([
      json({ requestId: "req_4", status: "created" }),
    ]);

    const result = await settle(
      generateImage(poolConfig("image_generation", false), { prompt: "cat" })
    );

    expect(result.error).toBe("created");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body)).stream).toBe(true);
  });
});
