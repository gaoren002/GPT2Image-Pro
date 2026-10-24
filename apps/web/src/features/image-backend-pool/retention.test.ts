/** R44 的 DB-free 回归：真实 Drizzle SQL 编译与有界调度；执行计划由真实 PG 验收。 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildPoolRetentionStatements,
  cleanupImageBackendRetention,
} from "./retention";

const dialect = new PgDialect();
const now = new Date("2026-10-25T12:34:56.000Z");

describe("pool retention", () => {
  it("按现有时间索引字段筛选并排序，带 LIMIT 与 SKIP LOCKED，删除时重验截止时间", () => {
    const statements = buildPoolRetentionStatements({ now });
    for (const [index, query] of statements.entries()) {
      const compiled = dialect.sqlToQuery(query);
      const field = index === 0 ? "expires_at" : "bucket_started_at";
      expect(compiled.sql).toMatch(/limit \$\d+ for update skip locked/i);
      expect(compiled.sql).toMatch(
        new RegExp(`order by "[^"]+"."${field}"`, "i")
      );
      expect(
        compiled.sql.match(new RegExp(`"${field}" <[=]?`, "g"))
      ).toHaveLength(2);
      expect(compiled.params).toContain(500);
      expect(compiled.sql).not.toMatch(/offset|count\(|begin|truncate/i);
    }
    expect(dialect.sqlToQuery(statements[0] as SQL).params).toContain(
      "2026-10-25T12:34:56.000Z"
    );
    expect(dialect.sqlToQuery(statements[1] as SQL).params).toContain(
      "2026-09-25T12:00:00.000Z"
    );
  });

  it("每表到预算即停止，不把历史积压放进一个长事务", async () => {
    const queries: SQL[] = [];
    const result = await cleanupImageBackendRetention(
      { now, batchSize: 10, maxBatches: 2 },
      async (query) => {
        queries.push(query);
        return { rowCount: 10 };
      }
    );
    expect(queries).toHaveLength(4);
    expect(result).toEqual({ stickyDeleted: 20, metricsDeleted: 20 });
  });

  it("空批立即停止；少量旧指标不动最近历史", async () => {
    let calls = 0;
    const result = await cleanupImageBackendRetention({ now }, async () => ({
      rowCount: ++calls === 1 ? 0 : 2,
    }));
    expect(calls).toBe(2);
    expect(result).toEqual({ stickyDeleted: 0, metricsDeleted: 2 });
  });

  it("缺表按错误码兼容，真实故障不能伪装清理成功", async () => {
    let calls = 0;
    expect(
      await cleanupImageBackendRetention({ now }, async () => {
        if (++calls === 1)
          throw new Error("wrapped", {
            cause: Object.assign(new Error("missing"), { code: "42P01" }),
          });
        return { rowCount: 0 };
      })
    ).toEqual({ stickyDeleted: 0, metricsDeleted: 0 });
    await expect(
      cleanupImageBackendRetention({ now }, async () => {
        throw Object.assign(new Error("timeout"), { code: "57014" });
      })
    ).rejects.toThrow("timeout");
  });

  it.each([
    { batchSize: 0 },
    { batchSize: 1001 },
    { batchSize: NaN },
    { maxBatches: 11 },
    { metricsRetentionDays: 0 },
    { now: new Date(NaN) },
  ])("非法维护参数在执行前拒绝: %j", async (options) => {
    let calls = 0;
    await expect(
      cleanupImageBackendRetention(options, async () => {
        calls++;
        return { rowCount: 0 };
      })
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
