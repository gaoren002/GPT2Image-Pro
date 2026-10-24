/** 外部异步入口容量回归：真实内存任务与响应编码，隔离鉴权、上游及文件上传。 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  image: vi.fn(),
  editable: vi.fn(),
  globalConcurrency: 500,
  relayOnly: true,
  getObject: vi.fn(),
  maxBatchCount: 10,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => mocks.globalConcurrency),
}));

vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: vi.fn(async () => ({
    userId: "capacity-user",
    apiKeyId: "capacity-key",
    plan: "ultra",
    relayOnly: mocks.relayOnly,
  })),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  MAX_PLAN_BATCH_COUNT: 10000,
  canUsePlanCapability: vi.fn(async () => true),
  getPlanLimits: vi.fn(async () => ({
    maxBatchCount: mocks.maxBatchCount,
    imageGenerationConcurrency: 2,
    maxEditImages: 16,
  })),
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(async () => ({ plan: "ultra" })),
}));
vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: vi.fn(async () => ({
    maxFileSizeBytes: 1024 * 1024,
    maxUploadBytes: 1024 * 1024,
  })),
}));
vi.mock("@/features/image-generation/operations", () => ({
  runImageGenerationForUser: mocks.image,
}));
vi.mock("@/features/image-generation/queries", () => ({
  getGenerationById: vi.fn(async () => null),
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(async () => ({ getObject: mocks.getObject })),
}));
vi.mock("@/features/image-generation/editable-file-operations", () => ({
  runEditableFileForUser: mocks.editable,
}));
vi.mock("@/features/image-generation/request-utils", () => ({
  DEFAULT_MAX_IMAGE_BYTES: 1024 * 1024,
  formatMegabytes: vi.fn(() => "1 MB"),
  validateImageFile: vi.fn(),
  getTotalUploadSize: vi.fn(() => 5),
  uploadModerationImages: vi.fn(async () => []),
  filesToImageInputs: vi.fn(async () => [
    {
      filename: "source.png",
      buffer: Buffer.from("image"),
      mimeType: "image/png",
    },
  ]),
  uploadTemporaryImageUrls: vi.fn(async () => undefined),
}));

type Endpoint = "generations" | "edits" | "ppt" | "psd";
let tasks: typeof import("../async-image-tasks");
let generations: typeof import("./image-generations");
let edits: typeof import("./image-edits");
let editable: typeof import("./editable-file-generations");
let queue: typeof import("../../image-generation/queue");
let poll: typeof import("./image-tasks");

/** 构造无网络的最小 async 请求，返回真实 handler 响应。 */
function send(
  endpoint: Endpoint,
  async = true,
  signal?: AbortSignal,
  n?: number
) {
  const url = `https://example.test/v1/${endpoint}`;
  if (endpoint === "edits") {
    const body = new FormData();
    body.set("prompt", "a square");
    body.set("async", String(async));
    if (n !== undefined) body.set("n", String(n));
    body.set("image", new File(["image"], "source.png", { type: "image/png" }));
    return edits.postExternalImageEdits(
      new NextRequest(url, { method: "POST", body, signal })
    );
  }
  const request = new NextRequest(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "a square",
      async,
      n,
      base64_images: ["aW1hZ2U="],
    }),
  });
  if (endpoint === "generations")
    return generations.postExternalImageGenerations(request);
  if (endpoint === "ppt") return editable.postExternalPptGenerations(request);
  return editable.postExternalPsdGenerations(request);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.globalConcurrency = 500;
  mocks.relayOnly = true;
  mocks.maxBatchCount = 10;
  for (const name of [
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES", undefined);
  mocks.getObject.mockReset();
  mocks.image.mockReset().mockResolvedValue({
    imageBase64: "aW1hZ2U=",
    generationId: "generated",
    creditsConsumed: 1,
  });
  tasks = await import("../async-image-tasks");
  generations = await import("./image-generations");
  edits = await import("./image-edits");
  editable = await import("./editable-file-generations");
  queue = await import("../../image-generation/queue");
  poll = await import("./image-tasks");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each<Endpoint>([
  "generations",
  "edits",
  "ppt",
  "psd",
])("%s async capacity", (endpoint) => {
  it("returns HTTP 429 without starting work when task capacity is full", async () => {
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "1");
    tasks.createAsyncImageTask({ userId: "other" });
    const response = await send(endpoint);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: {
        type: "rate_limit_error",
        status: 429,
        code: "async_image_task_capacity_exceeded",
      },
    });
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.editable).not.toHaveBeenCalled();
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    const proof = queue.reserveImageGenerationQueue({
      userId: "proof-no-queue-leak",
    });
    expect(proof.release()).toBe(true);
  });
});

describe.each<Endpoint>([
  "generations",
  "edits",
])("%s output contract", (endpoint) => {
  it("relay n=2 自身预留超默认 256MiB，执行前 413 并提示 Reduce n", async () => {
    const response = await send(endpoint, true, undefined, 2);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        status: 413,
        type: "invalid_request_error",
        code: "async_image_task_reservation_too_large",
        message: expect.stringContaining("Reduce n"),
      },
    });
    expect(mocks.image).not.toHaveBeenCalled();
  });

  it.each([
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
  ])("单笔预留自身超 %s 时是 413，已有任务占满数量也不应误报可重试", async (limit) => {
    vi.stubEnv(limit, String(32 * 1024 * 1024));
    tasks.createAsyncImageTask({ userId: "occupied", apiKeyId: "other-key" });
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "1");
    const response = await send(endpoint);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        code: "async_image_task_reservation_too_large",
        message: expect.stringContaining("Reduce n"),
      },
    });
    expect(mocks.image).not.toHaveBeenCalled();
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    expect(
      queue
        .reserveImageGenerationQueue({ userId: "proof-no-queue-leak" })
        .release()
    ).toBe(true);
  });

  it.each([
    false,
    true,
  ])("n 的硬批次界仅用于 relay async，async=%s 的其他路径仍按套餐准入", async (async) => {
    mocks.relayOnly = !async;
    mocks.image.mockResolvedValue({
      generationId: "saved",
      creditsConsumed: 1,
      imageUrl: "/api/storage/generations/capacity-user/result.png",
      imageBase64: "aW1hZ2U=",
    });
    const response = await send(endpoint, async, undefined, 5);
    expect(response.status).toBe(200);
    if (async) {
      const task = await response.json();
      await vi.waitFor(() =>
        expect(tasks.getAsyncImageTask(task.id)?.status).toBe("completed")
      );
    }
    expect(mocks.image).toHaveBeenCalledTimes(5);
  });

  it("默认预算可接一笔 relay，执行中第二笔 429，完成后按小结果返还预留差额", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.image.mockImplementationOnce(async () => {
      await gate;
      return {
        imageBase64: "aW1hZ2U=",
        generationId: "first",
        creditsConsumed: 1,
      };
    });
    let firstId = "";
    try {
      const first = await send(endpoint);
      expect(first.status).toBe(200);
      firstId = (await first.json()).id;
      expect(tasks.getAsyncImageTask(firstId)?.status).toBe("processing");
      const second = await send(endpoint);
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({
        error: { code: "async_image_task_capacity_exceeded" },
      });
      expect(mocks.image).toHaveBeenCalledOnce();
    } finally {
      finish();
    }
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(firstId)?.status).toBe("completed")
    );
    const third = await send(endpoint);
    expect(third.status).toBe(200);
    expect(tasks.getAsyncImageTask(firstId)).toMatchObject({
      status: "completed",
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it.each([
    1, 10,
  ])("relay async 的 n 超 4 在套餐批次上限 %s 时均先返回 413", async (maxBatchCount) => {
    mocks.maxBatchCount = maxBatchCount;
    const response = await send(endpoint, true, undefined, 5);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "async_image_batch_too_large", status: 413 },
    });
    expect(mocks.image).not.toHaveBeenCalled();
    const { uploadModerationImages } = await import(
      "@/features/image-generation/request-utils"
    );
    expect(uploadModerationImages).not.toHaveBeenCalled();
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "1");
    expect(tasks.createAsyncImageTask({ userId: "no-task-leak" }).status).toBe(
      "processing"
    );
  });

  it("普通引用结果在 TTL 内可持续接多单，数量限制仍独立生效", async () => {
    mocks.relayOnly = false;
    for (const name of [
      "ASYNC_IMAGE_TASK_MAX_COUNT_PER_USER",
      "ASYNC_IMAGE_TASK_MAX_COUNT_PER_KEY",
    ])
      vi.stubEnv(name, "32");
    mocks.image.mockResolvedValue({
      generationId: "saved",
      creditsConsumed: 1,
      imageUrl: "/api/storage/generations/capacity-user/result.png",
      imageBase64: "A".repeat(3 * 1024 * 1024),
    });
    for (let index = 0; index < 32; index += 1) {
      const response = await send(endpoint);
      expect(response.status).toBe(200);
      const task = await response.json();
      await vi.waitFor(() =>
        expect(tasks.getAsyncImageTask(task.id)?.status).toBe("completed")
      );
      expect(tasks.getAsyncImageTask(task.id)).not.toHaveProperty("data");
    }
    expect((await send(endpoint)).status).toBe(429);
    expect(mocks.image).toHaveBeenCalledTimes(32);
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("relay 单笔超配置预算时执行前 413，保留上限并释放 queue reservation", async () => {
    vi.stubEnv(
      "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
      String(32 * 1024 * 1024)
    );
    const response = await send(endpoint);
    expect(response.status).toBe(413);
    expect(mocks.image).not.toHaveBeenCalled();
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    expect(
      queue.reserveImageGenerationQueue({ userId: "proof-no-leak" }).release()
    ).toBe(true);
  });

  it("普通任务完成后不留 b64，通过真实 poll handler 重建原格式并检查归属", async () => {
    mocks.relayOnly = false;
    vi.stubEnv("BETTER_AUTH_SECRET", "handler-retention-test-secret");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJk0AAAAASUVORK5CYII=",
      "base64"
    );
    mocks.getObject.mockResolvedValue(png);
    mocks.image.mockResolvedValue({
      generationId: "saved",
      creditsConsumed: 2,
      imageBase64: png.toString("base64"),
      imageUrl: "/api/storage/generations/capacity-user/result.png",
    });
    const accepted = await send(endpoint);
    const task = await accepted.json();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(task.id)?.status).toBe("completed")
    );
    expect(JSON.stringify(tasks.getAsyncImageTask(task.id))).not.toContain(
      "b64_json"
    );
    expect(mocks.getObject).not.toHaveBeenCalled();
    const response = await poll.getExternalImageTask(
      new NextRequest(`https://example.test/v1/images/${task.id}`),
      { params: Promise.resolve({ taskId: task.id }) }
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "completed",
      data: [{ b64_json: png.toString("base64") }],
      credits_consumed: 2,
    });
    const denied = tasks.createAsyncImageTask({
      userId: "other",
      retention: "storage",
    });
    const forbidden = await poll.getExternalImageTask(
      new NextRequest(`https://example.test/v1/images/${denied.id}`),
      { params: Promise.resolve({ taskId: denied.id }) }
    );
    expect(forbidden.status).toBe(404);
    expect(mocks.getObject).toHaveBeenCalledOnce();
    expect(mocks.image.mock.calls[0]?.[0]).toMatchObject({
      asyncDelivery: true,
    });
  });
  it("returns HTTP 413 before creating a task when the input cannot fit its own byte budget", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_REQUEST_BYTES", "1024");
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "1");
    const response = await send(endpoint);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        status: 413,
        code: "image_generation_input_too_large",
        message: expect.stringContaining("减少总附件大小"),
      },
    });
    expect(mocks.image).not.toHaveBeenCalled();
    expect(
      tasks.createAsyncImageTask({ userId: "proof-no-task-leak" }).status
    ).toBe("processing");
  });
  it("rejects a caller aborted before admission without creating a task", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await send(endpoint, true, controller.signal);
    expect(response.status).toBe(499);
    expect(mocks.image).not.toHaveBeenCalled();
  });
  it("returns HTTP 429 before creating a task when queue admission is full", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    vi.stubEnv("ASYNC_IMAGE_TASK_MAX_COUNT", "1");
    const blocker = queue.reserveImageGenerationQueue({ userId: "other" });
    try {
      const response = await send(endpoint);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        error: { code: "image_generation_queue_busy" },
      });
      expect(mocks.image).not.toHaveBeenCalled();
      expect(
        tasks.createAsyncImageTask({ userId: "proof-no-task-leak" }).status
      ).toBe("processing");
    } finally {
      blocker.release();
    }
  });

  it("keeps accepted background work alive after the HTTP caller aborts", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.image.mockImplementation(
      async (input: {
        userId: string;
        apiKeyId?: string;
        signal?: AbortSignal;
      }) => {
        return await queue.withImageGenerationQueue(
          { ...input, priority: "normal", userConcurrency: 1 },
          async () => {
            await gate;
            return {
              imageBase64: "aW1hZ2U=",
              generationId: "generated",
              creditsConsumed: 1,
            };
          }
        );
      }
    );
    const controller = new AbortController();
    const response = await send(endpoint, true, controller.signal);
    expect(response.status).toBe(200);
    const body = await response.json();
    controller.abort();
    finish();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(body.id)).toMatchObject({
        status: "completed",
        data: [{ b64_json: "aW1hZ2U=" }],
      })
    );
    expect(mocks.image.mock.calls[0]?.[0].signal).toBeUndefined();
  });

  it("keeps an accepted async request queued after HTTP abort and executes it when a slot opens", async () => {
    mocks.globalConcurrency = 1;
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "2");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocker = queue.withImageGenerationQueue(
      { userId: "blocker", priority: "normal", userConcurrency: 1 },
      async () => {
        started();
        await gate;
      }
    );
    await running;
    const execute = vi.fn(async () => ({
      imageBase64: "aW1hZ2U=",
      generationId: "generated",
      creditsConsumed: 1,
    }));
    mocks.image.mockImplementation(
      async (input: {
        userId: string;
        apiKeyId?: string;
        signal?: AbortSignal;
      }) => {
        return await queue.withImageGenerationQueue(
          { ...input, priority: "normal", userConcurrency: 1 },
          execute
        );
      }
    );
    const controller = new AbortController();
    let taskId: string;
    try {
      const response = await send(endpoint, true, controller.signal);
      expect(response.status).toBe(200);
      taskId = (await response.json()).id;
      controller.abort();
      expect(execute).not.toHaveBeenCalled();
      expect(tasks.getAsyncImageTask(taskId)?.status).toBe("processing");
      expect(mocks.image.mock.calls[0]?.[0].signal).toBeUndefined();
    } finally {
      release();
      await blocker;
    }
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(taskId)).toMatchObject({
        status: "completed",
        data: [{ b64_json: "aW1hZ2U=" }],
      })
    );
    expect(execute).toHaveBeenCalledOnce();
  });
  it("keeps default b64_json and relay_only input", async () => {
    const response = await send(endpoint);
    const body = await response.json();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(body.id)?.status).toBe("completed")
    );
    expect(tasks.getAsyncImageTask(body.id)).toMatchObject({
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    expect(tasks.getAsyncImageTask(body.id)?.data).not.toEqual([
      expect.objectContaining({ url: expect.anything() }),
    ]);
    expect(mocks.image.mock.calls[0]?.[0]).toMatchObject({ relayOnly: true });
  });

  it("returns HTTP 429 for an immediate queue overload", async () => {
    mocks.image.mockResolvedValue({
      generationId: "rejected",
      error:
        "Image generation queue is busy. Capacity limit reached. Please retry shortly.",
    });
    const response = await send(endpoint, false);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "image_generation_queue_busy", status: 429 },
    });
  });
});
