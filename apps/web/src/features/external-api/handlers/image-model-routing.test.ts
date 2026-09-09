/**
 * 外部图片模型输入回归：调用真实 handler 与响应编码，仅隔离鉴权、上传和统一操作。
 * 验证未知图片别名能交给分组策略，文本型号仍单独传递，非法类型及操作错误正确返回。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runImageGenerationForUser: vi.fn(),
}));

vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: vi.fn(async () => ({
    userId: "model-routing-user",
    apiKeyId: "model-routing-key",
    plan: "ultra",
  })),
}));

vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  MAX_PLAN_BATCH_COUNT: 10_000,
  canUsePlanCapability: vi.fn(async () => true),
  getPlanLimits: vi.fn(async () => ({
    maxBatchCount: 10,
    imageGenerationConcurrency: 2,
    maxChatContextChars: 10_000,
    maxChatImages: 16,
    maxEditImages: 16,
  })),
}));

vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: vi.fn(async () => ({
    maxFileSizeBytes: 20 * 1024 * 1024,
    maxUploadBytes: 100 * 1024 * 1024,
  })),
}));

vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(async () => ({ plan: "ultra" })),
}));

vi.mock("@/features/image-generation/operations", () => ({
  runImageGenerationForUser: mocks.runImageGenerationForUser,
}));

vi.mock("@/features/image-generation/request-utils", () => ({
  DEFAULT_MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  formatMegabytes: vi.fn(() => "20 MB"),
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

vi.mock("@/features/external-api/safe-image-fetch", () => ({
  // 公网 IP 字面量避免 DNS；HTTP 响应在此隔离，测试不访问网络。
  fetchPublicImage: vi.fn(
    async () =>
      new Response("image", { headers: { "content-type": "image/png" } })
  ),
  readResponseBytesWithLimit: vi.fn(async () => Buffer.from("image")),
}));

import { postExternalChatCompletions } from "./chat-completions";
import { postExternalImageEdits } from "./image-edits";
import { postExternalImageGenerations } from "./image-generations";

type Endpoint = "generations" | "edits-json" | "edits-form" | "chat";
const endpoints: Endpoint[] = [
  "generations",
  "edits-json",
  "edits-form",
  "chat",
];

/** 构造最小有效图片请求；保留 unknown 型号以验证真实入口的类型边界。 */
function sendRequest(endpoint: Endpoint, imageModel: unknown) {
  const isChat = endpoint === "chat";
  const path = isChat
    ? "chat/completions"
    : endpoint === "generations"
      ? "images/generations"
      : "images/edits";
  const body: Record<string, unknown> = isChat
    ? {
        model: "gpt-6-astra",
        image_model: imageModel,
        messages: [{ role: "user", content: "Draw a square" }],
      }
    : {
        model: imageModel,
        gpt_model: "gpt-6-astra",
        prompt: "Draw a square",
      };
  const url = `https://example.test/v1/${path}`;
  let request: NextRequest;
  if (endpoint === "edits-form") {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value instanceof Blob) form.set(key, value);
      else if (value !== undefined) form.set(key, String(value));
    }
    form.set("image", new File(["image"], "source.png", { type: "image/png" }));
    request = new NextRequest(url, { method: "POST", body: form });
  } else {
    if (endpoint === "edits-json")
      body.image_url = "https://8.8.8.8/source.png";
    request = new NextRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  if (isChat) return postExternalChatCompletions(request);
  if (endpoint === "generations") return postExternalImageGenerations(request);
  return postExternalImageEdits(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runImageGenerationForUser.mockResolvedValue({
    imageBase64: Buffer.from("image").toString("base64"),
    model: "gpt-image-2.5",
    generationId: "model-routing-generation",
    creditsConsumed: 1,
  });
});

describe.each(endpoints)("%s image model routing", (endpoint) => {
  it("defers unknown image aliases and preserves the separate text model", async () => {
    const response = await sendRequest(endpoint, "  custom-image-model  ");
    await response.json();

    expect(response.status).toBe(200);
    expect(mocks.runImageGenerationForUser).toHaveBeenCalledOnce();
    expect(mocks.runImageGenerationForUser.mock.calls[0]?.[0]).toMatchObject(
      endpoint === "chat"
        ? {
            mode: "chat",
            model: "gpt-6-astra",
            imageModel: "custom-image-model",
          }
        : { model: "custom-image-model", gptModel: "gpt-6-astra" }
    );
  });

  it.each([
    undefined,
    "",
    "   ",
  ])("keeps a default for omitted or blank input %j", async (model) => {
    const response = await sendRequest(endpoint, model);
    await response.json();

    expect(response.status).toBe(200);
    const input = mocks.runImageGenerationForUser.mock.calls[0]?.[0];
    expect(input?.[endpoint === "chat" ? "imageModel" : "model"]).toBe(
      "gpt-image-2.5"
    );
  });

  it("returns a deferred unsupported-model rejection as HTTP 400", async () => {
    mocks.runImageGenerationForUser.mockResolvedValue({
      error: "Unsupported model for image generation. Use a gpt-image-* model.",
      generationId: "rejected-model-generation",
    });
    const response = await sendRequest(endpoint, "custom-image-model");
    const payload = await response.json();

    expect(mocks.runImageGenerationForUser).toHaveBeenCalledOnce();
    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({
      code: "unsupported_model",
      status: 400,
    });
  });
});

describe.each<Endpoint>([
  "generations",
  "edits-json",
  "chat",
])("%s image model type validation", (endpoint) => {
  it.each(
    [null, 42, true, {}, []].map((model) => ({ model }))
  )("rejects invalid model type $model", async ({ model }) => {
    const response = await sendRequest(endpoint, model);
    await response.json();

    expect(response.status).toBe(400);
    expect(mocks.runImageGenerationForUser).not.toHaveBeenCalled();
  });
});

it("rejects a multipart image model uploaded as a file", async () => {
  const response = await sendRequest(
    "edits-form",
    new File(["gpt-image-2"], "model.txt")
  );
  await response.json();

  expect(response.status).toBe(400);
  expect(mocks.runImageGenerationForUser).not.toHaveBeenCalled();
});

it("keeps the premium text-model permission rejection from the unified operation", async () => {
  mocks.runImageGenerationForUser.mockResolvedValue({
    error: "This GPT model requires Ultra plan.",
    generationId: "premium-model-rejection",
  });
  const response = await sendRequest("chat", "custom-image-model");
  const payload = await response.json();

  expect(mocks.runImageGenerationForUser).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-6-astra",
      imageModel: "custom-image-model",
    })
  );
  expect(response.status).toBe(403);
  expect(payload.error.code).toBe("insufficient_plan");
});

it("keeps an unknown top-level chat model on the text-model validation path", async () => {
  mocks.runImageGenerationForUser.mockResolvedValue({
    error: "Unsupported chat model.",
    generationId: "invalid-text-model",
  });
  const response = await postExternalChatCompletions(
    new NextRequest("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "unknown-top-level-model",
        image_model: "custom-image-model",
        messages: [{ role: "user", content: "Draw a square" }],
      }),
    })
  );
  await response.json();

  expect(mocks.runImageGenerationForUser).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "chat",
      model: "unknown-top-level-model",
      imageModel: "custom-image-model",
    })
  );
  expect(response.status).toBe(400);
});
