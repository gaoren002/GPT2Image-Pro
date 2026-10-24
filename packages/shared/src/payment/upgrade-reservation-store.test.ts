/** R08 SQL 归属回归：编译真实 Drizzle WHERE，避免原始 OR 脱离 user_id 约束。 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ predicate: null as unknown }));
vi.mock("@repo/database", () => ({
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const select = {
        from: () => select,
        where: (condition: unknown) => {
          state.predicate = condition;
          return select;
        },
        limit: () => select,
        for: async () => [],
      };
      return run({ execute: async () => {}, select: () => select });
    },
  },
}));

import { upgradeStore } from "./upgrade-reservation-store";

describe("upgrade store owner predicate", () => {
  it("groups held OR refund_pending under the same user predicate", async () => {
    expect(
      await upgradeStore.transaction("tenant-b", (tx) => tx.getHeld())
    ).toBeNull();
    const query = new PgDialect().sqlToQuery(state.predicate as SQL);
    expect(query.params).toEqual(["tenant-b"]);
    expect(query.sql.replaceAll(/\s+/g, " ")).toBe(
      `("upgrade_reservation"."user_id" = $1 and ("upgrade_reservation"."state" = 'held' OR ("upgrade_reservation"."state" = 'refund_pending' AND "upgrade_reservation"."settled_at" IS NOT NULL)))`
    );
  });
});
