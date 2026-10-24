/** async 交付 helper 的真实图片读取边界；网络与存储仅使用无副作用替身。 */
import { afterEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ fetch: vi.fn(), put: vi.fn() }));
vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: io.fetch,
  SsrfBlockedError: class extends Error {},
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({ putObject: io.put }),
}));

import {
  assertAsyncImageOutputs,
  prepareAsyncRelayOutput,
} from "./async-image-delivery";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJk0AAAAASUVORK5CYII=",
  "base64"
);
afterEach(() => vi.clearAllMocks());

it("纯中转 URL 在成功结算前下载验证到内存，使用既有 data URI 协议回退", async () => {
  io.fetch.mockResolvedValueOnce(new Response(png));
  expect(
    await prepareAsyncRelayOutput({ imageUrl: "https://1.1.1.1/result.png" })
  ).toMatchObject({
    imageBase64: png.toString("base64"),
    imageUrl: `data:image/png;base64,${png.toString("base64")}`,
  });
  expect(io.put).not.toHaveBeenCalled();
  expect(io.fetch).toHaveBeenCalledWith(
    "https://1.1.1.1/result.png",
    expect.objectContaining({ maxBytes: 32 * 1024 * 1024 })
  );
});

it("真实 32 MiB 上界拒绝异常大内联正文；元数据按重复交付的 UTF-8/JSON 字节计算", async () => {
  const length = Math.ceil((32 * 1024 * 1024) / 3) * 4;
  await expect(
    prepareAsyncRelayOutput({ imageBase64: "A".repeat(length + 4) })
  ).rejects.toThrow(/oversized/);
  expect(() =>
    assertAsyncImageOutputs(
      { revisedPrompt: "图".repeat(3000) },
      Array.from({ length: 4 }, () => ({ imageBase64: "x" })),
      true
    )
  ).toThrow(/metadata/);
  expect(io.put).not.toHaveBeenCalled();
});
