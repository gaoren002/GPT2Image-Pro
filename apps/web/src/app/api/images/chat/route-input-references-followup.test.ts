/** R37 真路由与客户端确认回归；只隔离认证、存储驱动和生成，保留请求/响应编解码。 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "@/features/image-generation/components/chat-input-images";
import type {
  ChatConversation,
  ChatMessage,
} from "@/features/image-generation/components/chat-message-types";
import { readChatConversations } from "@/features/image-generation/components/chat-persistence";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  editable: vi.fn(),
  put: vi.fn(),
  session: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.session } },
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: mocks.capability,
  getPlanLimits: async () => ({
    maxChatImages: 8,
    maxChatContextChars: 32000,
    maxBatchCount: 3,
    imageGenerationConcurrency: 1,
  }),
  getPlanBillingConfig: async () => ({ chatRoundCredits: 0 }),
}));
vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: async () => ({
    maxFileSizeBytes: 1024 * 1024,
    maxUploadBytes: 2 * 1024 * 1024,
  }),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async (key: string) =>
    key === "CONTENT_MODERATION_PUBLIC_BASE_URL"
      ? "https://app.example.test"
      : key === "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"
        ? "generations"
        : "",
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({
    putObject: mocks.put,
    getSignedUrl: async () => "https://storage.example.test/input",
  }),
}));
vi.mock("@repo/shared/credits/core", () => ({ consumeCredits: vi.fn() }));
vi.mock("@/features/image-generation/operations", () => ({
  runImageGenerationForUser: mocks.run,
}));
vi.mock("@/features/image-generation/editable-file-operations", () => ({
  runEditableFileForUser: mocks.editable,
}));
import { POST as chat } from "./route";
import { POST as editable } from "../../editable-file/generate/route";

const raw = "data:image/png;base64,aW1hZ2U=";
/** 旧 v2 消息仍有 data URL，混有一个已确认引用与普通文件。 */
function message(id = "old-user"): ChatMessage {
  return {
    id,
    role: "user",
    text: "original",
    mode: "chat",
    createdAt: "2026-10-25T00:00:00Z",
    attachments: [
      {
        id: "existing",
        kind: "image",
        name: "same.png",
        previewUrl: "/api/storage/generations/user-a/requests/existing.png",
      },
      { id: "file", kind: "file", name: "notes.txt" },
      { id: "pending", kind: "image", name: "same.png", previewUrl: raw },
    ],
  };
}
/** 直接构造协议，在客户端 helper 实现前即可复现真实路由缺陷。 */
function historyRequest(stream = false, override?: Record<string, unknown>) {
  const form = new FormData();
  form.set("prompt", "continue");
  form.set(
    "history",
    JSON.stringify([
      {
        role: "user",
        text: "original",
        imageUrls: [message().attachments?.[0]?.previewUrl, raw],
        sourceImageMetadata: {
          messageId: "old-user",
          attachmentIds: ["existing", "pending"],
        },
        ...override,
      },
    ])
  );
  if (stream) form.set("stream", "true");
  return new NextRequest("https://app.example.test/api/images/chat", {
    method: "POST",
    body: form,
  });
}
/** 原始 JSON 或 SSE 内容转换为确认负载。 */
async function payloads(response: Response): Promise<unknown[]> {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return [await response.json()];
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
/** 使用真实确认接收器与 localStorage 外壳，模拟刷新恢复。 */
function receiver(initial = message()) {
  let messages = [initial];
  const conversationsRef = { current: [] as ChatConversation[] };
  const scope = { userId: "user-a", active: true };
  const receive = client.createChatSourceImageReceiver({
    scope,
    conversationId: "old-chat",
    mode: "chat",
    messageId: initial.id,
    attachmentIds: ["pending"],
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    conversationsRef,
    setConversations: vi.fn(),
    titleFallback: "old",
    onPersistenceResult: vi.fn(),
  });
  return { receive, scope, messages: () => messages };
}
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  vi.stubEnv("BETTER_AUTH_SECRET", "followup-test-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user-a" } });
  mocks.capability.mockReset().mockResolvedValue(true);
  mocks.put.mockReset().mockResolvedValue(undefined);
  mocks.run.mockReset().mockResolvedValue({ responseText: "done" });
  mocks.editable.mockReset().mockResolvedValue({
    conversationId: "output",
    primaryUrl: "/file.pptx",
    creditsCharged: 25,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("R37 历史图确认", () => {
  it.each([
    false,
    true,
  ])("旧图上传一次并写回；刷新再发只传引用 stream=%s", async (stream) => {
    const state = receiver();
    for (const payload of await payloads(await chat(historyRequest(stream))))
      state.receive(payload);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0]?.[2].toString()).toBe("image");
    const restored = readChatConversations(state.scope)
      .conversations as ChatConversation[];
    expect(restored).toHaveLength(1);
    expect(JSON.stringify(restored)).not.toContain("data:image");
    const user = restored[0]?.messages[0];
    if (!user) throw new Error("missing restored user");
    const next = new FormData();
    next.set("prompt", "again");
    next.set(
      "history",
      JSON.stringify([
        {
          role: "user",
          text: user.text,
          ...client.getChatHistoryImageInput(user),
        },
      ])
    );
    await chat(
      new NextRequest("https://app.example.test/api/images/chat", {
        method: "POST",
        body: next,
      })
    );
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(mocks.run.mock.calls.at(-1)?.[0].history)
    ).not.toContain("data:image");
  });
  it("上传失败保留 data URL，下次请求可重试", async () => {
    mocks.put.mockRejectedValueOnce(new Error("storage unavailable"));
    const state = receiver();
    for (const payload of await payloads(await chat(historyRequest())))
      state.receive(payload);
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toBe(raw);
    expect(mocks.run.mock.calls[0]?.[0].history[0].imageUrls[1]).toBe(raw);
    for (const payload of await payloads(await chat(historyRequest())))
      state.receive(payload);
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toMatch(
      /^\/api\/storage\//
    );
  });
  it.each([
    false,
    true,
  ])("生成抛错仍带历史上传确认 stream=%s", async (stream) => {
    mocks.run.mockRejectedValue(new Error("upstream failed"));
    const state = receiver();
    for (const payload of await payloads(await chat(historyRequest(stream))))
      state.receive(payload);
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toMatch(
      /^\/api\/storage\//
    );
  });
  it("错误或重复附件映射先拒绝，不上传也不生成", async () => {
    const response = await chat(
      historyRequest(false, {
        sourceImageMetadata: {
          messageId: "old-user",
          attachmentIds: ["pending", "pending"],
        },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("外账号存储引用在新旧上传前仍被拒绝", async () => {
    const response = await chat(
      historyRequest(false, {
        imageUrls: ["/api/storage/generations/user-b/private.png", raw],
      })
    );
    expect(response.status).toBe(403);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("旧 data URL 超限返回 413 且不丢图、不开始生成", async () => {
    const response = await chat(
      historyRequest(false, {
        imageUrls: [
          "/api/storage/generations/user-a/requests/existing.png",
          `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`,
        ],
      })
    );
    expect(response.status).toBe(413);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("R37 PPT/PSD 站内输入", () => {
  it.each([
    "ppt",
    "psd",
  ] as const)("multipart %s 输入只上传一次，真实确认写回后续聊天", async (kind) => {
    const form = client.buildEditableFileRequest({
      kind,
      prompt: "make file",
      messageId: "old-user",
      images: [
        {
          attachmentId: "pending",
          file: new File(["image"], "input.png", { type: "image/png" }),
        },
      ],
    });
    expect(form.get("base64Images")).toBeNull();
    expect(form.get("image")).toBeInstanceOf(File);
    const response = await editable(
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        body: form,
      })
    );
    expect(response.status).toBe(200);
    const state = receiver();
    await client.readEditableFileResponse(response, state.receive);
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toMatch(
      /^\/api\/storage\//
    );
    expect(mocks.editable.mock.calls[0]?.[0].base64Images).toEqual([raw]);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });
  it("旧 JSON 客户端仍可用，显式 metadata 可收到成功或失败确认", async () => {
    mocks.editable.mockRejectedValue(new Error("generation failed"));
    const response = await editable(
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        body: JSON.stringify({
          kind: "psd",
          prompt: "make file",
          base64Images: [raw],
          sourceImageMetadata: {
            messageId: "old-user",
            attachmentIds: ["pending"],
          },
        }),
      })
    );
    const data = await response.json();
    expect(data.error).toBeTruthy();
    const state = receiver();
    state.receive(data);
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toMatch(
      /^\/api\/storage\//
    );
  });
});

/** 补充边界通过真实请求调用，保证失败发生在存储/生成之前。 */
describe("R37 附件边界", () => {
  it.each([
    "chat",
    "editable",
  ])("身份与套餐失败无附件副作用 %s", async (target) => {
    const invoke = () =>
      target === "chat"
        ? chat(historyRequest())
        : editable(
            new NextRequest(
              "https://app.example.test/api/editable-file/generate",
              {
                method: "POST",
                body: JSON.stringify({
                  kind: "ppt",
                  prompt: "file",
                  base64Images: [raw],
                  sourceImageMetadata: {
                    messageId: "old-user",
                    attachmentIds: ["pending"],
                  },
                }),
              }
            )
          );
    mocks.session.mockResolvedValueOnce(null);
    expect((await invoke()).status).toBe(401);
    mocks.capability.mockResolvedValueOnce(false);
    expect((await invoke()).status).toBe(403);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.editable).not.toHaveBeenCalled();
  });
  it.each([
    "invalid-image",
    "oversize",
    "total-size",
    "duplicate-id",
    "too-many",
  ])("独立文件拒绝非法输入 %s", async (kind) => {
    const form = new FormData();
    form.set("kind", "psd");
    form.set("prompt", "make file");
    form.set("source_image_message_id", "old-user");
    const count =
      kind === "too-many"
        ? 9
        : kind === "total-size"
          ? 3
          : kind === "duplicate-id"
            ? 2
            : 1;
    form.set(
      "source_image_attachment_ids",
      JSON.stringify(
        Array.from({ length: count }, (_, index) =>
          kind === "duplicate-id" ? "same" : `image-${index}`
        )
      )
    );
    for (let index = 0; index < count; index++)
      form.append(
        "image",
        new File(
          [
            Buffer.alloc(
              kind === "oversize"
                ? 1024 * 1024 + 1
                : kind === "total-size"
                  ? 1024 * 1024
                  : 5
            ),
          ],
          "input.png",
          { type: kind === "invalid-image" ? "text/html" : "image/png" }
        )
      );
    const response = await editable(
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        body: form,
      })
    );
    expect(response.status).toBe(kind.includes("size") ? 413 : 400);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.editable).not.toHaveBeenCalled();
  });
  it("历史与本次 multipart 共同计入上传预算", async () => {
    const incoming = historyRequest(false, {
      imageUrls: [
        "/api/storage/generations/user-a/requests/existing.png",
        `data:image/png;base64,${Buffer.alloc(1024 * 1024).toString("base64")}`,
      ],
    });
    const form = await incoming.formData();
    form.append(
      "image",
      new File([Buffer.alloc(1024 * 1024)], "new.png", { type: "image/png" })
    );
    form.append(
      "file",
      new File(["extra"], "notes.txt", { type: "text/plain" })
    );
    expect(
      (
        await chat(
          new NextRequest(incoming.url, { method: "POST", body: form })
        )
      ).status
    ).toBe(413);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("未带稳定 ID 的旧客户端保留原字节且不产生额外上传", async () => {
    const response = await chat(
      historyRequest(false, { sourceImageMetadata: undefined })
    );
    expect(response.status).toBe(200);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0]?.[0].history[0].imageUrls[1]).toBe(raw);
  });
  it("独立文件上传失败仍传原图生成，下次请求可再确认", async () => {
    const request = () =>
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        body: client.buildEditableFileRequest({
          kind: "psd",
          prompt: "make file",
          messageId: "old-user",
          images: [
            {
              attachmentId: "pending",
              file: new File(["image"], "a.png", { type: "image/png" }),
            },
          ],
        }),
      });
    const state = receiver();
    mocks.put.mockRejectedValueOnce(new Error("storage down"));
    await client.readEditableFileResponse(
      await editable(request()),
      state.receive
    );
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toBe(raw);
    expect(mocks.editable.mock.calls[0]?.[0].base64Images).toEqual([raw]);
    await client.readEditableFileResponse(
      await editable(request()),
      state.receive
    );
    expect(state.messages()[0]?.attachments?.[2]?.previewUrl).toMatch(
      /^\/api\/storage\//
    );
  });
  it("没有 metadata 的既有 JSON PPT 请求保留原返回结构", async () => {
    const response = await editable(
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        body: JSON.stringify({
          kind: "ppt",
          prompt: "make file",
          base64Images: [raw],
        }),
      })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.primary_url).toBe("/file.pptx");
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

// 用真实请求取消与受控存储栅栏，确保下一条历史上传和生成都不会在取消后启动。
describe("R37 历史上传取消", () => {
  it.each([
    false,
    true,
  ])("首条上传中取消后停止后续副作用 stream=%s", async (stream) => {
    const controller = new AbortController();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: boolean[] = [];
    mocks.put.mockImplementation(async () => {
      observed.push(controller.signal.aborted);
      if (observed.length === 1) {
        started();
        await gate;
      }
    });
    const form = new FormData();
    form.set("prompt", "continue");
    form.set(
      "history",
      JSON.stringify(
        ["one", "two"].map((id) => ({
          role: "user",
          text: "old",
          imageUrls: [raw],
          sourceImageMetadata: { messageId: id, attachmentIds: [id] },
        }))
      )
    );
    if (stream) form.set("stream", "true");
    const pending = chat(
      new NextRequest("https://app.example.test/api/images/chat", {
        method: "POST",
        body: form,
        signal: controller.signal,
      })
    );
    await entered;
    controller.abort();
    release();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(observed).toEqual([false]);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

// 文件生成的领域错误须在站内与v1保持一致，附加上传确认/恢复入口不能把状态降成502。
describe("R05 站内文件错误编码", () => {
  it.each([
    ["editable_file_task_already_consumed", 409],
    ["editable_file_refund_pending", 503],
    ["editable_file_delivery_pending", 503],
    ["editable_file_cancelled", 499],
  ] as const)("保留 %s 对应的 %s", async (code, status) => {
    const failure = Object.assign(
      new Error("File task could not finish"),
      code === "editable_file_cancelled" ? { name: "AbortError" } : { code }
    );
    mocks.editable.mockRejectedValueOnce(failure);
    const response = await editable(
      new NextRequest("https://app.example.test/api/editable-file/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: "known-attempt",
          kind: "ppt",
          prompt: "outline",
        }),
      })
    );
    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload.error).toMatchObject({ code, status });
    expect(payload.taskId).toBe("known-attempt");
    expect(payload.poll_url).toBe(
      "/api/editable-file/tasks/known-attempt?kind=ppt"
    );
  });
});
