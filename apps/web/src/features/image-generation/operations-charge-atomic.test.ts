/**
 * 生图扣费闭包的原子性与结果未知处理。
 *
 * 从 operations.ts 抽取真实的 chargeAdditionalCredits 闭包，配真实 consumeCredits
 * 与受控 Drizzle 驱动运行；退款用真实 submitGenerationRefund。无上游、存储或网络。
 * 受控驱动以会话编号区分事务连接（>0）与全局自动提交连接（0），据此断言 Key
 * 额度只在消费事务内变动。
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";
import { ConsumptionDatabase } from "../../../../../packages/shared/src/credits/test-support/consumption-db";
import { ControlledLedger } from "../../../../../packages/shared/src/credits/test-support/generation-refund-db";
import { submitGenerationRefund } from "../../../../../packages/shared/src/generation-refund-outbox";

const state = vi.hoisted(() => ({ db: {} as object }));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(state.db, key);
        return typeof value === "function" ? value.bind(state.db) : value;
      },
    }
  ),
}));
vi.mock("@repo/shared/logger", () => ({
  logEvent: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
}));

import { consumeCredits } from "@repo/shared/credits/core";
import {
  GENERATION_TASK_REUSED_CODE,
  isDefinitiveChargeRejection,
  planChargeSettlement,
} from "@repo/shared/credits/charge-outcome";
import { roundCreditAmount } from "./resolution";

type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };

/**
 * 在受控消费库上增加两种故障注入：全局连接上的 Key UPDATE 按自动提交立即生效
 * （用于捕获回归到独立预留的写法），以及真实 COMMIT 之后丢失确认。
 */
class ChargeDatabase extends ConsumptionDatabase {
  loseAck = false;
  private autoClient = -100;

  client(id: number) {
    const base = super.client(id);
    let consumed = false;
    return {
      query: async (query: Query, values: unknown[] = []) => {
        if (id === 0 && query.text.startsWith('update "external_api_key"')) {
          const auto = super.client(--this.autoClient);
          await auto.query({ text: "begin" });
          const result = await auto.query(query, values);
          await auto.query({ text: "commit" });
          return result;
        }
        if (query.text.startsWith('insert into "credits_transaction"'))
          consumed = true;
        const result = await base.query(query, values);
        if (query.text === "commit" && consumed && this.loseAck) {
          this.loseAck = false;
          throw new Error("Controlled real commit ACK loss");
        }
        return result;
      },
    };
  }
}

let ledger: ChargeDatabase;
beforeEach(() => {
  ledger = new ChargeDatabase();
  state.db = ledger.database();
});

type ChargeClosure = {
  charge: (
    amount: number,
    serviceName: string,
    description: string,
    metadata: Row,
    sourceRef: string
  ) => Promise<void>;
  state: () => { chargedCredits: number; unconfirmedCredits: number };
};

/**
 * 抽取 operations.ts 中唯一的 chargeAdditionalCredits 声明，按其自由变量注入依赖。
 * apiKeyId 传 null 表示会话请求（无 Key）。
 */
function chargeClosure(apiKeyId: string | null = "k1"): ChargeClosure {
  const contents = readFileSync(
    new URL("./operations.ts", import.meta.url),
    "utf8"
  );
  const file = ts.createSourceFile(
    "operations.ts",
    contents,
    ts.ScriptTarget.Latest,
    true
  );
  let declaration = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "chargeAdditionalCredits"
    ) {
      if (declaration) throw new Error("Ambiguous charge boundary");
      declaration = node.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!declaration) throw new Error("Charge boundary not found");
  const bindings = {
    input: {
      userId: "u1",
      apiKeyId: apiKeyId ?? undefined,
      asyncDelivery: false,
    },
    generationId: "normal-task",
    relayOnly: false,
    relayInitialCapture: undefined,
    billingPolicy: { chargesCredits: true },
    roundCreditAmount,
    consumeCredits,
    isDefinitiveChargeRejection,
    GENERATION_TASK_REUSED_CODE,
    PURE_RELAY_CREDIT_DESCRIPTION: "Pure relay generation charge",
  };
  const code = ts.transpileModule(
    `let chargedCredits = 0;
let unconfirmedCredits = 0;
const ${declaration};
return {
  charge: chargeAdditionalCredits,
  state: () => ({ chargedCredits, unconfirmedCredits }),
};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }
  ).outputText;
  return new Function(...Object.keys(bindings), code)(
    ...Object.values(bindings)
  ) as ChargeClosure;
}

function request(
  closure: ChargeClosure,
  amount = 10,
  sourceRef = "normal-task:charge"
) {
  return closure.charge(
    amount,
    "image-generation",
    "Normal synthetic charge",
    { generationId: "normal-task" },
    sourceRef
  );
}

function snapshot() {
  return {
    wallet: ledger.wallets.get("u1"),
    keys: [...ledger.keys],
    entries: ledger.entries,
    batches: [...ledger.batches],
  };
}

function keyUpdates() {
  return ledger.queries.filter((query) =>
    query.text.startsWith('update "external_api_key"')
  );
}

it("首笔扣费的钱包与 Key 在同一消费事务内提交", async () => {
  const closure = chargeClosure();
  await request(closure);
  expect(ledger.wallets.get("u1")?.balance).toBe(990);
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  expect(ledger.entries).toHaveLength(1);
  expect(
    (ledger.entries[0]?.metadata as Row | undefined)?.externalApiKeyId
  ).toBe("k1");
  expect(keyUpdates().length).toBeGreaterThan(0);
  expect(keyUpdates().every((query) => query.client > 0)).toBe(true);
  expect(closure.state()).toEqual({
    chargedCredits: 10,
    unconfirmedCredits: 0,
  });
});

it.each([
  "wallet",
  "key",
] as const)("%s 不足时整笔回滚且判定为确定未扣费", async (kind) => {
  const wallet = ledger.wallets.get("u1");
  const key = ledger.keys.get("k1");
  if (!wallet || !key) throw new Error("Missing fixture rows");
  if (kind === "wallet") wallet.balance = 5;
  else key.credit_limit = 5;
  const before = snapshot();
  const closure = chargeClosure();
  const failure = await request(closure).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(isDefinitiveChargeRejection(failure)).toBe(true);
  expect(snapshot()).toEqual(before);
  expect(closure.state()).toEqual({ chargedCredits: 0, unconfirmedCredits: 0 });
});

it("COMMIT 确认丢失时不单独退 Key，并把本次额度记为未确认", async () => {
  ledger.loseAck = true;
  const closure = chargeClosure();
  const failure = await request(closure).catch((error: unknown) => error);
  expect(isDefinitiveChargeRejection(failure)).toBe(false);
  expect(ledger.wallets.get("u1")?.balance).toBe(990);
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  expect(ledger.entries).toHaveLength(1);
  expect(closure.state()).toEqual({
    chargedCredits: 0,
    unconfirmedCredits: 10,
  });
});

it("按“已确认+未确认”申请退款能退回已入账的扣费与 Key；只按已确认额申请则退不回", async () => {
  ledger.loseAck = true;
  const closure = chargeClosure();
  await request(closure).catch(() => undefined);
  const committed = {
    wallet: Number(ledger.wallets.get("u1")?.balance),
    rows: ledger.entries.map((entry) => ({ ...entry })),
    keys: new Map(
      [...ledger.keys].map(([id, row]) => [id, { ...row }] as const)
    ),
  };
  const refundWith = async (amount: number, sourceRef: string) => {
    const refund = new ControlledLedger();
    refund.wallet = committed.wallet;
    refund.rows = committed.rows.map((row) => ({ ...row }));
    refund.keys = new Map(
      [...committed.keys].map(([id, row]) => [id, { ...row }] as const)
    );
    state.db = refund.database();
    if (amount > 0)
      await submitGenerationRefund({
        userId: "u1",
        generationId: "normal-task",
        sourceRef,
        amount,
        targetCredits: 0,
      });
    return {
      wallet: refund.wallet,
      key: refund.keys.get("k1")?.credits_used,
    };
  };

  const { chargedCredits, unconfirmedCredits } = closure.state();
  const plan = planChargeSettlement({
    confirmedCredits: chargedCredits,
    unconfirmedCredits,
    targetCredits: 0,
  });
  expect(plan.refundRequestCredits).toBe(10);
  expect(
    await refundWith(plan.refundRequestCredits, "normal-task:failed")
  ).toEqual({ wallet: 1000, key: 0 });
  // 反向对照：只按本地已确认额（0）申请时，已入账的 10 积分和 Key 额度都留在账上。
  expect(
    await refundWith(
      Math.max(0, chargedCredits - plan.targetCredits),
      "normal-task:failed-local"
    )
  ).toEqual({ wallet: 990, key: 10 });
});

it("同步补扣也在消费事务内扣 Key，且不借用 async 终态结算围栏", async () => {
  const closure = chargeClosure();
  await request(closure, 10, "normal-task:image-actual-size:charge");
  expect(ledger.wallets.get("u1")?.balance).toBe(990);
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  expect(
    ledger.queries.some((query) => query.text.includes('from "generation"'))
  ).toBe(false);
  expect(keyUpdates().every((query) => query.client > 0)).toBe(true);
});

it("任务 ID 复用命中旧扣费时以确定错误码拒绝，不再变动钱包或 Key", async () => {
  const closure = chargeClosure();
  await request(closure);
  const failure = await request(closure).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: "Generation task ID is already in use. Please start a new task.",
    code: GENERATION_TASK_REUSED_CODE,
  });
  expect(isDefinitiveChargeRejection(failure)).toBe(true);
  expect(ledger.wallets.get("u1")?.balance).toBe(990);
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  expect(ledger.entries).toHaveLength(1);
});

it("没有 Key 的会话扣费不触碰任何 Key 行", async () => {
  const closure = chargeClosure(null);
  await request(closure);
  expect(ledger.wallets.get("u1")?.balance).toBe(990);
  expect(ledger.keys.get("k1")?.credits_used).toBe(0);
  expect(keyUpdates()).toHaveLength(0);
});
