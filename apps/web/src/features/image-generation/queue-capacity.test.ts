/** 队列默认预算回归：读取真实套餐上传/并发配置，使用 MiB 级实际输入而非小字节替身。 */
import { getPlanLimits } from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: vi.fn(async () => undefined),
  getRuntimeSettingNumber: vi.fn(
    async (_name: string, fallback: number) => fallback
  ),
}));

let queue: typeof import("./queue");
const owner = { userId: "capacity-user", apiKeyId: "capacity-key" };
const MiB = 1024 * 1024;

beforeEach(async () => {
  vi.resetModules();
  queue = await import("./queue");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("image queue default capacity", () => {
  it.each([
    ["free", 4, "buffer"],
    ["free", 4, "base64"],
    ["free", 5, "buffer"],
    ["free", 5, "base64"],
    ["starter", 16, "buffer"],
    ["starter", 16, "base64"],
  ] as const)("accepts a normal %s %sMiB %s image using real upload limits", async (plan, sizeMiB, encoding) => {
    const limits = await getPlanUploadLimits(plan);
    const size = sizeMiB * MiB;
    expect(size).toBeLessThanOrEqual(limits.maxFileSizeBytes);
    if (plan === "free") expect(limits.maxFileSizeBytes).toBe(5 * MiB);
    const data = Buffer.alloc(size);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    const input = {
      images: [
        {
          filename: "image.png",
          mimeType: "image/png",
          data:
            encoding === "buffer"
              ? data
              : `data:image/png;base64,${data.toString("base64")}`,
        },
      ],
    };
    const estimatedBytes = queue.estimateImageGenerationQueueBytes(input);
    // 二进制和编码字符串都必须按实际字节参与准入，不能靠缩小估算值让测试通过。
    expect(estimatedBytes).toBeGreaterThanOrEqual(2 * size);
    const reservation = queue.reserveImageGenerationQueue({
      ...owner,
      estimatedBytes,
    });
    expect(reservation.release()).toBe(true);
  });

  it("allows the real Enterprise concurrency without count-based downgrade", async () => {
    const limits = await getPlanLimits("enterprise");
    expect(limits.imageGenerationConcurrency).toBe(100);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return "done";
    });
    const estimatedBytes = queue.estimateImageGenerationQueueBytes({
      prompt: "draw a square",
    });
    const pending = Array.from(
      { length: limits.imageGenerationConcurrency },
      () =>
        queue.withImageGenerationQueue(
          {
            ...owner,
            priority: limits.queuePriority,
            userConcurrency: limits.imageGenerationConcurrency,
            estimatedBytes,
          },
          execute
        )
    );
    const settled = Promise.allSettled(pending);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(100), {
        interval: 1,
        timeout: 200,
      });
    } finally {
      release();
    }
    expect(
      (await settled).every((result) => result.status === "fulfilled")
    ).toBe(true);
  });

  it("returns a non-retryable 413 when the request alone cannot fit", () => {
    let error: unknown;
    try {
      queue.reserveImageGenerationQueue({
        ...owner,
        estimatedBytes: 200 * MiB,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 413,
      code: "image_generation_input_too_large",
    });
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("减少总附件大小")
    );
    const next = queue.reserveImageGenerationQueue({
      ...owner,
      estimatedBytes: MiB,
    });
    expect(next.release()).toBe(true);
  });

  it("returns 429 for cumulative occupancy and admits the same input once released", () => {
    const first = queue.reserveImageGenerationQueue({
      ...owner,
      estimatedBytes: 40 * MiB,
    });
    let error: unknown;
    try {
      queue.reserveImageGenerationQueue({ ...owner, estimatedBytes: 40 * MiB });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 429,
      code: "image_generation_queue_busy",
    });
    // 用户预算满不影响另一用户在剩余全局预算内准入。
    const other = queue.reserveImageGenerationQueue({
      userId: "other",
      apiKeyId: "other-key",
      estimatedBytes: 40 * MiB,
    });
    expect(other.release()).toBe(true);
    first.release();
    const retry = queue.reserveImageGenerationQueue({
      ...owner,
      estimatedBytes: 40 * MiB,
    });
    expect(retry.release()).toBe(true);
  });

  it("rejects an async batch that cannot fit by itself with 413 and no leaked reservations", () => {
    expect(() =>
      queue.reserveAsyncImageGenerationQueueBatch({
        ...owner,
        count: 2,
        estimatedBytes: 40 * MiB,
      })
    ).toThrow(queue.ImageGenerationQueueInputTooLargeError);
    const next = queue.reserveImageGenerationQueue({
      ...owner,
      estimatedBytes: 40 * MiB,
    });
    expect(next.release()).toBe(true);
  });

  it.each([
    "IMAGE_GENERATION_QUEUE_MAX_BYTES",
    "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_USER",
    "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_KEY",
    "IMAGE_GENERATION_QUEUE_MAX_REQUEST_BYTES",
  ])("returns 413 when %s is too small even in an empty queue", (name) => {
    vi.stubEnv(name, "1024");
    let error: unknown;
    try {
      queue.reserveImageGenerationQueue({ ...owner, estimatedBytes: 2048 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 413,
      code: "image_generation_input_too_large",
    });
  });
});
