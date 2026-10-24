/** charge-outcome 纯函数：消费异常分类与结算计划的边界。 */

import { describe, expect, it } from "vitest";
import {
  GENERATION_TASK_REUSED_CODE,
  INVALID_CHARGE_REQUEST_CODE,
  isDefinitiveChargeRejection,
  markInvalidChargeRequest,
  planChargeSettlement,
} from "./charge-outcome";

/** 构造与 credits/core 同名的错误，避免在 DB-free 测试中导入数据库模块。 */
function namedError(name: string) {
  return Object.assign(new Error(name), { name });
}

describe("isDefinitiveChargeRejection", () => {
  it.each([
    ["余额不足", namedError("InsufficientCreditsError")],
    ["账户冻结", namedError("AccountFrozenError")],
    [
      "消费事务内 Key 额度不足",
      Object.assign(new Error("API key quota exceeded or key is unavailable"), {
        code: "api_key_quota_exceeded",
      }),
    ],
    [
      "任务 ID 复用",
      Object.assign(new Error("already in use"), {
        code: GENERATION_TASK_REUSED_CODE,
      }),
    ],
  ])("%s 可证明未扣费", (_label, error) => {
    expect(isDefinitiveChargeRejection(error)).toBe(true);
  });

  it.each([
    ["连接中断", new Error("Connection terminated unexpectedly")],
    [
      "管理员终止连接",
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
    ],
    [
      "语句超时",
      Object.assign(new Error("canceling statement"), { code: "57014" }),
    ],
    ["非 Error 值", "Insufficient credits"],
    ["空值", undefined],
    ["仅文案相似的普通错误", new Error("积分不足: 需要 10，可用 0")],
  ])("%s 视为结果未知", (_label, error) => {
    expect(isDefinitiveChargeRejection(error)).toBe(false);
  });
});

describe("markInvalidChargeRequest", () => {
  it("给事务前校验错误补上错误码并保留原消息，标记后判定为确定未扣", () => {
    const original = new Error("消费数量必须大于 0");
    const marked = markInvalidChargeRequest(original);
    expect(marked).toBe(original);
    expect(marked).toMatchObject({
      message: "消费数量必须大于 0",
      code: INVALID_CHARGE_REQUEST_CODE,
    });
    expect(isDefinitiveChargeRejection(marked)).toBe(true);
  });

  it("已有错误码的错误保持原分类", () => {
    const coded = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    expect(markInvalidChargeRequest(coded)).toMatchObject({ code: "57P01" });
    expect(isDefinitiveChargeRejection(coded)).toBe(false);
  });

  it("非对象值原样返回", () => {
    expect(markInvalidChargeRequest("boom")).toBe("boom");
  });
});

describe("planChargeSettlement", () => {
  it.each([
    // [已确认, 未确认, 目标, 补扣, 退款申请]
    [10, 0, 15, 5, 0],
    [10, 0, 4, 0, 6],
    [10, 0, 10, 0, 0],
    [0, 0, 0, 0, 0],
    [10, 5, 2, 0, 13],
    [10, 5, 12, 0, 3],
    [10, 5, 15, 0, 0],
    [10, 5, 20, 5, 0],
    [0, 10, 0, 0, 10],
  ])("已确认 %d、未确认 %d、目标 %d 时补扣 %d、申请退款 %d", (confirmed, unconfirmed, target, charge, refund) => {
    expect(
      planChargeSettlement({
        confirmedCredits: confirmed,
        unconfirmedCredits: unconfirmed,
        targetCredits: target,
      })
    ).toEqual({
      targetCredits: target,
      chargeCredits: charge,
      refundRequestCredits: refund,
    });
  });

  it("负目标按 0 处理，负的已确认/未确认额不放大上限", () => {
    expect(
      planChargeSettlement({
        confirmedCredits: -3,
        unconfirmedCredits: -2,
        targetCredits: -1,
      })
    ).toEqual({ targetCredits: 0, chargeCredits: 0, refundRequestCredits: 0 });
  });

  it("按两位小数取整，避免浮点误差产生 0.01 级补扣或退款", () => {
    expect(
      planChargeSettlement({
        confirmedCredits: 0.1,
        unconfirmedCredits: 0.2,
        targetCredits: 0.3,
      })
    ).toEqual({
      targetCredits: 0.3,
      chargeCredits: 0,
      refundRequestCredits: 0,
    });
    expect(
      planChargeSettlement({
        confirmedCredits: 1.27,
        unconfirmedCredits: 0,
        targetCredits: 0.5,
      })
    ).toEqual({
      targetCredits: 0.5,
      chargeCredits: 0,
      refundRequestCredits: 0.77,
    });
  });
});
