/** 池 API 异步任务协议（速度马兼容）的纯逻辑：任务号、状态解析与轮询的重试/终止规则。 */
import { describe, expect, it, vi } from "vitest";
import {
  parseUpstreamTaskState,
  pollUpstreamImageTask,
  readUpstreamTaskId,
  UPSTREAM_TASK_POLL_INTERVAL_MS,
} from "./upstream-async-task";

const IMAGE_URL = "https://img.example.test/i/result.png";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 轮询替身：按顺序返回响应（或抛错），sleep 推进虚拟时钟并记录等待时长。 */
function harness(steps: Array<Response | Error>, timeoutMs = 60_000) {
  let clock = 0;
  const sleeps: number[] = [];
  const fetchTask = vi.fn(async () => {
    const step = steps.shift();
    if (!step) return json({ status: "processing" });
    if (step instanceof Error) throw step;
    return step;
  });
  const run = (signal?: AbortSignal) =>
    pollUpstreamImageTask({
      taskId: "req_abc",
      fetchTask,
      formatHttpError: (response, body) =>
        `Upstream Images API returned HTTP ${response.status}: ${body}`,
      signal,
      timeoutMs,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
  return { fetchTask, sleeps, run };
}

describe("readUpstreamTaskId", () => {
  it.each([
    [{ requestId: "req_abc", status: "created" }, "req_abc"],
    [{ request_id: " req_abc " }, "req_abc"],
    [{ taskId: "task:42" }, "task:42"],
    [{ task_id: "0f8e-11" }, "0f8e-11"],
  ])("识别受理响应里的任务号 %j", (payload, expected) => {
    expect(readUpstreamTaskId(payload)).toBe(expected);
  });

  it.each([
    null,
    "req_abc",
    [{ requestId: "req_abc" }],
    {},
    { requestId: 42 },
    { requestId: ".." },
    { requestId: "../admin" },
    { requestId: "a/b" },
    { requestId: "a?b" },
    { requestId: "a#b" },
    { requestId: "" },
    { requestId: "x".repeat(201) },
  ])("拒绝缺失或可能穿越路径的任务号 %j", (payload) => {
    expect(readUpstreamTaskId(payload)).toBeNull();
  });
});

describe("parseUpstreamTaskState", () => {
  it.each([
    "processing",
    "created",
    "queued",
    "PENDING",
    "in_progress",
  ])("%s 视为处理中", (status) => {
    expect(parseUpstreamTaskState({ status, progress: 40 })).toEqual({
      status: "processing",
    });
  });

  it("succeeded 取 data[] 中的地址与 base64，跳过空项", () => {
    expect(
      parseUpstreamTaskState({
        id: "req_abc",
        status: "succeeded",
        data: [
          { type: "image", url: IMAGE_URL },
          { type: "image", url: "" },
          { b64_json: "aW1hZ2U=" },
          null,
        ],
      })
    ).toEqual({
      status: "succeeded",
      images: [{ url: IMAGE_URL }, { b64_json: "aW1hZ2U=" }],
    });
  });

  it("succeeded 但没有图片按失败处理，不再空轮询", () => {
    expect(parseUpstreamTaskState({ status: "succeeded", data: [] })).toEqual({
      status: "failed",
      error: "task succeeded without image data",
    });
  });

  it.each([
    [
      { status: "failed", error: "provider request invalid" },
      "provider request invalid",
    ],
    [{ status: "failed", error: { message: "  内容\n违规 " } }, "内容 违规"],
    [{ status: "cancelled", error: "" }, "task cancelled"],
  ])("失败原因压成单行 %j", (payload, error) => {
    expect(parseUpstreamTaskState(payload)).toEqual({
      status: "failed",
      error,
    });
  });

  it.each([
    null,
    [],
    "processing",
    {},
    { status: "weird" },
  ])("无法识别的响应返回 null：%j", (payload) => {
    expect(parseUpstreamTaskState(payload)).toBeNull();
  });
});

describe("pollUpstreamImageTask", () => {
  it("先等待再查询，处理中按固定间隔继续，成功返回图片", async () => {
    const { fetchTask, sleeps, run } = harness([
      json({ status: "processing", progress: 10 }),
      json({ status: "processing", progress: 60 }),
      json({ status: "succeeded", data: [{ type: "image", url: IMAGE_URL }] }),
    ]);
    await expect(run()).resolves.toEqual({ images: [{ url: IMAGE_URL }] });
    expect(fetchTask).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([
      UPSTREAM_TASK_POLL_INTERVAL_MS,
      UPSTREAM_TASK_POLL_INTERVAL_MS,
      UPSTREAM_TASK_POLL_INTERVAL_MS,
    ]);
  });

  it("任务失败时带上任务号与原因", async () => {
    const { run } = harness([
      json({ status: "failed", error: "provider request invalid" }),
    ]);
    await expect(run()).resolves.toEqual({
      error:
        "Upstream Images API task req_abc failed: provider request invalid",
    });
  });

  it.each([
    401, 403, 404, 400,
  ])("HTTP %i 为确定性失败，立即结束且沿用提交阶段的错误文案", async (status) => {
    const { fetchTask, run } = harness([new Response("denied", { status })]);
    await expect(run()).resolves.toEqual({
      error: `Upstream Images API returned HTTP ${status}: denied`,
    });
    expect(fetchTask).toHaveBeenCalledTimes(1);
  });

  it("网络错误、5xx、429 继续轮询并指数退避，恢复后按原间隔", async () => {
    const { fetchTask, sleeps, run } = harness([
      new Error("socket hang up"),
      new Response("bad gateway", { status: 502 }),
      new Response("slow down", { status: 429 }),
      json({ status: "processing" }),
      json({ status: "succeeded", data: [{ url: IMAGE_URL }] }),
    ]);
    await expect(run()).resolves.toEqual({ images: [{ url: IMAGE_URL }] });
    expect(fetchTask).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([3_000, 6_000, 12_000, 15_000, 3_000]);
  });

  it("超时后返回错误，附最近一次查询错误", async () => {
    const { run } = harness(
      Array.from(
        { length: 5 },
        () => new Response("bad gateway", { status: 502 })
      ),
      30_000
    );
    await expect(run()).resolves.toEqual({
      error:
        "Upstream Images API task req_abc did not finish within 30s (last poll error: Upstream Images API returned HTTP 502: bad gateway)",
    });
  });

  it("查询恢复正常后超时，不再引用之前的旧错误", async () => {
    const { run } = harness(
      [new Response("bad gateway", { status: 502 })],
      30_000
    );
    await expect(run()).resolves.toEqual({
      error: "Upstream Images API task req_abc did not finish within 30s",
    });
  });

  it("超时截止前的最后一次等待不超过剩余时间", async () => {
    const { sleeps, run } = harness([], 7_000);
    await run();
    expect(sleeps).toEqual([3_000, 3_000, 1_000]);
  });

  it("连续无法识别的响应达到上限后放弃", async () => {
    const { fetchTask, run } = harness(
      Array.from({ length: 5 }, () => json({ unexpected: true }))
    );
    await expect(run()).resolves.toEqual({
      error:
        "Upstream Images API task req_abc returned an unrecognized response",
    });
    expect(fetchTask).toHaveBeenCalledTimes(5);
  });

  it("取消时抛出取消原因，不再继续查询", async () => {
    const controller = new AbortController();
    const fetchTask = vi.fn(async () => json({ status: "processing" }));
    const reason = new Error("client went away");
    const pending = pollUpstreamImageTask({
      taskId: "req_abc",
      fetchTask,
      formatHttpError: () => "unused",
      signal: controller.signal,
      intervalMs: 10_000,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchTask).not.toHaveBeenCalled();
  });

  it("查询本身因取消失败时原样抛出，不当作网络抖动重试", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted during fetch");
    const fetchTask = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      pollUpstreamImageTask({
        taskId: "req_abc",
        fetchTask,
        formatHttpError: () => "unused",
        signal: controller.signal,
        sleep: async () => undefined,
      })
    ).rejects.toBe(reason);
    expect(fetchTask).toHaveBeenCalledTimes(1);
  });
});
