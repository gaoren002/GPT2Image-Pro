/** SR 客户端协议与统一 relay 边界：只使用小图、内存流和回环 mock worker。 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_BYTES } from "../../../worker/inference-protocol.mjs";
import { removeBackground } from "../psd-export/matte";
import { invokeInferenceWorker } from "./inference-worker";
import { SUPER_RESOLUTION_SCALE, superResolve } from "./super-resolution";

beforeEach(() => {
  vi.stubEnv("INFERENCE_WORKER_ENABLED", "true");
  vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://127.0.0.1:3310");
  vi.stubEnv("SUPER_RESOLUTION_WORKER_SECRET", "");
  vi.stubEnv("SUPER_RESOLUTION_WORKER_TIMEOUT_MS", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** 生成有真实尺寸/格式的小图，避免无效输入提前拒绝掩盖传输漏洞。 */
async function image(
  width = 2,
  height = 2,
  format: "png" | "jpeg" | "webp" = "png"
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 30, g: 60, b: 90, alpha: 0.5 },
    },
  })
    .toFormat(format)
    .toBuffer();
}
/** 按旧 worker PNG 协议构造响应。 */
function reply(output: Buffer): Response {
  return new Response(new Uint8Array(output), {
    headers: {
      "content-type": "image/png",
      "content-length": String(output.length),
    },
  });
}
/** 启动回环 fixture；不解析业务配置、不加载模型。 */
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture address");
  return `http://127.0.0.1:${address.port}`;
}
/** 结束 fixture 的所有连接与监听。 */
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("superResolve unified relay", () => {
  it("保留 scale=4/路由/认证/二进制请求和 PNG Buffer，明确禁 redirect", async () => {
    const input = await image();
    const output = await image(8, 8);
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://worker.invalid:4400");
    vi.stubEnv("SUPER_RESOLUTION_WORKER_SECRET", "test-only-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      reply(output)
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await superResolve(input)).toEqual(output);
    expect(SUPER_RESOLUTION_SCALE).toBe(4);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://worker.invalid:4400/v1/super-resolution");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(input.length),
        "x-super-resolution-secret": "test-only-secret",
      },
    });
    expect(init?.body).toEqual(new Uint8Array(input));
    expect((await sharp(output).metadata()).hasAlpha).toBe(true);
  });

  it("未配置 URL 时保留 3310 回环默认入口", async () => {
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "");
    const output = await image(8, 8);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      reply(output)
    );
    vi.stubGlobal("fetch", fetchMock);
    await superResolve(await image());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:3310/v1/super-resolution"
    );
  });

  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("%s 输入原字节发送，返回精确4x PNG metadata", async (format) => {
    const input = await image(3, 2, format);
    const output = await image(12, 8);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      reply(output)
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await superResolve(input);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(new Uint8Array(input));
    expect(await sharp(result).metadata()).toMatchObject({
      format: "png",
      width: 12,
      height: 8,
      hasAlpha: true,
    });
  });

  it("真实跨 origin 307 不将共享认证或有效图片转发给第二 origin", async () => {
    const input = await image();
    const output = await image(8, 8);
    let forwarded = 0;
    const target = createServer((request, response) => {
      forwarded++;
      request.resume();
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": output.length,
      });
      response.end(output);
    });
    const targetUrl = await listen(target);
    const source = createServer((request, response) => {
      request.resume();
      response.writeHead(307, { location: `${targetUrl}/leak` });
      response.end();
    });
    const sourceUrl = await listen(source);
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", sourceUrl);
    vi.stubEnv("SUPER_RESOLUTION_WORKER_SECRET", "fixture-secret");
    try {
      const outcome = await superResolve(input).then(
        () => "accepted",
        () => "rejected"
      );
      expect({ outcome, forwarded }).toEqual({
        outcome: "rejected",
        forwarded: 0,
      });
    } finally {
      await close(source);
      await close(target);
    }
  });

  it("非 loopback 无密钥与特性关闭在 fetch 前拒绝有效图片", async () => {
    const input = await image();
    const output = await image(8, 8);
    const fetchMock = vi.fn(async () => reply(output));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://worker.invalid:3310");
    await expect(superResolve(input)).rejects.toMatchObject({
      code: "configuration",
    });
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://127.0.0.1:3310");
    vi.stubEnv("INFERENCE_WORKER_ENABLED", "false");
    await expect(superResolve(input)).rejects.toMatchObject({
      code: "disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP错误只暴露固定code，不读取/透传 worker 私有正文", async () => {
    const response = new Response("fixture-private /fixture/model.onnx", {
      status: 503,
    });
    const text = vi.spyOn(response, "text");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    );
    await expect(superResolve(await image())).rejects.toMatchObject({
      code: "http_503",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("拒绝空响应、非PNG、错误4x尺寸，保留正常PNG契约", async () => {
    const input = await image();
    const wrongSize = await image(2, 2);
    for (const response of [
      new Response(null, { headers: { "content-type": "image/png" } }),
      new Response("not png", { headers: { "content-type": "text/plain" } }),
      reply(wrongSize),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response)
      );
      const outcome = await superResolve(input).then(
        () => "accepted",
        () => "rejected"
      );
      expect(outcome).toBe("rejected");
    }
  });

  it("声明超64MiB在读取前拒绝，chunked实际超界也取消读取", async () => {
    const input = await image();
    const output = await image(8, 8);
    const oversized = new Response(new Uint8Array(output), {
      headers: {
        "content-type": "image/png",
        "content-length": String(MAX_OUTPUT_BYTES + 1),
      },
    });
    const arrayBuffer = vi.spyOn(oversized, "arrayBuffer");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oversized)
    );
    const declared = await superResolve(input).then(
      () => "accepted",
      (error: unknown) => (error as { code?: string }).code
    );
    expect(declared).toBe("invalid_output");
    expect(arrayBuffer).not.toHaveBeenCalled();
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn();
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (count++ < 66) controller.enqueue(chunk);
                else controller.close();
              },
              cancel,
            }),
            { headers: { "content-type": "image/png" } }
          )
      )
    );
    const streamed = await superResolve(input).then(
      () => "accepted",
      (error: unknown) => (error as { code?: string }).code
    );
    expect(streamed).toBe("output_limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("SR/matte/restoration共用四槽；第五项立即busy，取消后槽可复用", async () => {
    const input = await image();
    const output = await image(8, 8);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          releases.push(() => resolve(reply(output)));
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("fixture abort")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = [
      superResolve(input, options),
      removeBackground(input, options),
      invokeInferenceWorker("restoration", input, options),
      superResolve(input, options),
    ].map((promise) => promise.catch((error: unknown) => error));
    let fifth: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      fifth = superResolve(input, options).catch((error: unknown) => error);
      const observed = await Promise.race([
        fifth,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "still_waiting" }), 25)
        ),
      ]);
      expect(observed).toMatchObject({ code: "busy" });
    } finally {
      controller.abort();
      for (const release of releases) release();
      const results = await Promise.all(pending);
      if (fifth) await fifth;
      for (const error of results)
        expect(error).toMatchObject({ code: "cancelled" });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(output))
    );
    expect(await superResolve(input)).toEqual(output);
  });

  it("预先取消不发送，SR超时也使用统一错误和期限", async () => {
    const input = await image();
    const output = await image(8, 8);
    const fetchMock = vi.fn(async () => reply(output));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const outcome = await superResolve(input, {
      signal: controller.signal,
    }).then(
      () => "accepted",
      () => "rejected"
    );
    expect(outcome).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("SUPER_RESOLUTION_WORKER_TIMEOUT_MS", "20");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("fixture timeout")),
              { once: true }
            );
          })
      )
    );
    await expect(superResolve(input)).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
