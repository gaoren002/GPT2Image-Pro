/** Web relay 协议回归：小图/mock HTTP，不加载任何 ONNX 模型。 */

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_BYTES } from "../../../worker/inference-protocol.mjs";
import { removeBackground } from "../psd-export/matte";
import { restoreImage } from "./image-restoration";
import { invokeInferenceWorker } from "./inference-worker";

vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn() }));
vi.mock("onnxruntime-node", () => {
  throw new Error("Web must never load ONNX");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** 生成几像素 PNG 作为 wire fixture，不验证模型质量。 */
async function png(width = 2, height = 2, alpha = true): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}
/** 以 PNG 二进制构造有限协议响应。 */
function reply(output: Buffer): Response {
  return new Response(new Uint8Array(output), {
    headers: {
      "content-type": "image/png",
      "content-length": String(output.length),
    },
  });
}

describe("inference worker relay", () => {
  it("真实 HTTP worker 同地址认证，restoration/matte 只发送字节", async () => {
    const image = await png();
    const routes: string[] = [];
    const server = createServer(async (request, response) => {
      routes.push(request.url ?? "");
      expect(request.headers["x-super-resolution-secret"]).toBe("test-secret");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(image);
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": image.length,
      });
      response.end(image);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    vi.stubEnv(
      "SUPER_RESOLUTION_WORKER_URL",
      `http://127.0.0.1:${address.port}`
    );
    vi.stubEnv("SUPER_RESOLUTION_WORKER_SECRET", "test-secret");
    try {
      expect(await restoreImage(image)).toEqual({
        buffer: image,
        applied: true,
      });
      expect(await removeBackground(image)).toEqual(image);
      expect(routes).toEqual(["/v1/restoration", "/v1/matte"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("关闭与 worker 不可用：修复返回原图，matte 显式失败", async () => {
    const image = await png();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("INFERENCE_WORKER_ENABLED", "false");
    expect(await restoreImage(image)).toEqual({
      buffer: image,
      applied: false,
    });
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("INFERENCE_WORKER_ENABLED", "true");
    fetchMock.mockRejectedValue(new Error("private-token worker-host"));
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await restoreImage(image)).toEqual({
      buffer: image,
      applied: false,
    });
  });

  it("失败响应不读取错误正文，不泄漏凭据或模型路径", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("private-token /private/model.onnx", { status: 503 })
      )
    );
    await expect(removeBackground(await png())).rejects.toThrow(
      "图像处理服务失败 (http_503)"
    );
  });

  it("非 loopback 无密钥/URL 带凭据配置拒绝，重定向被禁止", async () => {
    const image = await png();
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      reply(image)
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://worker.internal:3310");
    vi.stubEnv("SUPER_RESOLUTION_WORKER_SECRET", "");
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "configuration",
    });
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://token@127.0.0.1:3310");
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "configuration",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("SUPER_RESOLUTION_WORKER_URL", "http://127.0.0.1:3310");
    await removeBackground(image);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("输入字节、尺寸和动画上限在发送前检查", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      removeBackground(Buffer.alloc(32 * 1024 * 1024 + 1))
    ).rejects.toMatchObject({ code: "input_limit" });
    await expect(
      invokeInferenceWorker("restoration", await png(2049, 1))
    ).rejects.toMatchObject({ code: "input_dimensions" });
    await expect(removeBackground(await png(8193, 1))).rejects.toMatchObject({
      code: "input_dimensions",
    });
    const frames = Buffer.alloc(2 * 2 * 2 * 4);
    frames.fill(255, 16);
    const animated = await sharp(frames, {
      raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
    })
      .gif()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(removeBackground(animated)).rejects.toMatchObject({
      code: "input_dimensions",
    });
    await expect(
      removeBackground(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="file:///not-a-real-file"/></svg>'
        )
      )
    ).rejects.toMatchObject({ code: "input_dimensions" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("输出空/类型/尺寸/alpha 不符和伪 PNG 拒绝", async () => {
    const image = await png();
    for (const response of [
      new Response(null, { headers: { "content-type": "image/png" } }),
      new Response("not a png", { headers: { "content-type": "image/png" } }),
      new Response(new Uint8Array(image)),
      reply(await png(3, 2)),
      reply(await png(2, 2, false)),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response)
      );
      await expect(removeBackground(image)).rejects.toThrow("图像处理服务失败");
    }
  });

  it("声明或 chunked 超出输出字节界即取消读取，无巨量模型内存", async () => {
    const image = await png();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: {
              "content-type": "image/png",
              "content-length": String(MAX_OUTPUT_BYTES + 1),
            },
          })
      )
    );
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "invalid_output",
    });
    expect(cancel).toHaveBeenCalledOnce();
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const cancelChunks = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulled++;
                controller.enqueue(chunk);
              },
              cancel: cancelChunks,
            }),
            { headers: { "content-type": "image/png" } }
          )
      )
    );
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "output_limit",
    });
    expect(pulled).toBeLessThanOrEqual(66);
    expect(cancelChunks).toHaveBeenCalledOnce();
  });

  it("Web relay 四槽之外立即拒绝；取消与超时释放槽且不进行本地推理", async () => {
    const image = await png();
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("abort")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = Array.from({ length: 4 }, () =>
      removeBackground(image, { signal: controller.signal }).catch(
        (error: unknown) => error
      )
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "busy",
    });
    controller.abort();
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ code: "cancelled" });
    vi.stubEnv("SUPER_RESOLUTION_WORKER_TIMEOUT_MS", "20");
    await expect(removeBackground(image)).rejects.toMatchObject({
      code: "timeout",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(image))
    );
    expect(await removeBackground(image)).toEqual(image);
    await expect(
      restoreImage(image, { signal: controller.signal })
    ).rejects.toThrow();
  });

  it("Web adapter 源码与 worker HTTP 父进程无 ONNX import/session", () => {
    for (const file of [
      "image-restoration.ts",
      "transparent-fallback.ts",
      "inference-worker.ts",
      "../psd-export/matte.ts",
      "../../../worker/super-resolution-worker.mjs",
      "../../../worker/inference-worker-runtime.mjs",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /from\s+["']onnxruntime|import\(["']onnxruntime|InferenceSession\s*\./
      );
    }
  });
});
