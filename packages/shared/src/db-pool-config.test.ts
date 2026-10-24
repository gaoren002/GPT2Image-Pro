/**
 * 数据库连接池参数测试（纯函数，DB-free）。
 *
 * 约束：标准 pg 连接池必须设置取连接超时，避免池占满时请求无限排队、
 * 循环等待导致整站数据库访问永久挂起；可选超时默认关闭，按部署显式开启。
 */

import {
  buildPgPoolConfig,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
} from "@repo/database/pool-config";
import { describe, expect, it } from "vitest";

const URL = "postgres://user:pass@127.0.0.1:5432/db";

describe("buildPgPoolConfig", () => {
  it("默认设置有限的取连接超时，池大小保持 pg 默认值", () => {
    const config = buildPgPoolConfig(URL, {});
    expect(config.connectionString).toBe(URL);
    expect(config.max).toBe(DEFAULT_POOL_MAX);
    expect(config.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.statement_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBeUndefined();
  });

  it("按环境变量覆盖池大小与各项超时", () => {
    const config = buildPgPoolConfig(URL, {
      DATABASE_POOL_MAX: "25",
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_STATEMENT_TIMEOUT_MS: "60000",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "120000",
    });
    expect(config.max).toBe(25);
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.statement_timeout).toBe(60000);
    expect(config.idle_in_transaction_session_timeout).toBe(120000);
  });

  it("非法或非正值回落默认，不会把超时关成 0（无限等待）", () => {
    const config = buildPgPoolConfig(URL, {
      DATABASE_POOL_MAX: "0",
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: "-1",
      DATABASE_STATEMENT_TIMEOUT_MS: "abc",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: " ",
    });
    expect(config.max).toBe(DEFAULT_POOL_MAX);
    expect(config.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(config.statement_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBeUndefined();
  });
});
