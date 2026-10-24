/** R35 终态补扣 guard：真实 core/Drizzle 验证围栏先于幂等快路；锁等待另由隔离真实 PG 验收。 */
import { beforeEach, expect, it, vi } from "vitest";
import { ConsumptionDatabase } from "./test-support/consumption-db";

const runtime = vi.hoisted(() => ({ database: {} as object }));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value: unknown = Reflect.get(runtime.database, key);
        return typeof value === "function"
          ? value.bind(runtime.database)
          : value;
      },
    }
  ),
}));
vi.mock("../system-settings", () => ({
  getRuntimeSettingNumber: async () => 0,
}));
vi.mock("../logger/index", () => ({ logEvent: vi.fn() }));
import { consumeCredits } from "./core";

/** 仅增加 generation SELECT 与隔离级别 SQL；资金写集/回滚仍用既有消费驱动。 */
class SettlementDatabase extends ConsumptionDatabase {
  row = {
    id: "g1",
    user_id: "u1",
    status: "pending",
    metadata: { asyncCompletion: { version: 1, state: "settling" } },
  };
  client(id: number) {
    const base = super.client(id);
    return {
      query: async (
        config: { text: string; rowMode?: string },
        values: unknown[] = []
      ) => {
        const { text } = config;
        if (
          text.startsWith("set transaction") ||
          text.includes("pg_advisory_xact_lock")
        ) {
          this.queries.push({ client: id, text, values });
          return { rows: [] };
        }
        if (text.includes('from "generation"')) {
          this.queries.push({ client: id, text, values });
          expect(text).toContain("for update");
          const rows =
            values[0] === this.row.id && values[1] === this.row.user_id
              ? [this.row]
              : [];
          return this.response(config, rows);
        }
        return base.query(config, values);
      },
    };
  }
}

let ledger: SettlementDatabase;
const request = {
  userId: "u1",
  amount: 25,
  serviceName: "image-generation",
  externalApiKeyId: "k1",
  sourceRef: "g1:image-actual-size:charge",
  metadata: { generationId: "g1" },
  generationSettlement: { generationId: "g1" },
};
beforeEach(() => {
  ledger = new SettlementDatabase();
  runtime.database = ledger.database();
});

it("settling 先拿任务锁与行锁，再原子 capture 钱包和 Key", async () => {
  await consumeCredits(request);
  const fenced = ledger.queries.findIndex(({ text }) =>
    text.includes('from "generation"')
  );
  const money = ledger.queries.findIndex(({ text }) =>
    text.startsWith('update "credits_batch"')
  );
  expect(fenced).toBeGreaterThan(0);
  expect(money).toBeGreaterThan(fenced);
  expect(ledger.wallets.get("u1")?.balance).toBe(975);
  expect(ledger.keys.get("k1")?.credits_used).toBe(25);
  expect(ledger.entries).toHaveLength(1);
});

it.each([
  "failed",
  "completed",
])("%s 围栏先于已有消费的幂等回放，不能放行迟到补扣", async (status) => {
  await consumeCredits(request);
  ledger.row.status = status;
  await expect(consumeCredits(request)).rejects.toMatchObject({
    code: "generation_settlement_closed",
  });
  expect(ledger.wallets.get("u1")?.balance).toBe(975);
  expect(ledger.keys.get("k1")?.credits_used).toBe(25);
  expect(ledger.entries).toHaveLength(1);
});

it("错误归属或非 settling marker 拒绝资金写入", async () => {
  ledger.row.user_id = "other";
  await expect(consumeCredits(request)).rejects.toMatchObject({
    code: "generation_settlement_closed",
  });
  ledger.row.user_id = "u1";
  ledger.row.metadata.asyncCompletion.state = "ready";
  await expect(consumeCredits(request)).rejects.toMatchObject({
    code: "generation_settlement_closed",
  });
  expect(ledger.wallets.get("u1")?.balance).toBe(1000);
  expect(ledger.keys.get("k1")?.credits_used).toBe(0);
  expect(ledger.entries).toHaveLength(0);
});
