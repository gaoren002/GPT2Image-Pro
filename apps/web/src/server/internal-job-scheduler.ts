/** 内置任务调度：独立会话持锁、全局 db 短提交状态；任务不处于 scheduler 事务内。 */
import { db, systemSetting } from "@repo/database";
import { withSessionAdvisoryLock } from "@repo/database/session-advisory-lock";
import { describeErrorForLog } from "@repo/shared/db/error-summary";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
} from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";

import { runGenerationDailyStatsJob } from "./generation-daily-stats";
import { startInstanceCacheMaintenance } from "./instance-cache-maintenance";
import {
  runCreditsExpireJob,
  runImageMaintenanceJob,
  runSub2ApiSyncJob,
  runWebAccountsRefreshJob,
} from "./scheduled-jobs";

type InternalJob = {
  name: string;
  lockKey: number;
  intervalSettingKey:
    | "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES"
    | "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES"
    | "INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES"
    | "INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES"
    | "INTERNAL_JOB_GENERATION_DAILY_STATS_INTERVAL_MINUTES";
  defaultIntervalMinutes: number;
  initialDelayMs: number;
  run: () => Promise<unknown>;
};

type SchedulerState = {
  started: boolean;
};

type SchedulerGlobal = typeof globalThis & {
  __gpt2imageInternalJobScheduler?: SchedulerState;
};

const LOCK_NAMESPACE = 20_260_527;
const MINUTE_MS = 60 * 1000;
const schedulerGlobal = globalThis as SchedulerGlobal;

const jobs: InternalJob[] = [
  {
    name: "images-maintenance",
    lockKey: 1,
    intervalSettingKey: "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES",
    defaultIntervalMinutes: 5,
    initialDelayMs: 30_000,
    run: runImageMaintenanceJob,
  },
  {
    name: "credits-expire",
    lockKey: 2,
    intervalSettingKey: "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES",
    defaultIntervalMinutes: 24 * 60,
    initialDelayMs: 60_000,
    run: runCreditsExpireJob,
  },
  {
    name: "web-accounts-refresh",
    lockKey: 3,
    intervalSettingKey: "INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES",
    defaultIntervalMinutes: 10,
    initialDelayMs: 90_000,
    run: runWebAccountsRefreshJob,
  },
  {
    name: "sub2api-sync",
    lockKey: 4,
    intervalSettingKey: "INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES",
    defaultIntervalMinutes: 10,
    initialDelayMs: 120_000,
    run: () => runSub2ApiSyncJob(),
  },
  {
    // 全局状态页"全站累计"的按日汇总:补齐新结算日期 + 轮转重算旧日期。首次运行
    // 全量回填约 40 秒;初始延迟短于其他任务,让新部署尽早脱离全表聚合的慢路径。
    name: "generation-daily-stats",
    lockKey: 5,
    intervalSettingKey: "INTERNAL_JOB_GENERATION_DAILY_STATS_INTERVAL_MINUTES",
    defaultIntervalMinutes: 10,
    initialDelayMs: 20_000,
    run: () => runGenerationDailyStatsJob(),
  },
];

function getSchedulerState() {
  if (!schedulerGlobal.__gpt2imageInternalJobScheduler) {
    schedulerGlobal.__gpt2imageInternalJobScheduler = {
      started: false,
    };
  }
  return schedulerGlobal.__gpt2imageInternalJobScheduler;
}

function getJobStateKey(job: InternalJob) {
  return `__internal_job_scheduler:${job.name}`;
}

function readLastStartedAt(value: unknown) {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).lastStartedAt
      : undefined;
  if (typeof candidate !== "string") return undefined;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** 单条 upsert 独立提交状态，不与任务的事务或锁连接绑定。 */
async function writeJobState(
  job: InternalJob,
  state: {
    status: "running" | "success" | "error";
    lastStartedAt: string;
    lastFinishedAt?: string;
    error?: string;
  }
) {
  const value = { job: job.name, ...state };
  const updatedAt = new Date();
  await db
    .insert(systemSetting)
    .values({ key: getJobStateKey(job), value, isSecret: false, updatedAt })
    .onConflictDoUpdate({
      target: systemSetting.key,
      set: { value, isSecret: false, updatedAt },
    });
}

/**
 * 持独立会话锁检查间隔并执行任务；状态通过全局 db 单条提交。
 * running 提交后才启动 run，任务失败则先提交 error 再上抛，不回滚已经完成的业务步骤。
 * 断线检查只覆盖已观察到的事件，无法撤回任务副作用或保证断线期间的跨进程互斥。
 */
export async function withJobLock<T>(
  job: InternalJob,
  intervalMs: number,
  run: () => Promise<T>
) {
  const locked = await withSessionAdvisoryLock(
    LOCK_NAMESPACE,
    job.lockKey,
    async (assertHeld) => {
      const [state] = await db
        .select({ value: systemSetting.value })
        .from(systemSetting)
        .where(eq(systemSetting.key, getJobStateKey(job)))
        .limit(1);
      assertHeld();
      const now = new Date();
      const lastStartedAt = readLastStartedAt(state?.value);
      if (
        lastStartedAt !== undefined &&
        now.getTime() - lastStartedAt < intervalMs
      ) {
        return { skipped: true as const, reason: "interval_not_reached" };
      }

      const lastStarted = now.toISOString();
      await writeJobState(job, {
        status: "running",
        lastStartedAt: lastStarted,
      });
      try {
        assertHeld();
        const result = await run();
        assertHeld();
        await writeJobState(job, {
          status: "success",
          lastStartedAt: lastStarted,
          lastFinishedAt: new Date().toISOString(),
        });
        assertHeld();
        return { skipped: false as const, result };
      } catch (error) {
        try {
          await writeJobState(job, {
            status: "error",
            lastStartedAt: lastStarted,
            lastFinishedAt: new Date().toISOString(),
            error: describeErrorForLog(error),
          });
        } catch (stateError) {
          // 状态库也不可用时不能声称失败已落盘；保留任务和写状态两个独立失败。
          throw new AggregateError(
            [error, stateError],
            "Internal job failed and error state could not be saved"
          );
        }
        throw error;
      }
    }
  );
  return locked.locked ? { locked: true as const, ...locked.value } : locked;
}

async function getIntervalMs(job: InternalJob) {
  const minutes = await getRuntimeSettingNumber(
    job.intervalSettingKey,
    job.defaultIntervalMinutes,
    { positive: true }
  );
  return Math.max(1, Math.trunc(minutes)) * MINUTE_MS;
}

async function runJob(job: InternalJob) {
  const startedAt = Date.now();
  try {
    const enabled = await getRuntimeSettingBoolean(
      "INTERNAL_JOB_SCHEDULER_ENABLED",
      true
    );
    if (!enabled) return;
    const intervalMs = await getIntervalMs(job);
    const result = await withJobLock(job, intervalMs, job.run);
    if (!result.locked) return;
    if (result.skipped) return;
    console.info(
      `[internal-jobs] ${job.name} completed in ${Date.now() - startedAt}ms`
    );
  } catch (error) {
    console.warn(
      `[internal-jobs] ${job.name} failed`,
      describeErrorForLog(error)
    );
  }
}

async function scheduleJob(job: InternalJob) {
  let running = false;

  const scheduleNext = (delayMs: number) => {
    const timer = setTimeout(() => {
      // 最外层兜底捕获 tick 的意外失败，不留下无人接收的 Promise rejection。
      void tick().catch((error: unknown) => {
        console.warn(
          `[internal-jobs] ${job.name} tick failed`,
          describeErrorForLog(error)
        );
      });
    }, delayMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (running) {
      scheduleNext(await getIntervalMs(job));
      return;
    }

    running = true;
    try {
      await runJob(job);
    } finally {
      running = false;
    }

    try {
      scheduleNext(await getIntervalMs(job));
    } catch {
      scheduleNext(job.defaultIntervalMinutes * MINUTE_MS);
    }
  };

  scheduleNext(job.initialDelayMs);
}

export async function startInternalJobScheduler() {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // 本地磁盘的回收必须在每个实例执行，不能由全站单例锁或 DB 调度开关抑制。
  startInstanceCacheMaintenance();

  const state = getSchedulerState();
  if (state.started) return;

  try {
    const enabled = await getRuntimeSettingBoolean(
      "INTERNAL_JOB_SCHEDULER_ENABLED",
      true
    );
    if (!enabled) return;

    state.started = true;
    await Promise.all(jobs.map((job) => scheduleJob(job)));
    console.info("[internal-jobs] scheduler started");
  } catch (error) {
    state.started = false;
    console.warn(
      "[internal-jobs] scheduler failed to start",
      describeErrorForLog(error)
    );
  }
}
