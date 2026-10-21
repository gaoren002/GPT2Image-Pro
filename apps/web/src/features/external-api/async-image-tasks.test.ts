import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  },
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
  vi.unstubAllGlobals();
  mockFetchWithDnsPin.mockReset();
});

describe("external async image tasks", () => {
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
    const res = toGenerationImageTaskResponse(row, "/api/storage/generations/k?sig=x");
    expect(res).toMatchObject({
      id: "gen_abc",
      object: "image",
      status: "completed",
      generation_id: "gen_abc",
      generationId: "gen_abc",
      image_url: "/api/storage/generations/k?sig=x",
      data: [{ url: "/api/storage/generations/k?sig=x", revised_prompt: "a cat" }],
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
    expect(pending).toMatchObject({ status: "processing", object: "image.generation" });
    expect(pending).not.toHaveProperty("data");
    expect(pending).not.toHaveProperty("image_url");

    const failed = toGenerationImageTaskResponse(
      { ...base, id: "gen_f", status: "failed", error: "boom" },
      null
    );
    expect(failed).toMatchObject({ status: "failed", error: { message: "boom" } });
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
