/** R20 集成回归：真实 scheduler 与锁连接实现；仅替换驱动连接、全局 db 和任务边界。 */
import type { EventEmitter } from "node:events";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateRow = { key: string; value: Record<string, unknown> };
type TestClient = EventEmitter & {
  config: Record<string, unknown>;
  driver: string;
  connected: boolean;
  closed: boolean;
  acquired: boolean;
  transactionOpen: boolean;
  lockId: string | undefined;
  queries: string[];
  end: () => Promise<void>;
};

const state = vi.hoisted(() => ({
  clients: [] as TestClient[],
  rows: [] as StateRow[],
  commits: [] as StateRow[],
  inTransaction: 0,
  transactions: 0,
  reads: 0,
  allowLock: true,
  connect: vi.fn<(client: TestClient) => Promise<void>>(),
  close: vi.fn<(client: TestClient) => Promise<void>>(),
  query: vi.fn<(client: TestClient) => Promise<void>>(),
  commit: vi.fn<(row: StateRow) => Promise<void>>(),
  enabled: vi.fn<() => Promise<boolean>>(),
  interval: vi.fn<() => Promise<number>>(),
  maintenance: vi.fn<() => Promise<unknown>>(),
  dailyStats: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter implements TestClient {
      driver = "pg";
      connected = false;
      closed = false;
      acquired = false;
      transactionOpen = false;
      lockId: string | undefined;
      queries: string[] = [];
      constructor(public config: Record<string, unknown>) {
        super();
        state.clients.push(this);
      }
      /** 连接建立与失败由用例控制，驱动 error 事件使用真实 EventEmitter 语义。 */
      async connect() {
        await state.connect(this);
        this.connected = true;
      }
      /** 模拟数据库的互斥状态；查询失败可与连接 error/end 独立注入。 */
      async query(text: string, values?: number[]) {
        this.queries.push(text);
        await state.query(this);
        if (/^\s*begin\b/i.test(text)) {
          this.transactionOpen = true;
          return { rows: [] };
        }
        if (/^\s*(commit|rollback)\b/i.test(text)) {
          this.transactionOpen = false;
          return { rows: [] };
        }
        this.lockId = JSON.stringify(values);
        const locked =
          state.allowLock &&
          !state.clients.some(
            (client) =>
              client !== this &&
              client.lockId === this.lockId &&
              client.acquired &&
              !client.closed
          );
        // xact 锁在隐式事务结束后不会继续持有，不能把任意 locked=true 都当作会话锁。
        this.acquired = locked && text.includes("pg_try_advisory_lock(");
        return { rows: [{ locked }] };
      }
      /** 最终关闭释放会话锁；关闭失败仍可用于验证主错误不会被覆盖。 */
      async end() {
        await state.close(this);
        this.closed = true;
        this.acquired = false;
        this.emit("end");
      }
    },
    Pool: class {
      constructor() {
        throw new Error("锁连接不得创建或借用主应用 Pool");
      }
    },
  };
});

// Neon 由 database 包拥有；精确 mock 同一依赖，避免给 web 新增运行时依赖。
vi.mock(
  "../../../../packages/database/node_modules/@neondatabase/serverless",
  async () => {
    const { Client } = await import("pg");
    return {
      Client: class extends Client {
        constructor(config: import("pg").ClientConfig) {
          super(config);
          const client = state.clients.at(-1);
          if (client) client.driver = "neon";
        }
      },
      neonConfig: {},
      Pool: class {
        constructor() {
          throw new Error("锁连接不得借用 NeonPool");
        }
      },
    };
  }
);

vi.mock("@repo/database", async () => {
  const { systemSetting } = await import("@repo/database/schema");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  /** 全局写入立即提交；事务写入暂存，callback 抛错时丢弃，复现真实 rollback。 */
  function connection(pending?: StateRow[]) {
    return {
      execute: async () => ({ rows: [{ locked: state.allowLock }] }),
      select: () => ({
        from: () => ({
          where: (condition: import("drizzle-orm").SQL) => ({
            limit: async () => {
              state.reads += 1;
              const key = dialect.sqlToQuery(condition).params[0];
              const row = [...state.rows, ...(pending ?? [])]
                .filter((candidate) => candidate.key === key)
                .at(-1);
              return row ? [row] : [];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: StateRow) => ({
          onConflictDoUpdate: async () => {
            await state.commit(row);
            if (pending) pending.push(row);
            else {
              state.rows.push(row);
              state.commits.push(row);
            }
          },
        }),
      }),
    };
  }
  return {
    systemSetting,
    db: {
      ...connection(),
      transaction: async (
        callback: (tx: ReturnType<typeof connection>) => Promise<unknown>
      ) => {
        state.transactions += 1;
        state.inTransaction += 1;
        const pending: StateRow[] = [];
        try {
          const result = await callback(connection(pending));
          state.rows.push(...pending);
          state.commits.push(...pending);
          return result;
        } finally {
          state.inTransaction -= 1;
        }
      },
    },
  };
});
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: state.enabled,
  getRuntimeSettingNumber: state.interval,
}));
vi.mock("./instance-cache-maintenance", () => ({
  startInstanceCacheMaintenance: vi.fn(),
}));
vi.mock("./generation-daily-stats", () => ({
  runGenerationDailyStatsJob: state.dailyStats,
}));
vi.mock("./scheduled-jobs", () => ({
  runCreditsExpireJob: vi.fn(),
  runImageMaintenanceJob: state.maintenance,
  runSub2ApiSyncJob: vi.fn(),
  runWebAccountsRefreshJob: vi.fn(),
}));

import {
  startInternalJobScheduler,
  withJobLock,
} from "./internal-job-scheduler";

const INTERVAL_MS = 600_000;
const job: Parameters<typeof withJobLock>[0] = {
  name: "regression",
  lockKey: 100,
  intervalSettingKey: "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES",
  defaultIntervalMinutes: 10,
  initialDelayMs: 0,
  run: async () => "ok",
};

/** 返回唯一连接；缺少独立 Client 时立即失败，而非只检查 SQL 字符串。 */
function client() {
  const current = state.clients[0];
  if (!current) throw new Error("scheduler 没有创建独立锁连接");
  return current;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
  vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/scheduler_test");
  state.clients.length = 0;
  state.rows.length = 0;
  state.commits.length = 0;
  state.inTransaction = 0;
  state.transactions = 0;
  state.reads = 0;
  state.allowLock = true;
  vi.resetAllMocks();
  state.enabled.mockResolvedValue(true);
  state.interval.mockResolvedValue(10);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete (globalThis as { __gpt2imageInternalJobScheduler?: unknown })
    .__gpt2imageInternalJobScheduler;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("R20 独立会话锁与状态持久化", () => {
  it("不同 job 的会话锁互不阻塞，状态也按 job 隔离", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = withJobLock(job, INTERVAL_MS, async () => {
      await pending;
      return "first";
    });
    await vi.waitFor(() =>
      expect(state.rows.at(-1)?.value.status).toBe("running")
    );
    const otherJob = { ...job, name: "other-job", lockKey: job.lockKey + 1 };
    await expect(
      withJobLock(otherJob, INTERVAL_MS, async () => "second")
    ).resolves.toMatchObject({
      locked: true,
      skipped: false,
      result: "second",
    });
    expect(client()).toMatchObject({ acquired: true, closed: false });
    expect(state.clients[1]?.closed).toBe(true);
    finish();
    await expect(first).resolves.toMatchObject({ result: "first" });
    expect(
      state.commits.map((row) => [row.value.job, row.value.status])
    ).toEqual([
      [job.name, "running"],
      [otherJob.name, "running"],
      [otherJob.name, "success"],
      [job.name, "success"],
    ]);
  });

  it("在途 run 跨 await 保持会话锁，另一个独立调用拿不到锁", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = withJobLock(job, INTERVAL_MS, async () => {
      await pending;
      return "first";
    });
    await vi.waitFor(() =>
      expect(state.rows.at(-1)?.value.status).toBe("running")
    );
    const secondRun = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, secondRun)).resolves.toEqual({
      locked: false,
    });
    expect(secondRun).not.toHaveBeenCalled();
    expect(state.reads).toBe(1);
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1]?.closed).toBe(true);
    expect(client()).toMatchObject({ acquired: true, closed: false });
    finish();
    await expect(first).resolves.toMatchObject({ result: "first" });
    expect(client()).toMatchObject({ acquired: false, closed: true });
  });

  it("run 期间持有独立会话锁，running 已提交且不持 scheduler 事务", async () => {
    const run = vi.fn(async () => {
      expect(state.inTransaction).toBe(0);
      expect(state.rows.at(-1)?.value.status).toBe("running");
      expect(client()).toMatchObject({
        connected: true,
        acquired: true,
        transactionOpen: false,
        closed: false,
      });
      return "result";
    });
    await expect(withJobLock(job, INTERVAL_MS, run)).resolves.toEqual({
      locked: true,
      skipped: false,
      result: "result",
    });
    expect(state.transactions).toBe(0);
    expect(state.commits.map((row) => row.value.status)).toEqual([
      "running",
      "success",
    ]);
    expect(client().closed).toBe(true);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("任务失败状态持久后上抛，失败开始时间跨调用门控并允许到期重试", async () => {
    const failure = new Error("job failed");
    await expect(
      withJobLock(job, INTERVAL_MS, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(state.rows.at(-1)?.value).toMatchObject({
      status: "error",
      error: "job failed",
      lastStartedAt: new Date().toISOString(),
      lastFinishedAt: new Date().toISOString(),
    });
    expect(state.commits.map((row) => row.value.status)).toEqual([
      "running",
      "error",
    ]);
    expect(client().closed).toBe(true);
    const retry = vi.fn(async () => "retry");
    await expect(withJobLock(job, INTERVAL_MS, retry)).resolves.toMatchObject({
      skipped: true,
      reason: "interval_not_reached",
    });
    expect(retry).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + INTERVAL_MS);
    await expect(withJobLock(job, INTERVAL_MS, retry)).resolves.toMatchObject({
      skipped: false,
      result: "retry",
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(state.clients.every((connection) => connection.closed)).toBe(true);
  });

  it("未获锁不读写状态、不执行任务且关闭独立连接", async () => {
    state.allowLock = false;
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).resolves.toEqual({
      locked: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
    expect(state.commits).toEqual([]);
    expect(client().closed).toBe(true);
  });

  it.each([
    "running",
    "success",
    "error",
  ])("现有 %s 状态均按 lastStartedAt 门控，短路后关闭连接", async (status) => {
    state.rows.push({
      key: "__internal_job_scheduler:regression",
      value: {
        status,
        lastStartedAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).resolves.toMatchObject({
      locked: true,
      skipped: true,
      reason: "interval_not_reached",
    });
    expect(run).not.toHaveBeenCalled();
    expect(state.commits).toEqual([]);
    expect(client().closed).toBe(true);
  });

  it.each([
    "connect",
    "query",
  ] as const)("%s 失败时不启动任务并最终关闭连接", async (phase) => {
    const failure = new Error(`${phase} failed`);
    state[phase].mockRejectedValueOnce(failure);
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
    expect(state.commits).toEqual([]);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("connect 期间的 error 事件被接收，即使 connect resolve 也不得启动任务", async () => {
    state.connect.mockImplementationOnce(async (connection) => {
      connection.emit("error", new Error("socket lost"));
    });
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).rejects.toThrow(
      /connection lost/i
    );
    expect(run).not.toHaveBeenCalled();
    expect(client().closed).toBe(true);
  });

  it("查询获锁时的 error 事件仍失败关闭，不读状态或启动 run", async () => {
    state.query.mockImplementationOnce(async (connection) => {
      connection.emit("error", new Error("socket lost"));
    });
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).rejects.toThrow(
      /connection lost/i
    );
    expect(run).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
    expect(client().closed).toBe(true);
  });

  it("running 写入失败时不启动任务且关闭连接", async () => {
    const failure = new Error("running state unavailable");
    state.commit.mockRejectedValueOnce(failure);
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]);
    expect(client().closed).toBe(true);
  });

  it.each([
    "error",
    "end",
  ])("run 期间连接 %s：等待在途任务收尾，持久化失败且不伪报成功", async (event) => {
    let complete: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let settled = false;
    const outcome = withJobLock(job, INTERVAL_MS, async () => {
      client().emit(event, new Error("socket lost"));
      await pending;
      return "completed after loss";
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() =>
      expect(state.rows.at(-1)?.value.status).toBe("running")
    );
    expect(settled).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
    complete();
    expect(await outcome).toMatchObject({
      message: expect.stringMatching(/connection lost/i),
    });
    expect(state.commits.map((row) => row.value.status)).toEqual([
      "running",
      "error",
    ]);
    expect(client().closed).toBe(true);
    // 清理之后仍保留 error 接收器，防止驱动迟到的异步 error 变成进程未捕获异常。
    expect(() => client().emit("error", new Error("late error"))).not.toThrow();
  });

  it("running 提交期间断线时不执行 run，失败状态仍可提交", async () => {
    state.commit.mockImplementationOnce(async () => {
      client().emit("error", new Error("socket lost"));
    });
    const run = vi.fn();
    await expect(withJobLock(job, INTERVAL_MS, run)).rejects.toThrow(
      /connection lost/i
    );
    expect(run).not.toHaveBeenCalled();
    expect(state.rows.at(-1)?.value.status).toBe("error");
  });

  it("错误状态提交也失败时保留两个失败原因，不声称已落盘", async () => {
    const taskFailure = new Error("job failed");
    const stateFailure = new Error("state write failed");
    state.commit.mockImplementation(async (row) => {
      if (row.value.status === "error") throw stateFailure;
    });
    await expect(
      withJobLock(job, INTERVAL_MS, async () => {
        throw taskFailure;
      })
    ).rejects.toMatchObject({ errors: [taskFailure, stateFailure] });
    expect(state.rows.at(-1)?.value.status).toBe("running");
    expect(client().closed).toBe(true);
  });

  it("任务成功但 success 写入失败时持久化 error 并上抛，未丢失开始时间", async () => {
    const failure = new Error("success state unavailable");
    state.commit.mockImplementation(async (row) => {
      if (row.value.status === "success") throw failure;
    });
    await expect(withJobLock(job, INTERVAL_MS, job.run)).rejects.toBe(failure);
    expect(state.commits.map((row) => row.value.status)).toEqual([
      "running",
      "error",
    ]);
    expect(state.rows.at(-1)?.value).toMatchObject({
      error: "success state unavailable",
      lastStartedAt: new Date().toISOString(),
    });
    expect(client().closed).toBe(true);
  });

  it("持久化数据库任务错误时只记录安全摘要", async () => {
    const error = new DrizzleQueryError(
      "update account set token = $1",
      ["test_scheduler_secret"],
      new Error("socket closed")
    );
    await expect(
      withJobLock(job, INTERVAL_MS, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(state.rows.at(-1)?.value.error).toBe("DatabaseError");
    expect(JSON.stringify(state.rows)).not.toContain("test_scheduler_secret");
  });

  it("连接关闭失败被上抛，任务失败不会被关闭失败覆盖", async () => {
    const taskFailure = new Error("job failed");
    const closeFailure = new Error("close failed");
    state.close.mockRejectedValueOnce(closeFailure);
    await expect(
      withJobLock(job, INTERVAL_MS, async () => {
        throw taskFailure;
      })
    ).rejects.toMatchObject({ errors: [taskFailure, closeFailure] });
    expect(state.rows.at(-1)?.value.status).toBe("error");
  });

  it("正常任务最终 close 失败也上抛；已提交的业务成功状态不回滚", async () => {
    const closeFailure = new Error("close failed");
    state.close.mockRejectedValueOnce(closeFailure);
    await expect(withJobLock(job, INTERVAL_MS, job.run)).rejects.toBe(
      closeFailure
    );
    expect(state.rows.at(-1)?.value.status).toBe("success");
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("close 仅发 error 事件但 Promise resolve 时仍报告关闭失败", async () => {
    state.close.mockImplementationOnce(async (connection) => {
      connection.emit("error", new Error("close emitted error"));
    });
    await expect(withJobLock(job, INTERVAL_MS, job.run)).rejects.toThrow(
      /close failed/i
    );
    expect(state.rows.at(-1)?.value.status).toBe("success");
    expect(client().closed).toBe(true);
  });

  it("Neon 池化域名使用同端点直连 Client，不借 NeonPool", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://test:test@ep-example-pooler.us-east-2.aws.neon.tech/test?sslmode=require"
    );
    await withJobLock(job, INTERVAL_MS, job.run);
    expect(client().driver).toBe("neon");
    expect(new URL(String(client().config.connectionString)).hostname).toBe(
      "ep-example.us-east-2.aws.neon.tech"
    );
    expect(client().closed).toBe(true);
  });

  it("真实定时调度在任务失败后继续门控和调度，Promise 错误由 runJob 消化", async () => {
    vi.stubEnv("NODE_ENV", "development");
    state.dailyStats.mockRejectedValue(new Error("daily stats failed"));
    await startInternalJobScheduler();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.dailyStats).toHaveBeenCalledTimes(1);
    expect(state.rows.at(-1)?.value.status).toBe("error");
    expect(console.warn).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(5);
  });
});
