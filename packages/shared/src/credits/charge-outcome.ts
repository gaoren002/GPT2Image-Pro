/**
 * 消费结果判定与结算计划（纯函数，不依赖数据库）。
 *
 * 使用方：apps/web 生图管线 operations.ts 的扣费闭包与失败结算。consumeCredits
 * 抛错时不一定代表没有扣费：COMMIT 已在数据库生效但确认（ACK）因断连丢失时，
 * 调用方只能看到异常。本模块把“能证明本次未提交消费”的拒绝与“结果未知”区分
 * 开，并给出结算时应补扣与应申请退款的金额。退款申请只是上限，实际金额由
 * 退款事务在锁内按账本净扣费裁剪（grantCredits 的 generationRefund），因此把
 * 未确认扣费计入上限不会多退。
 */

const CREDIT_DECIMAL_FACTOR = 100;

/** 与 credits/core 的金额精度一致：两位小数，EPSILON 修正浮点误差。 */
function roundCredits(value: number) {
  return (
    Math.round((value + Number.EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

/** 消费幂等命中旧账本记录（任务 ID 被复用）时，调用方抛出的错误码。 */
export const GENERATION_TASK_REUSED_CODE = "generation_task_reused";

/** consumeCredits 在开启事务前的参数校验失败：没有任何写入。 */
export const INVALID_CHARGE_REQUEST_CODE = "invalid_charge_request";

/**
 * 给事务前的校验错误补上 INVALID_CHARGE_REQUEST_CODE，保留原错误对象与消息。
 * 已有 code 的错误保持不变，避免覆盖更具体的分类。
 */
export function markInvalidChargeRequest(error: unknown): unknown {
  if (error && typeof error === "object" && !("code" in error)) {
    Object.assign(error, { code: INVALID_CHARGE_REQUEST_CODE });
  }
  return error;
}

/**
 * 判断消费异常是否能证明本次没有提交任何消费。
 *
 * 余额不足、账户冻结、Key 额度不足都在消费事务内或事务前抛出，事务整体回滚；
 * 任务 ID 复用是幂等命中，没有新消费；事务前参数校验失败没有任何写入。
 * 按错误类名与错误码判断，不匹配文案。
 * 其他异常（含连接中断、COMMIT 失败、语句超时）一律视为结果未知，调用方不能
 * 据此终结任务或推断未扣费。
 *
 * @param error consumeCredits 或调用方扣费逻辑抛出的任意值
 * @returns 能证明未扣费时为 true；无法证明时为 false
 */
export function isDefinitiveChargeRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error.name === "InsufficientCreditsError" ||
    error.name === "AccountFrozenError"
  ) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "api_key_quota_exceeded" ||
    code === GENERATION_TASK_REUSED_CODE ||
    code === INVALID_CHARGE_REQUEST_CODE
  );
}

/**
 * 计算结算到目标净扣费时的补扣额与退款申请额。
 *
 * 已确认额来自成功返回的扣费与退款事务给出的权威净额；未确认额是结果未知的
 * 扣费之和，可能已入账也可能已回滚。退款按“已确认 + 未确认”申请，退款事务
 * 再按账本裁剪，两种情况都能收敛到目标；补扣只补两者之和以外的部分，未确认
 * 扣费若其实已回滚会少扣，宁可少扣也不重复扣。
 *
 * @param params.confirmedCredits 已确认的净扣费，负数按 0 处理
 * @param params.unconfirmedCredits 结果未知的扣费合计，负数按 0 处理
 * @param params.targetCredits 本次结算的目标净扣费，负数按 0 处理
 * @returns targetCredits 取整后的目标；chargeCredits 应补扣额；
 *   refundRequestCredits 应申请退款的上限；后两者至多一个为正
 */
export function planChargeSettlement(params: {
  confirmedCredits: number;
  unconfirmedCredits: number;
  targetCredits: number;
}) {
  const target = roundCredits(Math.max(0, params.targetCredits));
  const upperBound = roundCredits(
    Math.max(0, params.confirmedCredits) +
      Math.max(0, params.unconfirmedCredits)
  );
  const delta = roundCredits(target - upperBound);
  return {
    targetCredits: target,
    chargeCredits: delta > 0 ? delta : 0,
    refundRequestCredits: delta < 0 ? roundCredits(-delta) : 0,
  };
}
