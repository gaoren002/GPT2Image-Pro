/** 纯中转初始财务恢复的 cron/system UOL；不重发上游、不访问内容、用户不能触发提前回收。 */
import { z } from "zod";
import { defineOperation } from "../registry";

export const recoverRelayInitialChargesOperation = defineOperation({
  name: "image-generation.recoverRelayInitialCharges",
  domain: "image-generation",
  title: "恢复未派发纯中转的初始扣费",
  description:
    "只领取过期 captured 和已认领 refund_pending，持久投递既有退款 outbox。",
  input: z
    .object({ limit: z.number().int().min(1).max(500).default(100) })
    .strict(),
  output: z.object({
    scanned: z.number(),
    enqueued: z.number(),
    failed: z.number(),
  }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  /** 与 transport 无关，实际身份准入由 invokeOperation 网关负责。 */
  execute: async (input) => {
    const { recoverRelayInitialCharges } = await import(
      "../../relay-initial-charge"
    );
    return recoverRelayInitialCharges(input.limit);
  },
});
