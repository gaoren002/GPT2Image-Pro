/**
 * 独立会话级 advisory 锁，供内部 scheduler 使用；不导入 db、不创建或借用应用 Pool。
 * pg/Neon Client 只负责持锁，调用体可通过全局 db 独立提交；最终关闭会话释放锁。
 */
import { Client as NeonClient, neonConfig } from "@neondatabase/serverless";
import { Client } from "pg";
import { buildPgPoolConfig } from "./pool-config";

/**
 * 用独立数据库会话尝试持锁并运行调用体；未获锁不执行 run。
 *
 * assertHeld 检查已观察到的连接 error/end，不抛出事件本身，避免未捕获 error。
 * 连接丢失时不会 race/遗弃仍在运行的 Promise：必须等 run 收尾后才返回或上抛。
 * 边界：无法取消调用体已开始的副作用；静默网络分区可能延迟检测，断线后也无法阻止
 * 其他进程重新获锁。严格的故障期互斥需要任务支持 fencing，不可把本锁视为 exactly-once。
 *
 * DATABASE_URL 须指向真实数据库或 session-mode 代理；Neon 的 -pooler 域名会切换为
 * 同端点直连域名，因为 transaction-mode PgBouncer 不保证会话锁的后端归属。
 * 锁查询和建连有超时；任务本身不设新的执行时限，不改变其业务重试/结算政策。
 */
export async function withSessionAdvisoryLock<T>(
  namespace: number,
  key: number,
  run: (assertHeld: () => void) => Promise<T>
): Promise<{ locked: false } | { locked: true; value: T }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL 环境变量未设置");
  const url = new URL(databaseUrl);
  const isNeon = url.hostname.endsWith(".neon.tech");
  if (isNeon) {
    url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");
    if (typeof process !== "undefined" && process.versions?.node) {
      neonConfig.webSocketConstructor = require("ws");
    }
  }
  const { connectionTimeoutMillis } = buildPgPoolConfig(databaseUrl);
  const config = {
    connectionString: url.toString(),
    connectionTimeoutMillis,
    query_timeout: connectionTimeoutMillis,
    keepAlive: true,
  };
  // 两个驱动的 query 重载不同，只声明此处实际使用的共同接口，避免不安全类型断言。
  const client: {
    connect(): Promise<unknown>;
    query(
      text: string,
      values: number[]
    ): Promise<{ rows: { locked: unknown }[] }>;
    on(event: "error" | "end", listener: () => void): unknown;
    end(): Promise<void>;
  } = isNeon ? new NeonClient(config) : new Client(config);
  let connectionLost = false;
  let closing = false;
  let closeFailed = false;
  let failed = false;
  let failure: unknown;
  let outcome: { locked: false } | { locked: true; value: T } = {
    locked: false,
  };

  /** 只设置状态，不从 EventEmitter 回调抛错，也不保留可能含连接细节的驱动错误。 */
  const onError = () => {
    if (closing) closeFailed = true;
    else connectionLost = true;
  };
  /** 调用者在状态提交/任务执行的 await 边界复查，已断线时禁止继续或写 success。 */
  const assertHeld = () => {
    if (connectionLost) {
      throw new Error("Advisory lock connection lost");
    }
  };
  // 必须在 connect 前注册；关闭后也保留 error 接收器，接住驱动迟到的异步 error。
  client.on("error", onError);
  client.on("end", () => {
    if (!closing) connectionLost = true;
  });
  try {
    await client.connect();
    assertHeld();
    const result = await client.query(
      "select pg_try_advisory_lock($1, $2) as locked",
      [namespace, key]
    );
    assertHeld();
    if (result.rows[0]?.locked === true) {
      const value = await run(assertHeld);
      assertHeld();
      outcome = { locked: true, value };
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // 所有连接/持锁/执行结果均经过关闭；关闭会话让数据库释放锁。
  // 先保存结果再清理，避免 finally 的 throw 覆盖任务的原始失败。
  closing = true;
  try {
    await client.end();
    if (closeFailed) throw new Error("Advisory lock session close failed");
  } catch (closeError) {
    failure = failed
      ? new AggregateError(
          [failure, closeError],
          "Job execution and advisory lock session close failed"
        )
      : closeError;
    failed = true;
  }
  if (failed) throw failure;
  return outcome;
}
