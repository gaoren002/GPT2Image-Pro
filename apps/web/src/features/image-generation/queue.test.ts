/** 进程内图像队列回归：隔离运行设置，验证并发、容量、失败释放与等待取消。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettings = vi.hoisted(() => ({
  globalConcurrency: 500,
  failure: false,
}));

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => {
    if (runtimeSettings.failure) throw new Error("settings unavailable");
    return runtimeSettings.globalConcurrency;
  }),
}));

import { withImageGenerationQueue } from "./queue";

// 队列模块持有进程级单例状态（running/queue/runningByUser）。为避免用例之间互相
// 污染调度状态，需要新鲜实例的用例通过 vi.resetModules + 动态 import 取得隔离副本。
async function importFreshQueue() {
  vi.resetModules();
  return await import("./queue");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  runtimeSettings.failure = false;
});

describe("bounded cancellable image queue", () => {
  let module: Awaited<ReturnType<typeof importFreshQueue>>;
  const options = {
    userId: "a",
    apiKeyId: "k1",
    priority: "normal" as const,
    userConcurrency: 1,
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    runtimeSettings.globalConcurrency = 1;
    module = await importFreshQueue();
  });

  it.each([
    ["IMAGE_GENERATION_QUEUE_MAX_BYTES", { userId: "b", apiKeyId: "k2" }],
    [
      "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_USER",
      { userId: "a", apiKeyId: "k2" },
    ],
    [
      "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_KEY",
      { userId: "a", apiKeyId: "k1" },
    ],
  ])("reserves estimatedBytes atomically against %s and frees them after failure", async (env, owner) => {
    vi.stubEnv(env, "1024");
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(
      { ...options, estimatedBytes: 768 },
      () => gate.promise
    );
    const failed = expect(first).rejects.toThrow("failed");
    const rejected = vi.fn();
    void module
      .withImageGenerationQueue(
        { ...options, ...owner, estimatedBytes: 512 },
        async () => "never"
      )
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429 })
    );
    gate.reject(new Error("failed"));
    await failed;
    await expect(
      module.withImageGenerationQueue(
        { ...options, estimatedBytes: 1024 },
        async () => "recovered"
      )
    ).resolves.toBe("recovered");
  });

  it("reserves capacity before an async response and transfers it once without double counting", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    const reservation = module.reserveImageGenerationQueue({
      ...options,
      estimatedBytes: 768,
    });
    await expect(
      module.withImageGenerationQueue(options, async () => "blocked")
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      module.runWithImageGenerationQueueReservation(reservation, () =>
        module.withImageGenerationQueue(options, async () => "accepted")
      )
    ).resolves.toBe("accepted");
    expect(reservation.release()).toBe(false);
    await expect(
      module.withImageGenerationQueue(options, async () => "next")
    ).resolves.toBe("next");
  });

  it("does not leak a claimed reservation into independent work started by a running task", async () => {
    runtimeSettings.globalConcurrency = 2;
    const reservation = module.reserveImageGenerationQueue(options);
    await expect(
      module.runWithImageGenerationQueueReservation(reservation, () =>
        module.withImageGenerationQueue(options, async () => {
          return await module.withImageGenerationQueue(
            { ...options, userId: "inner" },
            async () => "independent"
          );
        })
      )
    ).resolves.toBe("independent");
  });

  it("releases unused reservations on validation failure, timeout and cancellation", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    const reservation = module.reserveImageGenerationQueue({
      ...options,
      timeoutMs: 10,
    });
    expect(reservation.release()).toBe(true);
    const unused = module.reserveImageGenerationQueue({
      ...options,
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(unused.release()).toBe(false);
    const other = module.reserveImageGenerationQueue(options);
    expect(module.cancelQueuedImageGenerationTasks({ userId: "a" })).toBe(1);
    expect(other.release()).toBe(false);
    await expect(
      module.withImageGenerationQueue(options, async () => "next")
    ).resolves.toBe("next");
  });

  it("refuses a huge input before admission while allowing another user's small input", async () => {
    await expect(
      module.withImageGenerationQueue(
        { ...options, estimatedBytes: 200 * 1024 * 1024 },
        async () => "huge"
      )
    ).rejects.toMatchObject({
      status: 413,
      code: "image_generation_input_too_large",
    });
    await expect(
      module.withImageGenerationQueue(
        { ...options, userId: "other", estimatedBytes: 1024 },
        async () => "small"
      )
    ).resolves.toBe("small");
  });

  it("rolls back partial batch admission and only checks the HTTP signal before acceptance", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    expect(() =>
      module.reserveAsyncImageGenerationQueueBatch({ ...options, count: 2 })
    ).toThrow(/queue is busy/i);
    const controller = new AbortController();
    const [reservation] = module.reserveAsyncImageGenerationQueueBatch({
      ...options,
      count: 1,
      signal: controller.signal,
    });
    if (!reservation) throw new Error("missing reservation");
    controller.abort();
    await expect(
      module.runWithImageGenerationQueueReservation(reservation, () =>
        module.withImageGenerationQueue(options, async () => "accepted")
      )
    ).resolves.toBe("accepted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("estimates binary, file and base64 inputs without serializing/copying them", () => {
    const buffer = Buffer.alloc(1024 * 1024);
    const input = {
      buffer,
      file: new File(["image"], "source.png"),
      prompt: "图".repeat(100),
      base64: "x".repeat(2048),
    };
    expect(
      module.estimateImageGenerationQueueBytes(input)
    ).toBeGreaterThanOrEqual(2 * buffer.length + 2 * 2048 + 2 * 5 + 600);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      Number.isFinite(module.estimateImageGenerationQueueBytes(cyclic))
    ).toBe(true);
  });

  it.each([
    ["IMAGE_GENERATION_QUEUE_MAX_TASKS", { userId: "b", apiKeyId: "k2" }],
    [
      "IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_USER",
      { userId: "a", apiKeyId: "k2" },
    ],
    [
      "IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_KEY",
      { userId: "a", apiKeyId: "k1" },
    ],
  ])("bounds running plus waiting tasks by %s and releases capacity after failure", async (env, owner) => {
    vi.stubEnv(env, "1");
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    const failed = expect(first).rejects.toThrow("upstream failed");
    await vi.advanceTimersByTimeAsync(0);
    const rejected = vi.fn();
    const run = vi.fn(async () => "unexpected");
    void module
      .withImageGenerationQueue({ ...options, ...owner }, run)
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        code: "image_generation_queue_busy",
      })
    );
    expect(run).not.toHaveBeenCalled();
    gate.reject(new Error("upstream failed"));
    await failed;
    await expect(
      module.withImageGenerationQueue(options, async () => "recovered")
    ).resolves.toBe("recovered");
  });

  it("keeps other users eligible when a user/key reaches capacity", async () => {
    runtimeSettings.globalConcurrency = 2;
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_USER", "1");
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const rejected = vi.fn();
    void module
      .withImageGenerationQueue(options, async () => "blocked")
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledOnce();
    await expect(
      module.withImageGenerationQueue(
        { ...options, userId: "b" },
        async () => "other"
      )
    ).resolves.toBe("other");
    gate.resolve("done");
    await first;
  });

  it("cancels a waiting task immediately, removes its timer/listener and releases its capacity", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "2");
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const run = vi.fn(async () => "never");
    const waiting = module.withImageGenerationQueue(
      { ...options, signal: controller.signal },
      run
    );
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "image_generation_cancelled",
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await cancelled;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const next = module.withImageGenerationQueue(options, async () => "next");
    gate.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(next).resolves.toBe("next");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an already aborted request and handles synchronous run throws without leaking slots", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => "never");
    const rejected = vi.fn();
    void module
      .withImageGenerationQueue({ ...options, signal: controller.signal }, run)
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ code: "image_generation_cancelled" })
    );
    expect(run).not.toHaveBeenCalled();
    const throws = module.withImageGenerationQueue(options, () => {
      throw new Error("sync failure");
    });
    const failed = expect(throws).rejects.toThrow("sync failure");
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    await expect(
      module.withImageGenerationQueue(options, async () => "ok")
    ).resolves.toBe("ok");
  });

  it("does not free a running slot when a waiting-only abort arrives after start", async () => {
    const controller = new AbortController();
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(
      { ...options, signal: controller.signal },
      () => gate.promise
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const run = vi.fn(async () => "next");
    const next = module.withImageGenerationQueue(options, run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    gate.resolve("done");
    await first;
    await expect(next).resolves.toBe("next");
  });

  it("releases timeout capacity and never starts an expired waiting task", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "2");
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const run = vi.fn(async () => "expired");
    const waiting = module.withImageGenerationQueue(
      { ...options, timeoutMs: 10, signal: controller.signal },
      run
    );
    const expired = expect(waiting).rejects.toMatchObject({
      status: 429,
      code: "image_generation_queue_busy",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expired;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    const next = module.withImageGenerationQueue(options, async () => "next");
    gate.resolve("done");
    await first;
    await expect(next).resolves.toBe("next");
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases waiters on settings failure and recovers without unhandled rejections", async () => {
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", "1");
    runtimeSettings.failure = true;
    const run = vi.fn(async () => "never");
    await expect(
      module.withImageGenerationQueue(options, run)
    ).rejects.toMatchObject({ status: 429 });
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    runtimeSettings.failure = false;
    await expect(
      module.withImageGenerationQueue(options, async () => "recovered")
    ).resolves.toBe("recovered");
  });

  it("clears all waiters during shutdown, leaving running tasks until they really settle", async () => {
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const a = module.withImageGenerationQueue(options, async () => "never");
    const b = module.withImageGenerationQueue(
      { ...options, userId: "b" },
      async () => "never"
    );
    const aCancelled = expect(a).rejects.toMatchObject({
      code: "image_generation_cancelled",
    });
    const bCancelled = expect(b).rejects.toMatchObject({
      code: "image_generation_cancelled",
    });
    expect(module.cancelQueuedImageGenerationTasks()).toBe(2);
    expect(module.cancelQueuedImageGenerationTasks()).toBe(0);
    await Promise.all([aCancelled, bCancelled]);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve("done");
    await expect(first).resolves.toBe("done");
  });

  it("scopes key capacity by user and still enforces aggregate user capacity", async () => {
    runtimeSettings.globalConcurrency = 3;
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_USER", "2");
    vi.stubEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_KEY", "1");
    const [firstGate, secondGate] = [
      deferred<string>(),
      deferred<string>(),
    ] as const;
    const first = module.withImageGenerationQueue(
      options,
      () => firstGate.promise
    );
    const second = module.withImageGenerationQueue(
      { ...options, apiKeyId: "k2" },
      () => secondGate.promise
    );
    await expect(
      module.withImageGenerationQueue(
        { ...options, apiKeyId: "k3" },
        async () => "blocked"
      )
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      module.withImageGenerationQueue(
        { ...options, userId: "b" },
        async () => "other"
      )
    ).resolves.toBe("other");
    firstGate.resolve("first");
    await first;
    secondGate.resolve("second");
    await second;
  });

  it("cleans only the selected user's waiting tasks and preserves other users", async () => {
    const gate = deferred<string>();
    const first = module.withImageGenerationQueue(options, () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const run = vi.fn(async () => "never");
    const waiting = module.withImageGenerationQueue(options, run);
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "image_generation_cancelled",
    });
    const other = module.withImageGenerationQueue(
      { ...options, userId: "b" },
      async () => "other"
    );
    expect(module.cancelQueuedImageGenerationTasks({ userId: "a" })).toBe(1);
    await cancelled;
    gate.resolve("done");
    await first;
    await expect(other).resolves.toBe("other");
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withImageGenerationQueue", () => {
  beforeEach(() => {
    runtimeSettings.globalConcurrency = 500;
  });

  it("limits running tasks by the configured global concurrency", async () => {
    runtimeSettings.globalConcurrency = 1;
    const first = deferred<string>();
    const started: string[] = [];

    const firstRun = withImageGenerationQueue(
      {
        userId: "user-a",
        priority: "normal",
        userConcurrency: 10,
      },
      async () => {
        started.push("first");
        return await first.promise;
      }
    );
    const secondRun = withImageGenerationQueue(
      {
        userId: "user-b",
        priority: "normal",
        userConcurrency: 10,
      },
      async () => {
        started.push("second");
        return "second";
      }
    );

    await flushTasks();
    expect(started).toEqual(["first"]);

    first.resolve("first");
    await firstRun;
    await flushTasks();

    expect(started).toEqual(["first", "second"]);
    await expect(secondRun).resolves.toBe("second");
  });

  it("limits per-user concurrency independent of global", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const first = deferred<string>();
    const started: string[] = [];

    // 同一用户的两个任务，userConcurrency=1：第二个必须等到第一个完成。
    const firstRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a1");
        return await first.promise;
      }
    );
    const secondRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a2");
        return "a2";
      }
    );
    // 另一用户不受前者占用影响，应当立即起跑（全局并发充足）。
    const otherRun = queue(
      { userId: "user-b", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("b1");
        return "b1";
      }
    );

    await flushTasks();
    expect(started).toEqual(["a1", "b1"]);
    await expect(otherRun).resolves.toBe("b1");

    first.resolve("a1");
    await firstRun;
    await flushTasks();

    expect(started).toEqual(["a1", "b1", "a2"]);
    await expect(secondRun).resolves.toBe("a2");
  });

  it("runs higher priority before normal", async () => {
    runtimeSettings.globalConcurrency = 1;
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();
    const started: string[] = [];

    // 先占满唯一的全局槽位，使后续任务全部排队等待调度。
    const blockerRun = queue(
      { userId: "blocker", priority: "normal", userConcurrency: 10 },
      async () => {
        started.push("blocker");
        return await blocker.promise;
      }
    );

    await flushTasks();
    expect(started).toEqual(["blocker"]);

    // 先入队 normal，再入队 highest；释放槽位后应优先调度 highest（优先级加权）。
    const normalRun = queue(
      { userId: "normal-user", priority: "normal", userConcurrency: 10 },
      async () => {
        started.push("normal");
        return "normal";
      }
    );
    const highestRun = queue(
      { userId: "highest-user", priority: "highest", userConcurrency: 10 },
      async () => {
        started.push("highest");
        return "highest";
      }
    );

    blocker.resolve("blocker");
    await blockerRun;
    await flushTasks();

    expect(started).toEqual(["blocker", "highest", "normal"]);
    await expect(highestRun).resolves.toBe("highest");
    await expect(normalRun).resolves.toBe("normal");
  });

  it("frees user slot after completion", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const started: string[] = [];

    // 串行跑两个同用户任务（userConcurrency=1），第二个能起跑即证明第一个完成后
    // runningByUser 计数被正确清理、槽位已释放。
    await queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a1");
        return "a1";
      }
    );
    await queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a2");
        return "a2";
      }
    );

    expect(started).toEqual(["a1", "a2"]);
  });

  it("rejects queued task after timeout with concurrency-limit message when user at limit", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();

    // 占满该用户的唯一并发槽位，使下一个同用户任务排队并最终超时。
    const blockerRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => await blocker.promise
    );

    await flushTasks();

    const queuedRun = queue(
      {
        userId: "user-a",
        priority: "normal",
        userConcurrency: 1,
        timeoutMs: 5,
      },
      async () => "never"
    );

    await expect(queuedRun).rejects.toThrow(/concurrency limit reached/i);

    blocker.resolve("blocker");
    await blockerRun;
  });

  it("rejects with busy message when global slots exhausted", async () => {
    runtimeSettings.globalConcurrency = 1;
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();

    // 用 user-a 占满唯一的全局槽位；user-b 仍在自身并发额度内，却因全局繁忙超时。
    const blockerRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 10 },
      async () => await blocker.promise
    );

    await flushTasks();

    const queuedRun = queue(
      {
        userId: "user-b",
        priority: "normal",
        userConcurrency: 10,
        timeoutMs: 5,
      },
      async () => "never"
    );

    await expect(queuedRun).rejects.toThrow(/queue is busy/i);

    blocker.resolve("blocker");
    await blockerRun;
  });
});
