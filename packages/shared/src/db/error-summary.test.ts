/**
 * 数据库错误摘要测试（纯函数）。
 *
 * 约束：drizzle 把错误包装成含完整 SQL 与全部参数的 message，导入/同步路径的参数
 * 即明文令牌。对外描述必须只给错误码等结构化信息；"表不存在"判定只认驱动错误码，
 * 不得按消息子串推断（SQL 文本里必然含表名）。
 */

import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import {
  describeErrorForLog,
  hasDatabaseErrorCode,
  PG_UNDEFINED_TABLE,
  summarizeDatabaseError,
} from "./error-summary";

const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.super-secret-access-token";

/**
 * 用 drizzle-orm 真实的 DrizzleQueryError 构造错误。
 *
 * 不手搓包装对象：真实实现不设置 this.name（实例 name 为 "Error"），手搓时若顺手
 * 补上 name 会掩盖"按 name 判定失效"这一真实缺陷。
 */
function drizzleError(params: {
  sql: string;
  bindings: string[];
  code?: string;
  constraint?: string;
  table?: string;
}) {
  const cause = Object.assign(new Error("duplicate key value"), {
    ...(params.code === undefined ? {} : { code: params.code }),
    ...(params.constraint === undefined
      ? {}
      : { constraint: params.constraint }),
    ...(params.table === undefined ? {} : { table: params.table }),
  });
  return new DrizzleQueryError(params.sql, params.bindings, cause);
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
      // 真实 DrizzleQueryError 不设置 name，实例 name 即 "Error"。
      name: "Error",
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
      "DatabaseError(code=23505, constraint=image_backend_account_access_token_hash_unique)"
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
    expect(described).toBe("DatabaseError(code=55P03)");
    expect(described).not.toContain("rt_secret_value");
  });

  it("底层驱动没有错误码时（断连）仍不回显 SQL 与参数", () => {
    // 连接被对端关闭、取连接超时等失败的 cause 不带 code；此时只能靠 drizzle 包装层
    // 自身特征识别，否则会回退成原样返回 message。
    const error = drizzleError({
      sql: 'insert into "image_backend_account" ("access_token") values ($1)',
      bindings: [ACCESS_TOKEN],
    });
    expect((error as Error).name).toBe("Error");
    const described = describeErrorForLog(error);
    expect(described).toBe("DatabaseError");
    expect(described).not.toContain(ACCESS_TOKEN);
    expect(described).not.toContain("insert into");
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
    const disconnect = drizzleError({
      sql: 'insert into "image_backend_inflight_lease" ("id") values ($1)',
      bindings: ["lease-1"],
    });
    expect(hasDatabaseErrorCode(disconnect, PG_UNDEFINED_TABLE)).toBe(false);
  });
});
