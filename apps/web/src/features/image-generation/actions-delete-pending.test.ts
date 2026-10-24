/**
 * 删除动作不得删除 pending 任务：它可能仍在执行，或首笔扣费结果未知、正等待超时清扫
 * 按行内额度退款；删除后清扫看不到它，已入账的扣费从此无人退回。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  selectCalls: 0,
  deletes: [] as unknown[],
  storageDeletes: [] as string[],
}));

vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        // 第一次查询取待删记录；之后查“本用户其他记录”以排除共享存储，这里为空。
        where: () => {
          const result = state.selectCalls++ === 0 ? state.rows : [];
          return Object.assign(Promise.resolve(result), {
            limit: async () => result.slice(0, 1),
          });
        },
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        state.deletes.push(condition);
      },
    }),
  },
}));
vi.mock("@repo/shared/safe-action", () => ({
  protectedAction: {
    metadata: () => {
      const action =
        (run: (value: unknown) => Promise<unknown>) => (parsedInput: unknown) =>
          run({ parsedInput, ctx: { userId: "owner-1" } });
      return { action, schema: () => ({ action }) };
    },
  },
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({
    deleteObject: async (key: string) => {
      state.storageDeletes.push(key);
    },
  }),
}));
vi.mock("./operations", () => ({ runImageGenerationForUser: vi.fn() }));

import { batchDeleteGenerationAction, deleteGenerationAction } from "./actions";

function row(id: string, status: string) {
  return {
    id,
    userId: "owner-1",
    status,
    storageKey: `owner-1/${id}.png`,
    storageBucket: "generations",
    metadata: {},
  };
}

/** 把 Drizzle 条件渲染为 SQL 文本，确认删除语句本身也排除 pending。 */
function sqlText(condition: unknown) {
  return new PgDialect().sqlToQuery(condition as SQL).sql;
}

beforeEach(() => {
  state.rows = [];
  state.selectCalls = 0;
  state.deletes = [];
  state.storageDeletes = [];
});

describe("删除 pending 任务", () => {
  it("单条删除拒绝 pending 任务，不删除存储对象也不执行删除语句", async () => {
    state.rows = [row("g-pending", "pending")];
    expect(await deleteGenerationAction({ generationId: "g-pending" })).toEqual(
      { error: "Generation is still in progress" }
    );
    expect(state.deletes).toHaveLength(0);
    expect(state.storageDeletes).toHaveLength(0);
  });

  it("单条删除终态任务时，删除语句仍附带非 pending 条件", async () => {
    state.rows = [row("g-done", "completed")];
    expect(await deleteGenerationAction({ generationId: "g-done" })).toEqual({
      success: true,
    });
    expect(state.deletes).toHaveLength(1);
    expect(sqlText(state.deletes[0])).toContain('"status" <> $');
  });

  it("批量删除跳过 pending 行，只删除终态行并返回跳过数量", async () => {
    state.rows = [row("g-pending", "pending"), row("g-failed", "failed")];
    expect(
      await batchDeleteGenerationAction({
        generationIds: ["g-pending", "g-failed"],
      })
    ).toEqual({ success: true, deletedCount: 1, skippedPendingCount: 1 });
    expect(state.storageDeletes).toEqual(["owner-1/g-failed.png"]);
    expect(sqlText(state.deletes[0])).toContain('"status" <> $');
  });

  it("批量删除全为 pending 时不执行删除语句", async () => {
    state.rows = [row("g-pending", "pending")];
    expect(
      await batchDeleteGenerationAction({ generationIds: ["g-pending"] })
    ).toEqual({ success: true, deletedCount: 0, skippedPendingCount: 1 });
    expect(state.deletes).toHaveLength(0);
  });
});
