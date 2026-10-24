/** HTTP 同步取消回归：真实入口、批次和队列，隔离鉴权、上传、数据库与昂贵生成。 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueueInput = {
  userId: string;
  apiKeyId?: string;
  generationId?: string;
  signal?: AbortSignal;
};
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  execute: vi.fn(),
  cancelled: vi.fn(),
}));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/shared/auth", () => ({
  auth: {
    api: { getSession: vi.fn(async () => ({ user: { id: "http-user" } })) },
  },
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: vi.fn(async () => ({
    userId: "http-user",
    apiKeyId: "http-key",
    plan: "ultra",
    relayOnly: true,
  })),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => 1),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  MAX_PLAN_BATCH_COUNT: 10000,
  canUsePlanCapability: vi.fn(async () => true),
  getPlanLimits: vi.fn(async () => ({
    maxBatchCount: 10,
    imageGenerationConcurrency: 1,
    maxEditImages: 16,
    maxChatImages: 16,
    maxChatContextChars: 10000,
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
  runImageGenerationForUser: mocks.run,
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  bindImageBackendStickyMember: vi.fn(),
}));
vi.mock("@/features/external-api/models", () => ({
  isExternalResponsesImageModelAllowed: vi.fn(async () => true),
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
      data: Buffer.from("image"),
      mimeType: "image/png",
    },
  ]),
  uploadTemporaryImageUrls: vi.fn(async () => undefined),
  deleteTemporaryImages: vi.fn(async () => undefined),
}));

type Endpoint =
  | "web-generate"
  | "web-generate-batch"
  | "web-edit"
  | "web-edit-batch"
  | "generations"
  | "edits"
  | "agent"
  | "chat"
  | "chat-image"
  | "responses";
let queue: typeof import("../../image-generation/queue");
let handlers: Record<Endpoint, (request: NextRequest) => Promise<Response>>;

/** 构造有效同步请求；batch 和图片兼容分支分别验证其共用 input 的 signal。 */
function requestFor(endpoint: Endpoint, signal: AbortSignal, stream: boolean) {
  const multipart =
    endpoint === "web-edit" ||
    endpoint === "web-edit-batch" ||
    endpoint === "edits";
  let body: FormData | string;
  if (multipart) {
    const form = new FormData();
    form.set("prompt", "draw a square");
    form.set("stream", String(stream));
    if (endpoint === "web-edit-batch") form.set("count", "2");
    form.set("image", new File(["image"], "source.png", { type: "image/png" }));
    body = form;
  } else {
    body = JSON.stringify({
      prompt: "draw a square",
      stream,
      ...(endpoint === "web-generate-batch" ? { count: 2 } : {}),
      ...(endpoint === "chat" || endpoint === "chat-image"
        ? {
            model: endpoint === "chat" ? "gpt-6-astra" : "gpt-image-2",
            messages: [{ role: "user", content: "draw a square" }],
          }
        : {}),
      ...(endpoint === "responses"
        ? {
            model: "gpt-6-astra",
            input: "draw a square",
            tools: [{ type: "image_generation" }],
          }
        : {}),
    });
  }
  return new NextRequest(`https://example.test/${endpoint}`, {
    method: "POST",
    signal,
    body,
    headers: multipart ? undefined : { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  queue = await import("../../image-generation/queue");
  const [webGenerate, webEdit, generations, edits, agent, chat, responses] =
    await Promise.all([
      import("@/app/api/images/generate/route"),
      import("@/app/api/images/edit/route"),
      import("./image-generations"),
      import("./image-edits"),
      import("./agent-images"),
      import("./chat-completions"),
      import("./responses"),
    ]);
  handlers = {
    "web-generate": webGenerate.POST,
    "web-generate-batch": webGenerate.POST,
    "web-edit": webEdit.POST,
    "web-edit-batch": webEdit.POST,
    generations: generations.postExternalImageGenerations,
    edits: edits.postExternalImageEdits,
    agent: agent.postExternalAgentImages,
    chat: chat.postExternalChatCompletions,
    "chat-image": chat.postExternalChatCompletions,
    responses: responses.postExternalResponses,
  };
  mocks.execute.mockResolvedValue({
    imageBase64: "aW1hZ2U=",
    responseText: "done",
    model: "gpt-image-2",
    generationId: "generated",
    creditsConsumed: 1,
  });
  // 模拟主审已接好的统一操作边界，真实队列决定是否允许执行昂贵部分。
  mocks.run.mockImplementation(async (input: QueueInput) => {
    try {
      return await queue.withImageGenerationQueue(
        {
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          signal: input.signal,
          estimatedBytes: queue.estimateImageGenerationQueueBytes(input),
          priority: "normal",
          userConcurrency: 1,
        },
        mocks.execute
      );
    } catch (error) {
      mocks.cancelled(error);
      return {
        error: error instanceof Error ? error.message : "queue failed",
        generationId: input.generationId,
      };
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each<Endpoint>([
  "web-generate",
  "web-generate-batch",
  "web-edit",
  "web-edit-batch",
  "generations",
  "edits",
  "agent",
  "chat",
  "chat-image",
  "responses",
])("%s HTTP queue cancellation", (endpoint) => {
  it.each([
    false,
    true,
  ])("aborts a queued sync request without starting it (stream=%s)", async (stream) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = queue.withImageGenerationQueue(
      { userId: "blocker", priority: "normal", userConcurrency: 1 },
      () => gate
    );
    const controller = new AbortController();
    const request = requestFor(endpoint, controller.signal, stream);
    const response = handlers[endpoint](request);
    // 立即接住入口异常；finally 仍会 await 原 promise，把异常作为测试失败报告。
    void response.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled(), {
        interval: 1,
        timeout: 200,
      });
      expect(mocks.run.mock.calls[0]?.[0].signal).toBe(request.signal);
      controller.abort();
      // 在释放阻塞者之前就必须收到取消，不能等到空槽出现再执行请求。
      await vi.waitFor(
        () =>
          expect(mocks.cancelled).toHaveBeenCalledWith(
            expect.objectContaining({ code: "image_generation_cancelled" })
          ),
        { interval: 1, timeout: 200 }
      );
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      release();
      await blocker;
      await (await response).text();
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(queue.cancelQueuedImageGenerationTasks()).toBe(0);
  });
});
