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
import { IMAGE_PROMPT_MAX_CHARACTERS } from "./resolution";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJk0AAAAASUVORK5CYII=",
  "base64"
);
afterEach(() => vi.clearAllMocks());

it.each([
  false,
  true,
])("合法长提示词的多处副本不应让已生成图片交付失败（relay=%s）", (relayOnly) => {
  const prompt = "场景说明：" + "a".repeat(19_553);
  expect(() =>
    assertAsyncImageOutputs(
      { revisedPrompt: prompt },
      [
        {
          imageBase64: "x",
          revisedPrompt: prompt,
          upstreamRevisedPrompt: prompt,
        },
      ],
      relayOnly
    )
  ).not.toThrow();
});

it.each([
  "图",
  "\u0000",
  "a",
])("完整支持接口允许的 32000 字符提示词及 JSON 编码（字符 %j）", (character) => {
  const prompt = character.repeat(IMAGE_PROMPT_MAX_CHARACTERS);
  for (const relayOnly of [false, true]) {
    const outputs = Array.from({ length: relayOnly ? 4 : 64 }, () => ({
      imageUrl: "/api/storage/generations/owner/test.png",
      revisedPrompt: prompt,
      upstreamRevisedPrompt: prompt,
    }));
    expect(() =>
      assertAsyncImageOutputs({ revisedPrompt: prompt }, outputs, relayOnly)
    ).not.toThrow();
    expect(outputs[0]?.revisedPrompt).toBe(prompt);
  }
});

it.each([
  false,
  true,
])("单张异常元数据仍拒绝，不借用其他输出名额（relay=%s）", (relayOnly) => {
  expect(() =>
    assertAsyncImageOutputs(
      {},
      [{ revisedPrompt: "x".repeat(1024 * 1024) }],
      relayOnly
    )
  ).toThrow(/metadata/);
  expect(() =>
    assertAsyncImageOutputs(
      {},
      [{ imageUrl: "https://example.test/" + "a".repeat(1024 * 1024) }],
      relayOnly
    )
  ).toThrow(/metadata/);
});

it("未使用的上游提示词不计为交付内容，真正用作回退时仍限大小", () => {
  const upstreamRevisedPrompt = "a".repeat(1024 * 1024);
  expect(() =>
    assertAsyncImageOutputs(
      { revisedPrompt: upstreamRevisedPrompt },
      [{ revisedPrompt: "cat", upstreamRevisedPrompt }],
      false
    )
  ).not.toThrow();
  expect(() =>
    assertAsyncImageOutputs({}, [{ upstreamRevisedPrompt }], false)
  ).toThrow(/metadata/);
});

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

it("真实 32 MiB 上界拒绝异常大内联图片正文", async () => {
  const length = Math.ceil((32 * 1024 * 1024) / 3) * 4;
  await expect(
    prepareAsyncRelayOutput({ imageBase64: "A".repeat(length + 4) })
  ).rejects.toThrow(/oversized/);
  expect(io.put).not.toHaveBeenCalled();
});
