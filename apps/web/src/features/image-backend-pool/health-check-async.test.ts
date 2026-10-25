/** 测活透传池 API 异步任务模式：异步上游同样轮询任务取图，默认超时放宽到上限。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "@/features/image-generation/types";
import { checkImageBackendApiHealth } from "./health-check";

const mocks = vi.hoisted(() => ({ generateImage: vi.fn() }));
vi.mock("@/features/image-generation/service", () => ({
  generateImage: mocks.generateImage,
}));

/** 出图替身：一直挂起，直到测活超时中断。 */
function hangUntilAbort() {
  mocks.generateImage.mockImplementation(
    (_config: ApiConfig, params: { signal: AbortSignal }) =>
      new Promise((resolve) =>
        params.signal.addEventListener(
          "abort",
          () => resolve({ error: "This operation was aborted" }),
          { once: true }
        )
      )
  );
}

function lastCall() {
  const call = mocks.generateImage.mock.calls.at(-1) as
    | [ApiConfig, { signal: AbortSignal }]
    | undefined;
  if (!call) throw new Error("generateImage not called");
  return { config: call[0], signal: call[1].signal };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.generateImage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("测活与异步任务模式", () => {
  it.each([
    [true, 180_000],
    [false, 90_000],
  ])("asyncTaskMode=%s 透传到出图配置，默认 %ims 后超时", async (asyncTaskMode, timeoutMs) => {
    hangUntilAbort();
    const pending = checkImageBackendApiHealth({
      baseUrl: "https://upstream.example.test/v1",
      apiKey: "test-key",
      asyncTaskMode,
    });

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    const { config, signal } = lastCall();
    expect(config.backend?.asyncTaskMode).toBe(asyncTaskMode);
    expect(config.backend?.reportResult).toBe(false);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
});
