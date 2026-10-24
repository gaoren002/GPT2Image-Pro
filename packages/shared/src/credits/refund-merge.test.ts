/** 退款包装器契约：真实 outbox SQL、受控 grant 返回值；资金原子性由 R10 驱动回归覆盖。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledLedger } from "./test-support/generation-refund-db";

const state = vi.hoisted(() => ({
  grant: vi.fn(),
  logWarn: vi.fn(),
  database: {} as object,
}));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value: unknown = Reflect.get(state.database, key);
        return typeof value === "function" ? value.bind(state.database) : value;
      },
    }
  ),
}));
vi.mock("./core", () => ({ grantCredits: state.grant }));
vi.mock("../logger", () => ({ logWarn: state.logWarn }));
vi.mock("../storage/providers", () => ({ getStorageProvider: vi.fn() }));
import { refundGenerationCredits } from "../generation-maintenance";

const request = {
  userId: "u1",
  generationId: "g1",
  sourceRef: "g1:failure",
  amount: 10,
  description: "private prompt",
};
let ledger: ControlledLedger;
beforeEach(() => {
  vi.clearAllMocks();
  ledger = new ControlledLedger();
  state.database = ledger.database();
  state.grant
    .mockReset()
    .mockResolvedValue({
      amount: 4,
      alreadyGranted: false,
      remainingDebited: 6,
    });
});
describe("refundGenerationCredits 专用事务委托", () => {
  it("持久化在财务调用之前，传内部 context 且只报告实际发放金额", async () => {
    state.grant.mockImplementationOnce(async () => {
      expect(ledger.outbox).toHaveLength(1);
      expect(ledger.outbox[0]?.state).toBe("pending");
      return { amount: 4, alreadyGranted: false, remainingDebited: 6 };
    });
    expect(await refundGenerationCredits(request)).toEqual({
      refunded: true,
      amount: 4,
      remainingDebited: 6,
    });
    expect(state.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "refund",
        transactionType: "refund",
        debitAccount: "SYSTEM:generation_refund",
        generationRefund: { generationId: "g1", targetCredits: 0 },
      })
    );
    expect(
      ledger.queries.some((query) =>
        query.text.includes('from "credits_transaction"')
      )
    ).toBe(false);
    expect(ledger.queries.some((query) => query.text.startsWith("begin"))).toBe(
      false
    );
  });
  it.each([
    { amount: 0, alreadyGranted: false },
    { amount: 4, alreadyGranted: true },
  ])("no-op 返回零金额：%o", async (result) => {
    state.grant.mockResolvedValueOnce({ ...result, remainingDebited: 6 });
    expect(await refundGenerationCredits(request)).toEqual({
      refunded: false,
      amount: 0,
      remainingDebited: 6,
    });
  });
  it("metadata 不覆盖权威任务，只读取 targetCredits，任意私密内容不入库", async () => {
    await refundGenerationCredits({
      ...request,
      metadata: {
        generationId: "other",
        targetCredits: 2,
        imageUrl: "private-image",
      },
    });
    expect(state.grant.mock.calls[0]?.[0].metadata).toEqual({
      generationId: "g1",
    });
    expect(state.grant.mock.calls[0]?.[0].generationRefund).toEqual({
      generationId: "g1",
      targetCredits: 2,
    });
    expect(JSON.stringify(ledger.outbox)).not.toMatch(
      /private|imageUrl|prompt/
    );
  });
  it("零请求仍核对净额，财务失败保留 pending 并向上传递固定安全异常", async () => {
    state.grant.mockResolvedValueOnce({
      amount: 0,
      alreadyGranted: false,
      remainingDebited: 6,
    });
    expect(await refundGenerationCredits({ ...request, amount: 0 })).toEqual({
      refunded: false,
      amount: 0,
      remainingDebited: 6,
    });
    expect(state.grant.mock.calls[0]?.[0].amount).toBe(0);
    state.grant.mockRejectedValueOnce(new Error("private error content"));
    await expect(
      refundGenerationCredits({ ...request, sourceRef: "g1:other" })
    ).rejects.toThrow("Generation refund pending retry");
    expect(ledger.outbox[1]?.state).toBe("pending");
    expect(JSON.stringify(state.logWarn.mock.calls)).not.toContain(
      "private error content"
    );
  });
  it("缺权威净额失败关闭，不回退使用请求额且记账本异常类别", async () => {
    state.grant.mockResolvedValueOnce({ amount: 0, alreadyGranted: true });
    await expect(refundGenerationCredits(request)).rejects.toThrow(
      "Generation refund pending retry"
    );
    expect(ledger.outbox[0]?.state).toBe("pending");
    expect(state.logWarn).toHaveBeenCalledWith(
      "Generation refund pending retry",
      expect.objectContaining({
        category: "invalid_ledger_result",
        attempts: 1,
      })
    );
  });
  it.each([
    "AccountFrozenError",
    "database",
  ])("%s 错误输出安全类别，日志不含 SQL/参数/cause/raw", async (kind) => {
    const error =
      kind === "database"
        ? Object.assign(
            new Error("Failed query: select secret params private"),
            {
              query: "select secret",
              params: ["private"],
              cause: {
                code: "23514",
                constraint: "credits_check",
                table: "credits_balance",
                message: "private",
              },
            }
          )
        : Object.assign(new Error("private frozen details"), { name: kind });
    state.grant.mockRejectedValueOnce(error);
    await expect(refundGenerationCredits(request)).rejects.toThrow(
      "Generation refund pending retry"
    );
    expect(state.logWarn).toHaveBeenCalledWith(
      "Generation refund pending retry",
      expect.objectContaining({
        category: kind === "database" ? "database" : "account_frozen",
        errorSummary:
          kind === "database"
            ? "DatabaseError(code=23514, constraint=credits_check, table=credits_balance)"
            : "account_frozen",
      })
    );
    expect(JSON.stringify(state.logWarn.mock.calls)).not.toMatch(
      /private|select secret|params|cause|stack/
    );
  });
});
