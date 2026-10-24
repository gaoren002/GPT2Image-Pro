/** Creem webhook UOL 契约；HTTP 必须先验签，agent/其他支付渠道不能以用户身份调用。 */
import { z } from "zod";
import { creemWebhookInputSchema } from "../../payment/creem-event";
import { defineOperation } from "../registry";

export const creemWebhook = defineOperation({
  name: "subscription.creemWebhook",
  domain: "subscription",
  title: "Apply verified Creem event",
  description:
    "按 provider 毫秒时间推进订阅；同时间保守合并。重复/旧事件仍幂等补发已付周期及顺延，不以事件收件凭证当作财务完成。",
  input: creemWebhookInputSchema,
  output: z.object({ received: z.literal(true) }),
  access: { kind: "webhook", provider: "creem" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "required", keyField: "id", scope: "global" },
  sideEffects: ["billing", "audit"],
  /** 延迟加载财务服务，注册契约不读取配置或建立数据库连接。 */
  execute: async (input) => {
    const { handleCreemWebhook } = await import("../../payment/creem-webhook");
    return handleCreemWebhook(input);
  },
});
