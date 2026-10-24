/** 管理员充值 UOL 契约；Action/agent 共用 schema、权限与请求键，资金服务延迟加载。 */
import { z } from "zod";
import { defineOperation } from "../registry";

const inputSchema = z.strictObject({
  userId: z.string().min(1, "用户ID不能为空"),
  requestId: z.string().uuid("充值请求标识必须是 UUID").toLowerCase(),
  amount: z
    .number()
    .positive("积分数量必须大于0")
    .max(100000, "单次最多充值10万积分")
    .refine(
      (amount) => Math.round((amount + Number.EPSILON) * 100) / 100 === amount,
      "积分数量最多保留两位小数"
    ),
  reason: z
    .string()
    .trim()
    .min(1, "请填写操作原因")
    .max(300, "原因最多300字符"),
});
const outputSchema = z.object({
  batchId: z.string(),
  transactionId: z.string(),
  amount: z.number().nonnegative(),
  newBalance: z.number(),
  alreadyGranted: z.boolean(),
});
export type AdminCreditGrantInput = z.infer<typeof inputSchema>;
export type AdminCreditGrantResult = z.infer<typeof outputSchema>;

export const adminGrant = defineOperation({
  name: "credits.adminGrant",
  domain: "credits",
  title: "Admin Grant Credits",
  description:
    "管理员长期积分充值；actor 只取已认证 principal，服务复核目标角色及自充值开关。" +
    "按 actor+requestId 幂等并核对重放参数；资金和审计同事务，重放发放量为零。",
  input: inputSchema,
  output: outputSchema,
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "required", keyField: "requestId", scope: "per-user" },
  sideEffects: ["billing", "audit"],
  /** 延迟加载数据库服务；注册其他积分操作时不借连接，也不依赖 Next 请求上下文。 */
  execute: async (input, principal) => {
    const { grantAdminCredits } = await import(
      "../../support/services/admin-credit-grant"
    );
    return grantAdminCredits(input, principal);
  },
});
