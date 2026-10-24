/** 普通 Epay 恢复的 UOL 入口；仅 cron 可执行，扫描本地已接收事实，不请求网关。 */
import { defineOperation } from "@repo/shared/uol";
import { z } from "zod";

export const recoverEpayPayments = defineOperation({
  name: "subscription.recoverEpayFulfillments",
  domain: "subscription",
  title: "Recover Epay Fulfillments",
  description: "有界恢复已收款但未履约完成的普通 Epay 订单",
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({
    scanned: z.number(),
    fulfilled: z.number(),
    failed: z.number(),
  }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: async ({ limit }) => {
    const { recoverEpayFulfillments } = await import("./epay-fulfillment");
    return recoverEpayFulfillments(limit);
  },
});
