/**
 * 数据库错误摘要测试（纯函数）。
 *
 * 约束：drizzle 把错误包装成含完整 SQL 与全部参数的 message，导入/同步路径的参数
 * 即明文令牌。对外描述必须只给错误码等结构化信息；"表不存在"判定只认驱动错误码，
 * 不得按消息子串推断（SQL 文本里必然含表名）。
 */

import { describe, expect, it } from "vitest";
import {
  describeErrorForLog,
  hasDatabaseErrorCode,
  PG_UNDEFINED_TABLE,
  summarizeDatabaseError,
} from "./error-summary";

const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.super-secret-access-token";

/** 还原 drizzle-orm 的包装形状：message 带 SQL 与参数，原始错误在 cause。 */
function drizzleError(params: {
  sql: string;
  bindings: string[];
  code?: string;
  constraint?: string;
  table?: string;
}) {
  const cause = Object.assign(new Error("duplicate key value"), {
    code: params.code,
    constraint: params.constraint,
    table: params.table,
  });
  const wrapper = new Error(
    `Failed query: ${params.sql}\nparams: ${params.bindings.join(", ")}`,
    { cause }
  );
  wrapper.name = "DrizzleQueryError";
  return wrapper;
}

describe("summarizeDatabaseError", () => {
  it("沿 cause 链提取错误码、约束与表名", () => {
    const error = drizzleError({
      sql: 'insert into "image_backend_account" ...',
      bindings: [ACCESS_TOKEN],
      code: "23505",
      constraint: "image_backend_account_access_token_hash_unique",
      table: "image_backend_account",
    });
    expect(summarizeDatabaseError(error)).toEqual({
      code: "23505",
      constraint: "image_backend_account_access_token_hash_unique",
      table: "image_backend_account",
      name: "DrizzleQueryError",
    });
  });

  it("非错误对象与循环 cause 都不抛错", () => {
    expect(summarizeDatabaseError("boom")).toEqual({
      code: null,
      constraint: null,
      table: null,
      name: null,
    });
    const loop = new Error("a") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(summarizeDatabaseError(loop).name).toBe("Error");
  });
});

describe("describeErrorForLog", () => {
  it("数据库错误只给结构化摘要，不含 SQL 与参数", () => {
    const error = drizzleError({
      sql: 'insert into "image_backend_account" ("access_token") values ($1)',
      bindings: [ACCESS_TOKEN],
      code: "23505",
      constraint: "image_backend_account_access_token_hash_unique",
    });
    const described = describeErrorForLog(error);
    expect(described).toBe(
      "DrizzleQueryError(code=23505, constraint=image_backend_account_access_token_hash_unique)"
    );
    expect(described).not.toContain(ACCESS_TOKEN);
    expect(described).not.toContain("insert into");
    expect(described).not.toContain("params:");
  });

  it("锁超时等无约束信息的数据库错误仍不回显语句", () => {
    const error = drizzleError({
      sql: 'update "image_backend_account" set "refresh_token" = $1',
      bindings: ["rt_secret_value"],
      code: "55P03",
    });
    const described = describeErrorForLog(error);
    expect(described).toBe("DrizzleQueryError(code=55P03)");
    expect(described).not.toContain("rt_secret_value");
  });

  it("非数据库错误保留原始信息便于排查", () => {
    expect(describeErrorForLog(new Error("upstream refused"))).toBe(
      "upstream refused"
    );
    expect(describeErrorForLog("plain string")).toBe("plain string");
  });
});

describe("hasDatabaseErrorCode", () => {
  it("按驱动错误码识别表不存在", () => {
    const missingTable = drizzleError({
      sql: 'select * from "image_backend_inflight_lease"',
      bindings: [],
      code: PG_UNDEFINED_TABLE,
    });
    expect(hasDatabaseErrorCode(missingTable, PG_UNDEFINED_TABLE)).toBe(true);
  });

  it("语句超时不因 SQL 含表名而被误判为表不存在", () => {
    const timeout = drizzleError({
      sql: 'delete from "image_backend_inflight_lease" where "expires_at" < $1',
      bindings: ["2026-10-24T00:00:00.000Z"],
      code: "57014",
    });
    expect(hasDatabaseErrorCode(timeout, PG_UNDEFINED_TABLE)).toBe(false);
  });

  it("无错误码的连接中断同样不被误判", () => {
    const disconnect = new Error(
      'Failed query: insert into "image_backend_inflight_lease" ...'
    );
    disconnect.name = "DrizzleQueryError";
    expect(hasDatabaseErrorCode(disconnect, PG_UNDEFINED_TABLE)).toBe(false);
  });
});
