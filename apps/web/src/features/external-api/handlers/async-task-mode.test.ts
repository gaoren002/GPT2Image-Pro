/**
 * 异步任务模式（兼容速度马）端到端：真实 handler、内存任务与查询渲染，
 * 隔离鉴权、生成管线、对象存储与数据库。
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  image: vi.fn(),
  generation: vi.fn(),
  asyncTaskMode: false,
  apiKeyId: "task-key",
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => 500),
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: vi.fn(async () => ({
    userId: "task-user",
    apiKeyId: mocks.apiKeyId,
    plan: "ultra",
    relayOnly: false,
    asyncTaskMode: mocks.asyncTaskMode,
  })),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  MAX_PLAN_BATCH_COUNT: 10000,
  canUsePlanCapability: vi.fn(async () => true),
  getPlanLimits: vi.fn(async () => ({
    maxBatchCount: 10,
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
  getGenerationById: mocks.generation,
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(async () => ({ getObject: vi.fn() })),
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

let tasks: typeof import("../async-image-tasks");
let generations: typeof import("./image-generations");
let edits: typeof import("./image-edits");
let query: typeof import("./tasks");

const APP_URL = "https://app.example.test";
const STORED = "/api/storage/generations/task-user/result.png";

/** 生图 JSON 请求；extra 合并进请求体，search 拼到 URL。 */
function generate(extra: Record<string, unknown> = {}, search = "") {
  return generations.postExternalImageGenerations(
    new NextRequest(`${APP_URL}/v1/images/generations${search}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a square", ...extra }),
    })
  );
}

/** 编辑 multipart 请求。 */
function edit(fields: Record<string, string> = {}) {
  const body = new FormData();
  body.set("prompt", "a square");
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  body.set("image", new File(["image"], "source.png", { type: "image/png" }));
  return edits.postExternalImageEdits(
    new NextRequest(`${APP_URL}/v1/images/edits`, { method: "POST", body })
  );
}

/** 按速度马的方式查询任务。 */
async function poll(id: string) {
  const response = await query.getExternalTask(
    new NextRequest(`${APP_URL}/v1/tasks/${id}`),
    { params: Promise.resolve({ taskId: id }) }
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

/** 生成管线替身：可控地挂起，再以存储引用完成。 */
function deferredImage() {
  let finish: () => void = () => undefined;
  mocks.image.mockImplementationOnce(
    (input: { generationId: string }) =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            generationId: input.generationId,
            creditsConsumed: 2,
            imageUrl: STORED,
          });
      })
  );
  return () => finish();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.asyncTaskMode = false;
  mocks.apiKeyId = "task-key";
  vi.stubEnv("BETTER_AUTH_SECRET", "async-task-mode-test-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
  mocks.generation.mockReset().mockResolvedValue(null);
  mocks.image
    .mockReset()
    .mockImplementation(async (input: { generationId: string }) => ({
      generationId: input.generationId,
      creditsConsumed: 2,
      imageUrl: STORED,
    }));
  tasks = await import("../async-image-tasks");
  generations = await import("./image-generations");
  edits = await import("./image-edits");
  query = await import("./tasks");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("提交", () => {
  it("Key 开启任务模式时，不带 async 参数也立即返回 requestId；单张任务号即生成 ID", async () => {
    mocks.asyncTaskMode = true;
    const finish = deferredImage();
    const response = await generate();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      requestId: expect.any(String),
      status: "processing",
    });
    expect(mocks.image.mock.calls[0]?.[0]).toMatchObject({
      generationId: body.requestId,
      asyncDelivery: true,
    });
    finish();
  });

  it('请求参数 async:"task" 与 URL ?async=task 都能单次开启', async () => {
    expect(await (await generate({ async: "task" })).json()).toMatchObject({
      status: "processing",
      requestId: expect.any(String),
    });
    expect(await (await generate({}, "?async=task")).json()).toMatchObject({
      status: "processing",
      requestId: expect.any(String),
    });
  });

  it("编辑的 multipart async=task 同样返回 requestId", async () => {
    const body = await (await edit({ async: "task" })).json();
    expect(body).toEqual({
      requestId: expect.any(String),
      status: "processing",
    });
    expect(mocks.image.mock.calls[0]?.[0]).toMatchObject({
      generationId: body.requestId,
    });
  });

  it("多张任务用内存任务号", async () => {
    const body = await (await generate({ async: "task", n: 2 })).json();
    expect(body.requestId).toMatch(/^task_/);
  });

  it("普通 async:true 仍返回原任务对象", async () => {
    const body = await (await generate({ async: true })).json();
    expect(body).toMatchObject({
      id: expect.stringMatching(/^task_/),
      object: "image.generation",
      status: "processing",
    });
    expect(body).not.toHaveProperty("requestId");
  });

  it("任务模式不能与 stream 同用", async () => {
    mocks.asyncTaskMode = true;
    const response = await generate({ stream: true });
    expect(response.status).toBe(400);
    expect(mocks.image).not.toHaveBeenCalled();
  });
});

describe("查询 GET /v1/tasks/{requestId}", () => {
  it("处理中 → 成功：返回带签名的完整公网地址，且不缓存", async () => {
    const finish = deferredImage();
    const { requestId } = await (await generate({ async: "task" })).json();
    const pending = await poll(requestId);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(pending.body).toEqual({
      id: requestId,
      status: "processing",
      progress: 0,
      error: "",
      data: [],
    });
    finish();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(requestId)?.status).toBe("completed")
    );
    const done = await poll(requestId);
    expect(done.body).toMatchObject({
      id: requestId,
      status: "succeeded",
      progress: 100,
      error: "",
    });
    expect(done.body.data).toHaveLength(1);
    expect(done.body.data[0].type).toBe("image");
    expect(done.body.data[0].url.startsWith(`${APP_URL}${STORED}?sig=`)).toBe(
      true
    );
  });

  it("普通 async 创建的任务也能用任务模式查询，图片同样给地址", async () => {
    const task = await (await generate({ async: true })).json();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(task.id)?.status).toBe("completed")
    );
    const done = await poll(task.id);
    expect(done.body.status).toBe("succeeded");
    expect(done.body.data[0].url.startsWith(`${APP_URL}${STORED}`)).toBe(true);
  });

  it("失败：status failed，原因在 error", async () => {
    mocks.image
      .mockReset()
      .mockImplementation(async (input: { generationId: string }) => ({
        generationId: input.generationId,
        error: "积分不足: 需要 4，可用 1",
      }));
    const { requestId } = await (await generate({ async: "task" })).json();
    await vi.waitFor(() =>
      expect(tasks.getAsyncImageTask(requestId)?.status).toBe("failed")
    );
    expect((await poll(requestId)).body).toEqual({
      id: requestId,
      status: "failed",
      progress: 0,
      error: "积分不足: 需要 4，可用 1",
      data: [],
    });
  });

  it("同一用户的其他 Key 查不到内存中的任务，且不回退查库", async () => {
    const { requestId } = await (await generate({ async: "task" })).json();
    mocks.apiKeyId = "other-key";
    mocks.generation.mockResolvedValue({
      id: requestId,
      userId: "task-user",
      status: "completed",
      error: null,
      storageKey: "task-user/result.png",
      storageBucket: "generations",
    });
    const denied = await poll(requestId);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("task_not_found");
    expect(mocks.generation).not.toHaveBeenCalled();
  });

  it("内存中没有时按 generation_id 查库，只返回本人的记录", async () => {
    mocks.generation.mockResolvedValueOnce({
      id: "gen-persisted",
      userId: "task-user",
      status: "completed",
      error: null,
      storageKey: "task-user/persisted.png",
      storageBucket: "generations",
    });
    const own = await poll("gen-persisted");
    expect(own.body).toMatchObject({
      id: "gen-persisted",
      status: "succeeded",
    });
    expect(
      own.body.data[0].url.startsWith(
        `${APP_URL}/api/storage/generations/task-user/persisted.png?sig=`
      )
    ).toBe(true);
    mocks.generation.mockResolvedValueOnce({
      id: "gen-foreign",
      userId: "someone-else",
      status: "completed",
      error: null,
      storageKey: "someone-else/x.png",
      storageBucket: "generations",
    });
    expect((await poll("gen-foreign")).status).toBe(404);
  });

  it("不存在的任务号返回 404；超长任务号返回 400", async () => {
    expect((await poll("missing")).status).toBe(404);
    expect((await poll("x".repeat(129))).status).toBe(400);
  });
});
