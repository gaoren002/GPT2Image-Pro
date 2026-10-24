/** 异步任务内存态回归：隔离回调网络，验证容量、字节预算与完成后过期。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  },
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => 1),
}));

import { fetchWithDnsPin } from "@repo/shared/security/dns-pin";
import {
  completeAsyncImageTask,
  createAsyncEditableFileTask,
  createAsyncImageTask,
  type GenerationTaskRow,
  postAsyncImageCallback,
  toAsyncImageTaskResponse,
  toGenerationImageTaskResponse,
  validateCallbackUrl,
} from "./async-image-tasks";

const mockFetchWithDnsPin = vi.mocked(fetchWithDnsPin);

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockFetchWithDnsPin.mockReset();
});

describe("bounded async task retention", () => {
  let tasks: typeof import("./async-image-tasks");

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES", "4096");
    vi.resetModules();
    tasks = await import("./async-image-tasks");
  });

  it("rejects at global capacity including editable tasks and frees expired slots", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "2");
    vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_TTL_MS", "1000");
    const first = tasks.createAsyncImageTask({ userId: "a" });
    tasks.createAsyncEditableFileTask({ userId: "b", kind: "ppt" });
    expect(() => tasks.createAsyncImageTask({ userId: "c" })).toThrow(
      /async image task capacity exceeded/i
    );
    tasks.completeAsyncImageTask(first.id, { result: { data: [] } });
    vi.advanceTimersByTime(1000);
    expect(tasks.getAsyncImageTask(first.id)).toBeUndefined();
    expect(tasks.createAsyncImageTask({ userId: "c" }).status).toBe(
      "processing"
    );
  });

  it("applies user and key caps without displacing another user's result", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT_PER_USER", "2");
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT_PER_KEY", "1");
    const first = tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k1" });
    tasks.completeAsyncImageTask(first.id, {
      result: { data: [{ b64_json: "abc" }] },
    });
    expect(() =>
      tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k1" })
    ).toThrow();
    tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k2" });
    expect(() =>
      tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k3" })
    ).toThrow();
    expect(
      tasks.createAsyncImageTask({ userId: "b", apiKeyId: "k1" }).status
    ).toBe("processing");
    expect(tasks.getAsyncImageTask(first.id)).toMatchObject({
      status: "completed",
      data: [{ b64_json: "abc" }],
    });
  });

  it("retains long queued/processing tasks and delivers a late callback before starting TTL", async () => {
    const first = tasks.createAsyncImageTask({ userId: "a" });
    vi.advanceTimersByTime(61 * 60_000);
    expect(tasks.getAsyncImageTask(first.id)?.status).toBe("processing");
    const completed = tasks.completeAsyncImageTask(first.id, {
      result: { data: [{ b64_json: "original-base64" }] },
    });
    expect(completed).toMatchObject({
      status: "completed",
      data: [{ b64_json: "original-base64" }],
    });
    mockFetchWithDnsPin.mockResolvedValueOnce(new Response("ok"));
    if (!completed) throw new Error("missing late completion");
    await tasks.postAsyncImageCallback(
      "https://example.com/callback",
      completed
    );
    expect(mockFetchWithDnsPin).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(tasks.getAsyncImageTask(first.id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(tasks.getAsyncImageTask(first.id)).toBeUndefined();
  });

  it("survives more than 30 minutes in the actual queue and completes after its blocker releases", async () => {
    const queue = await import("../image-generation/queue");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = queue.withImageGenerationQueue(
      { userId: "blocker", priority: "normal", userConcurrency: 1 },
      () => gate
    );
    await vi.advanceTimersByTimeAsync(0);
    const task = tasks.createAsyncImageTask({ userId: "a" });
    const waiting = queue.withImageGenerationQueue(
      {
        userId: "a",
        priority: "normal",
        userConcurrency: 1,
        timeoutMs: 90 * 60_000,
      },
      async () =>
        tasks.completeAsyncImageTask(task.id, {
          result: { data: [{ b64_json: "late" }] },
        })
    );
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(tasks.getAsyncImageTask(task.id)?.status).toBe("processing");
    release();
    await blocker;
    await expect(waiting).resolves.toMatchObject({
      status: "completed",
      data: [{ b64_json: "late" }],
    });
  });

  it("preserves a paid result even when it exceeds reservation and blocks new admission instead", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES", "4096");
    const task = tasks.createAsyncImageTask({ userId: "a" });
    const completed = tasks.completeAsyncImageTask(task.id, {
      result: { data: [{ b64_json: "x".repeat(8192) }] },
    });
    expect(completed).toMatchObject({
      status: "completed",
      data: [{ b64_json: "x".repeat(8192) }],
    });
    expect(tasks.getAsyncImageTask(task.id)).toBe(completed);
    expect(() => tasks.createAsyncImageTask({ userId: "b" })).toThrow(
      /capacity exceeded/i
    );
    expect(completed).not.toHaveProperty("image_url");
  });

  it.each([
    ["ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES", "b", "k2"],
    ["ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER", "a", "k2"],
    ["ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY", "a", "k1"],
  ])("enforces %s and releases result bytes on expiry", (env, userId, apiKeyId) => {
    vi.stubEnv(env, "4096");
    vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_TTL_MS", "1000");
    const result = { data: [{ b64_json: "x".repeat(2400) }] };
    const first = tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k1" });
    expect(tasks.completeAsyncImageTask(first.id, { result })?.status).toBe(
      "completed"
    );
    expect(() => tasks.createAsyncImageTask({ userId, apiKeyId })).toThrow(
      /capacity exceeded/i
    );
    expect(tasks.getAsyncImageTask(first.id)?.status).toBe("completed");
    vi.advanceTimersByTime(1000);
    const third = tasks.createAsyncImageTask({ userId, apiKeyId });
    expect(tasks.completeAsyncImageTask(third.id, { result })?.status).toBe(
      "completed"
    );
  });

  it("reserves complete result budgets before work so two concurrent completions remain deliverable", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES", "8192");
    const first = tasks.createAsyncImageTask({ userId: "a" });
    const second = tasks.createAsyncImageTask({ userId: "b" });
    expect(() => tasks.createAsyncImageTask({ userId: "c" })).toThrow(
      /capacity exceeded/i
    );
    const result = {
      data: [{ b64_json: "x".repeat(3000) }],
      credits_consumed: 1,
    };
    expect(tasks.completeAsyncImageTask(first.id, { result })).toMatchObject({
      status: "completed",
      ...result,
    });
    expect(tasks.completeAsyncImageTask(second.id, { result })).toMatchObject({
      status: "completed",
      ...result,
    });
  });

  it("makes duplicate completion idempotent and preserves task ownership", () => {
    const task = tasks.createAsyncImageTask({ userId: "a", apiKeyId: "k1" });
    const completed = tasks.completeAsyncImageTask(task.id, {
      result: {
        id: "replacement",
        userId: "b",
        apiKeyId: "k2",
        data: [{ b64_json: "abc" }],
      },
    });
    expect(completed).toMatchObject({
      id: task.id,
      userId: "a",
      apiKeyId: "k1",
    });
    expect(
      tasks.completeAsyncImageTask(task.id, { error: "late failure" })
    ).toBe(completed);
  });

  it("keeps valid multibyte results and drops only unserializable results", () => {
    const task = tasks.createAsyncImageTask({ userId: "a" });
    expect(
      tasks.completeAsyncImageTask(task.id, {
        result: { text: "图".repeat(700) },
      })
    ).toMatchObject({ status: "completed", text: "图".repeat(700) });
    const other = tasks.createAsyncEditableFileTask({
      userId: "b",
      kind: "psd",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      tasks.completeAsyncImageTask(other.id, {
        completedObject: "editable_file_task",
        result: cyclic,
      })
    ).toMatchObject({
      object: "editable_file_task",
      status: "failed",
      error: { status: 413 },
    });
  });

  it("reserves a result budget for each image in a batch before accepting work", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES", "8192");
    expect(() =>
      tasks.createAsyncImageTask({
        userId: "a",
        generationIds: ["g1", "g2", "g3"],
      })
    ).toThrow(/capacity exceeded/i);
    const first = tasks.createAsyncImageTask({ userId: "a" });
    const second = tasks.createAsyncImageTask({ userId: "b" });
    expect(() => tasks.createAsyncImageTask({ userId: "c" })).toThrow(
      /capacity exceeded/i
    );
    expect(
      tasks.completeAsyncImageTask(first.id, {
        result: { data: [{ b64_json: "x".repeat(3000) }] },
      })
    ).toMatchObject({
      status: "completed",
      data: [{ b64_json: "x".repeat(3000) }],
    });
    expect(tasks.getAsyncImageTask(second.id)?.status).toBe("processing");
  });

  it("does not let duplicate completion or polling extend terminal expiry", () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_TTL_MS", "1000");
    const task = tasks.createAsyncImageTask({ userId: "a" });
    tasks.completeAsyncImageTask(task.id, {
      error: { error: { message: "upstream failed" } },
    });
    vi.advanceTimersByTime(999);
    expect(tasks.getAsyncImageTask(task.id)?.status).toBe("failed");
    tasks.completeAsyncImageTask(task.id, { result: { data: [] } });
    vi.advanceTimersByTime(1);
    expect(tasks.getAsyncImageTask(task.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("external async image tasks", () => {
  beforeEach(() => {
    vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES", "4096");
  });
  it("creates a public processing payload without owner fields", () => {
    const task = createAsyncImageTask({
      userId: "user_1",
      apiKeyId: "key_1",
      model: "gpt-image-2",
      generationIds: ["gen_1"],
    });

    expect(toAsyncImageTaskResponse(task)).toMatchObject({
      id: expect.stringMatching(/^task_/),
      object: "image.generation",
      model: "gpt-image-2",
      status: "processing",
      generation_id: "gen_1",
      generationId: "gen_1",
    });
    expect(toAsyncImageTaskResponse(task)).not.toHaveProperty("userId");
    expect(toAsyncImageTaskResponse(task)).not.toHaveProperty("apiKeyId");
  });

  it("flattens completed image payload fields onto the task", () => {
    const task = createAsyncImageTask({
      userId: "user_1",
      model: "gpt-image-2",
      generationIds: ["gen_1", "gen_2"],
    });

    const completed = completeAsyncImageTask(task.id, {
      result: {
        created: 123,
        data: [{ url: "https://cdn.example.com/image.png" }],
        credits_consumed: 1.2,
      },
    });

    expect(completed && toAsyncImageTaskResponse(completed)).toMatchObject({
      id: task.id,
      object: "image",
      status: "completed",
      created: 123,
      data: [{ url: "https://cdn.example.com/image.png" }],
      credits_consumed: 1.2,
      generation_ids: ["gen_1", "gen_2"],
    });
  });

  it("creates + completes an editable file task keeping object=editable_file_task", () => {
    const task = createAsyncEditableFileTask({
      userId: "user_1",
      apiKeyId: "key_1",
      kind: "ppt",
      clientTaskId: "ct_1",
    });
    expect(task).toMatchObject({
      object: "editable_file_task",
      status: "processing",
      kind: "ppt",
      client_task_id: "ct_1",
    });
    expect(task.id.startsWith("task_")).toBe(true);

    const completed = completeAsyncImageTask(task.id, {
      completedObject: "editable_file_task",
      result: {
        kind: "ppt",
        result: { primary_url: "/api/storage/x.pptx", zip_url: null },
        credits_charged: 25,
      },
    });
    const publicTask = completed && toAsyncImageTaskResponse(completed);
    expect(publicTask).toMatchObject({
      id: task.id,
      // 完成后仍是 editable_file_task(不被误标成 image)
      object: "editable_file_task",
      status: "completed",
      kind: "ppt",
      result: { primary_url: "/api/storage/x.pptx", zip_url: null },
      credits_charged: 25,
    });
    // 归属字段被剥离,不外泄
    expect(publicTask && "userId" in publicTask).toBe(false);
    expect(publicTask && "apiKeyId" in publicTask).toBe(false);
  });

  it("maps a completed generation row to a task response with url + image_url", () => {
    const row: GenerationTaskRow = {
      id: "gen_abc",
      model: "gpt-image-2",
      status: "completed",
      revisedPrompt: "a cat",
      creditsConsumed: "3.15",
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      completedAt: new Date("2026-06-22T00:01:00Z"),
    };
    const res = toGenerationImageTaskResponse(
      row,
      "/api/storage/generations/k?sig=x"
    );
    expect(res).toMatchObject({
      id: "gen_abc",
      object: "image",
      status: "completed",
      generation_id: "gen_abc",
      generationId: "gen_abc",
      image_url: "/api/storage/generations/k?sig=x",
      data: [
        { url: "/api/storage/generations/k?sig=x", revised_prompt: "a cat" },
      ],
      credits_consumed: 3.15, // numeric 字符串转 number
      completed_at: "2026-06-22T00:01:00.000Z",
    });
  });

  it("maps pending/failed generations without leaking a url", () => {
    const base: GenerationTaskRow = {
      id: "gen_p",
      model: "gpt-image-2",
      status: "pending",
      revisedPrompt: null,
      creditsConsumed: null,
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      completedAt: null,
    };
    const pending = toGenerationImageTaskResponse(base, null);
    expect(pending).toMatchObject({
      status: "processing",
      object: "image.generation",
    });
    expect(pending).not.toHaveProperty("data");
    expect(pending).not.toHaveProperty("image_url");

    const failed = toGenerationImageTaskResponse(
      { ...base, id: "gen_f", status: "failed", error: "boom" },
      null
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: "boom" },
    });
    expect(failed).not.toHaveProperty("data");
  });

  it("rejects private callback URLs", async () => {
    await expect(
      validateCallbackUrl("https://127.0.0.1/callback")
    ).rejects.toThrow("publicly reachable");
  });

  it("rejects http callback URLs to keep results off plaintext", async () => {
    await expect(
      validateCallbackUrl("http://example.com/callback")
    ).rejects.toThrow("https");
  });

  it("posts callback payloads with the callback marker header", async () => {
    mockFetchWithDnsPin.mockResolvedValueOnce(new Response("ok"));
    const task = createAsyncImageTask({ userId: "user_1" });

    await postAsyncImageCallback("https://example.com/callback", task);

    expect(mockFetchWithDnsPin).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/callback"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Tokens-Callback": "true",
        }),
      })
    );
  });

  it("does not follow a callback redirect into a private address", async () => {
    mockFetchWithDnsPin.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    );
    const task = createAsyncImageTask({ userId: "user_1" });

    await postAsyncImageCallback("https://example.com/callback", task);

    expect(mockFetchWithDnsPin).toHaveBeenCalledTimes(1);
  });
});
