/** 数据库连接错误事件边界；查询 Promise 仍由调用方处理，事件日志不得包含 SQL/参数。 */
import type { EventEmitter } from "node:events";

const observed = new WeakSet<object>();
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

/** 只记录驱动错误码，避免断连时包装错误中的查询、参数或连接凭据进入日志。 */
function reportConnectionError(error: unknown): void {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  console.warn("Database connection error", {
    code:
      typeof code === "string" &&
      (/^[0-9A-Z]{5}$/.test(code) || networkCodes.has(code))
        ? code
        : "UNKNOWN",
  });
}

/** 安装连接池及借出连接的错误监听；不重试查询，也不改变事务失败语义。 */
export function observePoolErrors(pool: Pick<EventEmitter, "on">): void {
  if (observed.has(pool)) return;
  observed.add(pool);
  pool.on("error", reportConnectionError);
  // pg 在借出连接时移除 idle listener；活跃查询失败后可能还有独立的断连事件。
  // 只监听 pool 无法覆盖这个窗口，必须从新连接创建起保留 client listener。
  pool.on("connect", (client: unknown) => {
    if (
      !client ||
      typeof client !== "object" ||
      !("on" in client) ||
      typeof client.on !== "function" ||
      observed.has(client)
    )
      return;
    observed.add(client);
    client.on("error", reportConnectionError);
  });
}
