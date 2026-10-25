/** 图片导入的流量上限、取消和来源边界；只替换浏览器解码，不访问网络。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCanvasImage } from "./image-import";
import { MAX_CANVAS_IMAGE_BYTES } from "./scene-tools";

const url = "/api/storage/generations/u/image.png";
afterEach(() => vi.unstubAllGlobals());

describe("画布图片导入", () => {
  it("拒绝第三方地址且不发请求", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchCanvasImage(
        "https://third.example/a.png",
        new AbortController().signal
      )
    ).rejects.toThrow("只能导入本站图片");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("已取消时不发新请求", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchCanvasImage(url, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("声明超限时不读取正文", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            "content-type": "image/png",
            "content-length": String(MAX_CANVAS_IMAGE_BYTES + 1),
          },
        })
      )
    );
    await expect(
      fetchCanvasImage(url, new AbortController().signal)
    ).rejects.toThrow("16 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("流实际超限时取消剩余传输，不等待整个响应", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CANVAS_IMAGE_BYTES + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: { "content-type": "image/png" } })
        )
    );
    await expect(
      fetchCanvasImage(url, new AbortController().signal)
    ).rejects.toThrow("16 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("拒绝 HTML，释放响应，不当作图片解码", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "text/html" },
        })
      )
    );
    await expect(
      fetchCanvasImage(url, new AbortController().signal)
    ).rejects.toThrow("只支持");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("本站请求保留同源Cookie，禁止重定向，成功后释放解码内存", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 640, height: 480, close })
    );
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.result = "data:image/png;base64,fixture";
          this.onload?.();
        }
      }
    );
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "image/png" },
      })
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchCanvasImage(url, new AbortController().signal);
    expect(result).toMatchObject({
      width: 480,
      height: 360,
      mimeType: "image/png",
    });
    expect(fetcher).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ credentials: "same-origin", redirect: "error" })
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
