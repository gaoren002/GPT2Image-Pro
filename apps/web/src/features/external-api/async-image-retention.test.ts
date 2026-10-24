/** R35：真实任务 Map 的引用留存、按需交付与纯中转执行前足额背压。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getObject: vi.fn(),
  callback: vi.fn(),
  readNet: vi.fn(),
  readPlan: vi.fn(),
}));
vi.mock("@repo/shared/generation-maintenance", () => ({
  readGenerationNetCredits: storage.readNet,
  readGenerationCompletionState: async () => "unknown",
  readGenerationCompletionRefundPlan: storage.readPlan,
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({ getObject: storage.getObject }),
}));
vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: storage.callback,
  SsrfBlockedError: class extends Error {},
}));

let tasks: typeof import("./async-image-tasks");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJk0AAAAASUVORK5CYII=",
  "base64"
);
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("BETTER_AUTH_SECRET", "async-retention-test-secret");
  for (const name of [
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
    "ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES",
  ])
    vi.stubEnv(name, undefined);
  storage.getObject.mockReset().mockResolvedValue(png);
  storage.readNet.mockReset().mockResolvedValue(undefined);
  storage.readPlan.mockReset().mockRejectedValue(new Error("offline"));
  storage.callback.mockReset().mockResolvedValue(new Response("ok"));
  tasks = await import("./async-image-tasks");
});

it("补偿净额未知显式 null/pending，部分成功仍交付；R11 恢复后重读真实净额", async () => {
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    retention: "storage",
  });
  const completed = tasks.completeAsyncImageTask(task.id, {
    imageResult: {
      created: 123,
      responseFormat: "url",
      results: [
        {
          generationId: "ok",
          imageUrl: "/api/storage/generations/owner/ok.png",
          creditsConsumed: 3,
          historyPending: true,
        },
        {
          generationId: "failed",
          imageUrl: "/api/storage/generations/owner/paid.png",
          error: "history unavailable",
          deliveryAvailable: true,
          creditsLastKnown: 5,
          settlementStatus: "refund_pending",
          refundTargetCredits: 0,
        },
      ],
    },
  });
  if (!completed) throw new Error("missing completion");
  const request = new Request("https://example.test");
  const pending = await tasks.resolveAsyncImageTaskResponse(completed, request);
  expect(pending).toMatchObject({
    status: "failed",
    history_pending: true,
    credits_consumed: null,
    settlement_status: "refund_pending",
    data: [expect.any(Object), expect.any(Object)],
  });
  expect(pending).not.toHaveProperty("userId");
  storage.readNet.mockResolvedValue(0);
  storage.readPlan.mockResolvedValue({ net: 0, targetCredits: 0, amount: 0 });
  expect(
    await tasks.resolveAsyncImageTaskResponse(completed, request)
  ).toMatchObject({
    credits_consumed: 3,
    settlement_status: "refunded",
    data: [expect.any(Object)],
  });
  expect(storage.readNet).toHaveBeenCalledWith("owner", "failed");
});

it("默认 global 512MiB 可容纳两位用户的 relay 预留，第三位 429，小结果完成后释放差额", () => {
  const first = tasks.createAsyncImageTask({
    userId: "a",
    apiKeyId: "ka",
    retention: "relay",
  });
  tasks.createAsyncImageTask({
    userId: "b",
    apiKeyId: "kb",
    retention: "relay",
  });
  expect(() =>
    tasks.createAsyncImageTask({ userId: "c", retention: "relay" })
  ).toThrow(/capacity exceeded/i);
  tasks.completeAsyncImageTask(first.id, {
    result: { data: [{ b64_json: "small" }] },
  });
  expect(
    tasks.createAsyncImageTask({ userId: "c", retention: "relay" }).status
  ).toBe("processing");
  expect(tasks.getAsyncImageTask(first.id)?.status).toBe("completed");
});

it("默认 Key 256MiB 独立于用户预算，不能用同 Key 接第二笔在飞 relay", () => {
  vi.stubEnv(
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    String(512 * 1024 * 1024)
  );
  tasks.createAsyncImageTask({
    userId: "a",
    apiKeyId: "k1",
    retention: "relay",
  });
  expect(() =>
    tasks.createAsyncImageTask({
      userId: "a",
      apiKeyId: "k1",
      retention: "relay",
    })
  ).toThrow(/capacity exceeded/i);
  expect(
    tasks.createAsyncImageTask({
      userId: "a",
      apiKeyId: "k2",
      retention: "relay",
    }).status
  ).toBe("processing");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("普通完成态仅持引用，poll 每次重新生成 b64，保留协议与完成 TTL", async () => {
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    generationIds: ["g1"],
    retention: "storage",
  });
  vi.advanceTimersByTime(61 * 60_000);
  const completed = tasks.completeAsyncImageTask(task.id, {
    imageResult: {
      created: 123,
      responseFormat: "b64_json",
      results: [
        {
          generationId: "g1",
          creditsConsumed: 3,
          imageOutputs: [
            {
              generationId: "g1",
              imageUrl: "/api/storage/generations/owner/test.png",
              revisedPrompt: "cat",
              outputRole: "final",
            },
          ],
        },
      ],
    },
  });
  expect(completed?.status).toBe("completed");
  expect(JSON.stringify(tasks.getAsyncImageTask(task.id))).not.toContain(
    "b64_json"
  );
  expect(storage.getObject).not.toHaveBeenCalled();
  if (!completed) throw new Error("missing completion");
  const request = new Request("https://example.test/v1/images/task");
  for (let index = 0; index < 2; index += 1) {
    expect(
      await tasks.resolveAsyncImageTaskResponse(completed, request)
    ).toMatchObject({
      id: task.id,
      status: "completed",
      created: 123,
      generation_id: "g1",
      data: [{ b64_json: png.toString("base64"), revised_prompt: "cat" }],
      credits_consumed: 3,
      usage: null,
    });
  }
  expect(storage.getObject).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(tasks.getAsyncImageTask(task.id))).not.toContain(
    "b64_json"
  );
  vi.advanceTimersByTime(30 * 60_000);
  expect(tasks.getAsyncImageTask(task.id)).toBeUndefined();
});

it("配置的小估算 reservation 不能缩减 relay 单图 32 MiB 上界预留", () => {
  vi.stubEnv("ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES", "1");
  vi.stubEnv(
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    String(32 * 1024 * 1024)
  );
  expect(() =>
    tasks.createAsyncImageTask({ userId: "owner", retention: "relay" })
  ).toThrow(/Reduce n/);
  expect(
    tasks.createAsyncImageTask({ userId: "owner", retention: "storage" }).status
  ).toBe("processing");
});

it("普通引用实际字节也计账，大型内联字段不挤占后续准入", () => {
  vi.stubEnv("ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES", String(256 * 1024));
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    retention: "storage",
  });
  tasks.completeAsyncImageTask(task.id, {
    imageResult: {
      created: 123,
      responseFormat: "b64_json",
      results: [
        {
          generationId: "g1",
          creditsConsumed: 2,
          imageBase64: "A".repeat(4 * 1024 * 1024),
          imageUrl: "/api/storage/generations/owner/result.png",
        },
      ],
    },
  });
  expect(
    tasks.createAsyncImageTask({ userId: "owner", retention: "storage" }).status
  ).toBe("processing");
  expect(storage.getObject).not.toHaveBeenCalled();
});

it("relay 批次预留包含全部可交付候选及编码膨胀，完成不丢已付费结果", () => {
  const fullReservation =
    4 * Math.ceil((32 * 1024 * 1024) / 3) * 4 + 128 * 1024 + 8192;
  vi.stubEnv(
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    String(fullReservation)
  );
  vi.stubEnv(
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    String(fullReservation)
  );
  vi.stubEnv(
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
    String(fullReservation)
  );
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    retention: "relay",
  });
  expect(() =>
    tasks.createAsyncImageTask({ userId: "owner", retention: "relay" })
  ).toThrow(/capacity exceeded/i);
  const result = {
    data: [{ b64_json: png.toString("base64") }],
    credits_consumed: 3,
  };
  expect(tasks.completeAsyncImageTask(task.id, { result })).toMatchObject(
    result
  );
  expect(tasks.getAsyncImageTask(task.id)).toMatchObject({
    status: "completed",
    ...result,
  });
});

it("callback 与 poll 同格式按需读引用，投递失败不丢结果或修改终态", async () => {
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    retention: "storage",
  });
  const completed = tasks.completeAsyncImageTask(task.id, {
    imageResult: {
      created: 123,
      responseFormat: "b64_json",
      results: [
        {
          generationId: "g1",
          creditsConsumed: 2,
          imageUrl: "/api/storage/generations/owner/result.png",
        },
      ],
    },
  });
  if (!completed) throw new Error("missing completion");
  storage.callback.mockResolvedValueOnce(new Response("bad", { status: 503 }));
  await tasks.postAsyncImageCallback("https://1.1.1.1/callback", completed);
  const callbackPayload = JSON.parse(storage.callback.mock.calls[0]?.[1].body);
  expect(callbackPayload).toMatchObject({
    data: [{ b64_json: png.toString("base64") }],
    credits_consumed: 2,
    status: "completed",
  });
  expect(callbackPayload).not.toHaveProperty("userId");
  expect(JSON.stringify(tasks.getAsyncImageTask(task.id))).not.toContain(
    "b64_json"
  );
  storage.getObject.mockRejectedValueOnce(
    new Error("temporary storage outage")
  );
  await expect(
    tasks.resolveAsyncImageTaskResponse(
      completed,
      new Request("https://example.test")
    )
  ).rejects.toThrow("temporary storage outage");
  expect(tasks.getAsyncImageTask(task.id)?.status).toBe("completed");
  expect(
    await tasks.resolveAsyncImageTaskResponse(
      completed,
      new Request("https://example.test")
    )
  ).toMatchObject({ data: [{ b64_json: png.toString("base64") }] });
});

it("普通 URL 结果每次重签，无需读原图；部分失败保留已成功的付费输出", async () => {
  const task = tasks.createAsyncImageTask({
    userId: "owner",
    retention: "storage",
    generationIds: ["g1", "g2"],
  });
  const completed = tasks.completeAsyncImageTask(task.id, {
    imageResult: {
      created: 123,
      responseFormat: "url",
      results: [
        {
          generationId: "g1",
          creditsConsumed: 2,
          imageUrl: "/api/storage/generations/owner/result.png",
        },
        { generationId: "g2", creditsConsumed: 0, error: "upstream failed" },
      ],
    },
  });
  if (!completed) throw new Error("missing completion");
  const request = new Request("https://example.test");
  const response = await tasks.resolveAsyncImageTaskResponse(
    completed,
    request
  );
  expect(response).toMatchObject({
    status: "failed",
    error: { message: "upstream failed" },
    data: [
      {
        url: expect.stringContaining(
          "https://example.test/api/storage/generations/owner/result.png?sig="
        ),
      },
    ],
    generation_ids: ["g1", "g2"],
    credits_consumed: 2,
  });
  vi.advanceTimersByTime(60_000);
  expect(
    await tasks.resolveAsyncImageTaskResponse(completed, request)
  ).not.toEqual(response);
  expect(storage.getObject).not.toHaveBeenCalled();
});
