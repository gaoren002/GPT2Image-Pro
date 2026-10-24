/** 升级预留 UOL 契约：用户下单/取消、cron 释放、管理员退款共用同一事务服务。 */
import { z } from "zod";
import { getPrincipalUserId } from "../uol/principal";
import { defineOperation } from "../uol/registry";
import { createRuntimeEpayPurchase } from "./epay";
import { upgradeReservations } from "./upgrade-reservation";

/** 服务只在登录身份下执行，用户归属不取自外部输入。 */
function requireUser(principal: Parameters<typeof getPrincipalUserId>[0]) {
  const userId = getPrincipalUserId(principal);
  if (!userId) throw new Error("需要登录");
  return userId;
}
export const reserveUpgrade = defineOperation({
  name: "subscription.reserveUpgrade",
  domain: "subscription",
  title: "Reserve Upgrade Checkout",
  description: "下单并预留旧订阅积分；相同套餐在途订单复用，15分钟未付自动释放",
  input: z.object({
    targetPriceId: z.string().min(1),
    clientRequestId: z.string().min(1).max(128),
  }),
  output: z.object({
    url: z.string(),
    params: z.record(z.string(), z.string()),
    method: z.literal("POST"),
    outTradeNo: z.string(),
    amountDue: z.number(),
    expiresAt: z.string(),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-user",
  },
  sideEffects: ["billing", "external-call"],
  execute: async (input, principal) => {
    const { reservation, payable } = await upgradeReservations.reserve({
      ...input,
      userId: requireUser(principal),
    });
    if (!payable) throw new Error("该升级订单已结束，请重新下单");
    // 签名/配置失败保留同一预留以便重试，不能取消其他并发请求已拿到的复用链接。
    const checkout = await createRuntimeEpayPurchase({
      outTradeNo: reservation.outTradeNo,
      name: `GPT2IMAGE upgrade ${reservation.snapshot.targetPriceId}`,
      money: reservation.snapshot.quote.amountDue,
    });
    return {
      ...checkout,
      method: "POST" as const,
      outTradeNo: reservation.outTradeNo,
      amountDue: reservation.snapshot.quote.amountDue,
      expiresAt: reservation.expiresAt.toISOString(),
    };
  },
});
export const cancelUpgrade = defineOperation({
  name: "subscription.cancelUpgrade",
  domain: "subscription",
  title: "Cancel Upgrade Checkout",
  description: "取消本人未付款升级并按原有效期释放预留",
  input: z.object({ outTradeNo: z.string().min(1) }),
  output: z.object({ state: z.string() }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: (input, principal) =>
    upgradeReservations.cancel(requireUser(principal), input.outTradeNo),
});
export const expireUpgrades = defineOperation({
  name: "subscription.expireUpgradeReservations",
  domain: "subscription",
  title: "Expire Upgrade Reservations",
  description: "有界释放过期升级预留，保留订单和账本终态供迟到付款及退款处理",
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ released: z.number() }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: (input) => upgradeReservations.expire(input.limit),
});
export const prepareUpgradeRefund = defineOperation({
  name: "subscription.prepareUpgradeRefund",
  domain: "subscription",
  title: "Prepare Upgrade Refund",
  description: "超级管理员外部全退前冻结未消费的新权益；已消费拒绝自动全退",
  input: z.object({ outTradeNo: z.string().min(1) }),
  output: z.object({ amount: z.number(), state: z.string() }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: (input) => upgradeReservations.prepareRefund(input.outTradeNo),
});
export const confirmUpgradeRefund = defineOperation({
  name: "subscription.confirmUpgradeRefund",
  domain: "subscription",
  title: "Confirm Upgrade Refund",
  description:
    "超级管理员记录已完成的外部退款凭据，撤销新权益并按原有效期恢复旧积分；不调用网关转账",
  input: z.object({
    outTradeNo: z.string().min(1),
    refundRef: z.string().min(1).max(128),
    amount: z.number().positive(),
  }),
  output: z.object({ state: z.string() }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "required", keyField: "refundRef", scope: "global" },
  sideEffects: ["billing"],
  execute: (input) =>
    upgradeReservations.confirmRefund(
      input.outTradeNo,
      input.refundRef,
      input.amount
    ),
});
