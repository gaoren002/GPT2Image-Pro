/** 生成结果下载边界：真实公网校验/逐跳逻辑，网络与存储为不外呼的替身。 */
import { generateSignedImageUrl } from "@repo/shared/storage/signed-url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getObject: vi.fn() }));
vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: mocks.fetch,
  SsrfBlockedError: class extends Error {},
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(async () => ({ getObject: mocks.getObject })),
}));

import { readGeneratedImage } from "./generated-image";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJk0AAAAASUVORK5CYII=",
  "base64"
);
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.getObject.mockReset();
  vi.stubEnv("BETTER_AUTH_SECRET", "generated-image-test-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("生成图片安全读取", () => {
  it("正确的内联图片不发网络请求", async () => {
    expect(
      await readGeneratedImage({ imageBase64: png.toString("base64") })
    ).toEqual(png);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("合法data URI输出复用大小和格式校验，不走公网HTTP", async () => {
    expect(
      await readGeneratedImage({
        imageUrl: `data:image/png;base64,${png.toString("base64")}`,
      })
    ).toEqual(png);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("内联正文在分配解码Buffer前检查大小，拒绝非图片", async () => {
    await expect(
      readGeneratedImage(
        { imageBase64: png.toString("base64") },
        { maxBytes: 1 }
      )
    ).rejects.toThrow(/oversized/);
    await expect(
      readGeneratedImage({
        imageBase64: Buffer.from("secret text").toString("base64"),
      })
    ).rejects.toThrow(/not a supported image/);
  });

  it.each([
    "http://127.0.0.1/internal",
    "http://169.254.169.254/latest/meta-data",
    "http://[fd00::1]/private",
  ])("在实际外呼前阻止内网: %s", async (imageUrl) => {
    await expect(readGeneratedImage({ imageUrl })).rejects.toThrow(
      /publicly reachable/
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("公网地址跳转到内网也被阻止，废弃响应已取消", async () => {
    let cancelled = false;
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: "http://127.0.0.1/private" } }
      )
    );
    await expect(
      readGeneratedImage({ imageUrl: "https://1.1.1.1/output" })
    ).rejects.toThrow(/publicly reachable/);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("响应逐块超限即取消，连接层同样接收字节上限", async () => {
    let cancelled = false;
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(40));
            controller.enqueue(new Uint8Array(40));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
    );
    await expect(
      readGeneratedImage(
        { imageUrl: "https://1.1.1.1/output" },
        { maxBytes: 64 }
      )
    ).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://1.1.1.1/output",
      expect.objectContaining({ maxBytes: 64, signal: expect.any(AbortSignal) })
    );
  });

  it("HTTP成功但返回非图片的正文不能进入存储", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("internal metadata"));
    await expect(
      readGeneratedImage({ imageUrl: "https://1.1.1.1/output" })
    ).rejects.toThrow(/not a supported image/);
  });

  it("有效签名私有对象可以直读，取消信号传给存储", async () => {
    mocks.getObject.mockResolvedValueOnce(png);
    const imageUrl = generateSignedImageUrl("generations", "owner/image.png");
    expect(await readGeneratedImage({ imageUrl })).toEqual(png);
    expect(mocks.getObject).toHaveBeenCalledWith(
      "owner/image.png",
      "generations",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("已取消请求不会启动下载或读取存储", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readGeneratedImage(
        { imageUrl: "https://1.1.1.1/output" },
        { signal: controller.signal }
      )
    ).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });
});
