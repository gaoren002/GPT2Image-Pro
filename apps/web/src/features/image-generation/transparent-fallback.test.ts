import { afterEach, describe, expect, it, vi } from "vitest";
import { removeBackground } from "../psd-export/matte";
import {
  applyTransparentMatte,
  isTransparentUnsupportedError,
} from "./transparent-fallback";

describe("isTransparentUnsupportedError", () => {
  it("匹配后端'透明不支持'错误", () => {
    expect(
      isTransparentUnsupportedError(
        new Error(
          "Upstream Responses API returned HTTP 400: Transparent background is not supported for this model. | invalid_value"
        )
      )
    ).toBe(true);
    expect(
      isTransparentUnsupportedError("transparent background is not supported")
    ).toBe(true);
  });

  it("不匹配其他错误", () => {
    expect(isTransparentUnsupportedError(new Error("rate limit reached"))).toBe(
      false
    );
    expect(isTransparentUnsupportedError(null)).toBe(false);
    expect(isTransparentUnsupportedError(undefined)).toBe(false);
  });
});

vi.mock("../psd-export/matte", () => ({
  removeBackground: vi.fn(async () => Buffer.from("transparent")),
}));
afterEach(() => {
  vi.mocked(removeBackground).mockClear();
});

describe("applyTransparentMatte worker adapter", () => {
  it("legacy 首图与输出数组重叠只调用一次；不改写输入，不持久化内容", async () => {
    const input = {
      imageBase64: "aW1n",
      imageOutputs: [{ imageBase64: "aW1n", index: 0 }],
    };
    const next = await applyTransparentMatte(input);
    expect(removeBackground).toHaveBeenCalledOnce();
    expect(next.imageBase64).toBe(
      Buffer.from("transparent").toString("base64")
    );
    expect(next.imageOutputs?.[0]?.imageBase64).toBe(next.imageBase64);
    expect(input.imageBase64).toBe("aW1n");
  });
  it("逐张有界处理，signal 传入共用 ISNet relay", async () => {
    const controller = new AbortController();
    const result = await applyTransparentMatte(
      { imageOutputs: [{ imageBase64: "aW1n" }, { imageBase64: "YWJj" }] },
      { signal: controller.signal }
    );
    expect(result.imageOutputs).toHaveLength(2);
    expect(removeBackground).toHaveBeenNthCalledWith(1, Buffer.from("img"), {
      signal: controller.signal,
    });
    expect(removeBackground).toHaveBeenNthCalledWith(2, Buffer.from("abc"), {
      signal: controller.signal,
    });
  });
  it("非法/超多输出在 worker 前拒绝", async () => {
    await expect(
      applyTransparentMatte({ imageBase64: "!invalid!" })
    ).rejects.toMatchObject({ code: "input_base64" });
    await expect(
      applyTransparentMatte({
        imageOutputs: Array.from({ length: 5 }, () => ({
          imageBase64: "aW1n",
        })),
      })
    ).rejects.toMatchObject({ code: "output_count" });
    expect(removeBackground).not.toHaveBeenCalled();
  });
  it("data URI 解码，worker 故障上抛，取消不继续抠图", async () => {
    await applyTransparentMatte({ imageBase64: "data:image/png;base64,aW1n" });
    expect(removeBackground).toHaveBeenCalledWith(Buffer.from("img"), {});
    vi.mocked(removeBackground).mockRejectedValueOnce(
      new Error("worker unavailable")
    );
    await expect(
      applyTransparentMatte({ imageBase64: "aW1n" })
    ).rejects.toThrow("worker unavailable");
    vi.mocked(removeBackground).mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyTransparentMatte(
        { imageBase64: "aW1n" },
        { signal: controller.signal }
      )
    ).rejects.toThrow();
    expect(removeBackground).not.toHaveBeenCalled();
  });
});
