/** 专用退款包装器契约；退款池合并与并发封顶由 generation-refund 的真实 Drizzle 回归验证。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ grant: vi.fn(), select: vi.fn() }));
vi.mock("@repo/database", () => ({ db: { select: state.select } }));
vi.mock("./core", () => ({ grantCredits: state.grant }));
vi.mock("../storage/providers", () => ({ getStorageProvider: vi.fn() }));

import { refundGenerationCredits } from "../generation-maintenance";

const request = {
  userId: "u1",
  generationId: "g1",
  sourceRef: "g1:failure",
  amount: 10,
  description: "test",
};
beforeEach(() => {
  vi.clearAllMocks();
  state.grant
    .mockReset()
    .mockResolvedValue({
      amount: 4,
      alreadyGranted: false,
      remainingDebited: 6,
    });
  state.select.mockImplementation(() => {
    throw new Error("包装器不得在事务外查重");
  });
});
describe("refundGenerationCredits 专用事务委托", () => {
  it("传入内部 context，只报告实际发放金额", async () => {
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
        generationRefund: { generationId: "g1" },
      })
    );
    expect(state.select).not.toHaveBeenCalled();
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
  it("不允许 metadata 覆盖权威任务 ID", async () => {
    await refundGenerationCredits({
      ...request,
      metadata: { generationId: "other" },
    });
    expect(state.grant.mock.calls[0]?.[0].metadata.generationId).toBe("g1");
    expect(state.grant.mock.calls[0]?.[0].generationRefund.generationId).toBe(
      "g1"
    );
  });
  it("零请求仍核对权威净额，事务失败向上传递", async () => {
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
    state.grant.mockRejectedValueOnce(new Error("transaction failed"));
    await expect(refundGenerationCredits(request)).rejects.toThrow(
      "transaction failed"
    );
  });
  it("缺权威净额时失败关闭，不回退使用请求额或本地旧计数", async () => {
    state.grant.mockResolvedValueOnce({ amount: 0, alreadyGranted: true });
    await expect(refundGenerationCredits(request)).rejects.toThrow(
      /authoritative remaining debit/
    );
  });
});
