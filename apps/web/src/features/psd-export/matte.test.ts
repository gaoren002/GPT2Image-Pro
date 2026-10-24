/** PSD adapter 协议测试：模拟 worker 返回透明 PNG，不验证真实 ISNet 质量。 */
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeBackground } from "./matte";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("removeBackground (worker relay)", () => {
  it("PSD 入口使用同一 matte worker，保留透明 PNG 字节", async () => {
    const input = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const output = await sharp(input).ensureAlpha(0.5).png().toBuffer();
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(new Uint8Array(output), {
          headers: {
            "content-type": "image/png",
            "content-length": String(output.length),
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await removeBackground(input);
    expect(result).toEqual(output);
    expect((await sharp(result).metadata()).hasAlpha).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:3310/v1/matte"
    );
  });
  it("worker 关闭时 PSD 抠图显式失败，不返回原图冒充透明结果", async () => {
    vi.stubEnv("MATTE_WORKER_ENABLED", "false");
    await expect(removeBackground(Buffer.from("x"))).rejects.toMatchObject({
      code: "disabled",
    });
  });
});
