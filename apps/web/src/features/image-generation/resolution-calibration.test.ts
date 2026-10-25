import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../worker/inference-protocol.mjs";
import { superResolve } from "./super-resolution";

vi.mock("./super-resolution", () => ({
  superResolve: vi.fn(async (image: Buffer) => {
    const metadata = await sharp(image).metadata();
    return sharp(image)
      .resize((metadata.width ?? 1) * 4, (metadata.height ?? 1) * 4)
      .png()
      .toBuffer();
  }),
}));

import {
  calibrateImageResolution,
  getResolutionCalibrationMode,
  shouldSuperResolve,
} from "./resolution-calibration";

describe("shouldSuperResolve（超分触发阈值：实际较长边 < 目标 2/3）", () => {
  it("实际明显偏小（1024 目标，512 实际）→ 触发", () => {
    expect(
      shouldSuperResolve(
        { width: 512, height: 512 },
        { width: 1024, height: 1024 }
      )
    ).toBe(true);
  });

  it("恰好等于 2/3 → 不触发（严格小于）", () => {
    // 2/3 × 1536 = 1024
    expect(
      shouldSuperResolve(
        { width: 1024, height: 1024 },
        { width: 1536, height: 1536 }
      )
    ).toBe(false);
  });

  it("略低于 2/3 → 触发", () => {
    expect(
      shouldSuperResolve(
        { width: 1000, height: 1000 },
        { width: 1536, height: 1536 }
      )
    ).toBe(true);
  });

  it("尺寸达标（实际≥目标）→ 不触发", () => {
    expect(
      shouldSuperResolve(
        { width: 1024, height: 1024 },
        { width: 1024, height: 1024 }
      )
    ).toBe(false);
  });

  it("按较长边判定：1024 目标、长边 768 的非方图 → 不触发（768 > 683）", () => {
    expect(
      shouldSuperResolve(
        { width: 768, height: 512 },
        { width: 1024, height: 1024 }
      )
    ).toBe(false);
  });

  it("4K 目标、2000 实际（< 2731）→ 触发", () => {
    expect(
      shouldSuperResolve(
        { width: 2000, height: 2000 },
        { width: 4096, height: 4096 }
      )
    ).toBe(true);
  });

  it("缺失实际或目标 → 不触发", () => {
    expect(shouldSuperResolve(null, { width: 1024, height: 1024 })).toBe(false);
    expect(shouldSuperResolve({ width: 512, height: 512 }, null)).toBe(false);
  });

  it("零或负尺寸 → 不触发", () => {
    expect(
      shouldSuperResolve({ width: 0, height: 0 }, { width: 1024, height: 1024 })
    ).toBe(false);
  });
});

describe("getResolutionCalibrationMode", () => {
  it("uses super-resolution for a substantial shortfall", () => {
    expect(
      getResolutionCalibrationMode(
        { width: 1024, height: 1024 },
        { width: 2048, height: 2048 }
      )
    ).toBe("super-resolution");
  });

  it("uses a lightweight resize for a smaller shortfall", () => {
    expect(
      getResolutionCalibrationMode(
        { width: 1672, height: 941 },
        { width: 2048, height: 1152 }
      )
    ).toBe("resize");
  });

  it("does nothing when the requested resolution is already met", () => {
    expect(
      getResolutionCalibrationMode(
        { width: 2048, height: 1152 },
        { width: 2048, height: 1152 }
      )
    ).toBe("none");
  });
});

describe("calibrateImageResolution", () => {
  it("resizes a near-target image to the requested bounds", async () => {
    const input = await sharp({
      create: {
        width: 167,
        height: 94,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();

    const result = await calibrateImageResolution(input, "204x115");
    const metadata = await sharp(result.buffer).metadata();

    expect(result.applied).toBe(true);
    expect(metadata.width).toBe(204);
    expect(metadata.height).toBe(115);
  });

  it("reaches the target even when the 4x super-resolution result is still smaller", async () => {
    const input = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();

    const result = await calibrateImageResolution(input, "512x512");
    const metadata = await sharp(result.buffer).metadata();

    expect(result.applied).toBe(true);
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
  });
});

describe("超出 worker 超分上限的底图", () => {
  it("先等比缩到上限内再超分，最终仍达到请求尺寸", async () => {
    // 上游常见 1536x1024（约 157 万像素）超过 worker 超分输入上限 1048576 像素。
    const input = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();

    const result = await calibrateImageResolution(input, "3456x2304");

    const sent = vi.mocked(superResolve).mock.calls[0]?.[0];
    expect(sent).toBeDefined();
    const sentMetadata = await sharp(sent).metadata();
    expect(
      (sentMetadata.width ?? 0) * (sentMetadata.height ?? 0)
    ).toBeLessThanOrEqual(LIMITS["super-resolution"].maxPixels);
    expect(sentMetadata.width).toBe(1254);
    expect(sentMetadata.height).toBe(836);
    expect(result.applied).toBe(true);
    expect(await sharp(result.buffer).metadata()).toMatchObject({
      width: 3456,
      height: 2304,
      format: "png",
    });
  });

  it("恰在上限内的底图原样发送，不重新编码", async () => {
    const input = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();

    await calibrateImageResolution(input, "2048x2048");

    expect(vi.mocked(superResolve).mock.calls[0]?.[0]).toBe(input);
  });
});

// 仅清理调用计数；一次性故障/取消替身由对应测试消费，不改动默认小图4x替身。
afterEach(() => {
  vi.mocked(superResolve).mockClear();
});

/** 小图 fixture：SR 替身返回 PNG，校准必须按原图格式重新编码。 */
async function calibrationInput(
  format: "png" | "jpeg" | "webp",
  edge = 4
): Promise<Buffer> {
  return sharp({
    create: { width: edge, height: edge, channels: 3, background: "white" },
  })
    .toFormat(format)
    .toBuffer();
}

describe("calibration signal and format compatibility", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("SR输出PNG后仍保留%s存图格式和applied metadata", async (format) => {
    const input = await calibrationInput(format);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const result = await calibrateImageResolution(input, "24x24", options);
    expect(superResolve).toHaveBeenCalledWith(input, options);
    expect(result.applied).toBe(true);
    expect(await sharp(result.buffer).metadata()).toMatchObject({
      width: 24,
      height: 24,
      format,
    });
  });
  it("预取消覆盖SR、轻量resize、无需校准和auto分支", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = await calibrationInput("png", 8);
    for (const target of ["24x24", "10x10", "8x8", "auto"]) {
      const outcome = await calibrateImageResolution(input, target, {
        signal: controller.signal,
      }).then(
        () => "accepted",
        () => "rejected"
      );
      expect(outcome).toBe("rejected");
    }
    expect(superResolve).not.toHaveBeenCalled();
  });
  it("等待worker期间取消显式上抛，不被原图降级吞掉", async () => {
    const controller = new AbortController();
    const abort = new Error("fixture caller cancellation");
    vi.mocked(superResolve).mockImplementationOnce(async () => {
      controller.abort(abort);
      throw abort;
    });
    await expect(
      calibrateImageResolution(await calibrationInput("png"), "24x24", {
        signal: controller.signal,
      })
    ).rejects.toBe(abort);
  });
  it("worker返回时已取消也不上报applied成功", async () => {
    const controller = new AbortController();
    vi.mocked(superResolve).mockImplementationOnce(async (input: Buffer) => {
      controller.abort();
      return input;
    });
    const outcome = await calibrateImageResolution(
      await calibrationInput("png"),
      "24x24",
      { signal: controller.signal }
    ).then(
      () => "accepted",
      () => "rejected"
    );
    expect(outcome).toBe("rejected");
  });
  it("普通worker故障仍返回原图applied=false，未取消请求不改变契约", async () => {
    const input = await calibrationInput("png");
    vi.mocked(superResolve).mockRejectedValueOnce(
      new Error("图像处理服务失败 (http_503)")
    );
    expect(await calibrateImageResolution(input, "24x24", {})).toEqual({
      buffer: input,
      applied: false,
    });
  });
  it("轻量resize与无需校准保留原契约且不调用SR", async () => {
    const input = await calibrationInput("jpeg", 8);
    const options = { signal: new AbortController().signal };
    const resized = await calibrateImageResolution(input, "10x10", options);
    expect(resized.applied).toBe(true);
    expect(await sharp(resized.buffer).metadata()).toMatchObject({
      width: 10,
      height: 10,
      format: "jpeg",
    });
    expect(await calibrateImageResolution(input, "8x8", options)).toEqual({
      buffer: input,
      applied: false,
    });
    expect(superResolve).not.toHaveBeenCalled();
  });
});
