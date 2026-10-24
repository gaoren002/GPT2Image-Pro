"use server";

/** 用户管理 Server Actions；列表委托共享查询，其余操作保留原鉴权、审计和事务护栏。 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@repo/database";
import {
  account,
  adminAuditLog,
  creditsBalance,
  creditsBatch,
  creditsTransaction,
  externalApiKey,
  generation,
  session,
  subscription,
  user,
} from "@repo/database/schema";
import {
  APP_USER_ROLES,
  canActOnTargetRole,
  getUserRoleLabel,
} from "../../auth/roles";
import type { SubscriptionPlan } from "../../config/subscription-plan";
import { PRICE_IDS } from "../../config/payment";
import {
  consumeCredits,
  freezeCreditsAccount,
  getCreditsBalance,
  unfreezeCreditsAccount,
} from "../../credits/core";
import { expireStalePendingGenerations } from "../../generation-maintenance";
import { invokeOperation } from "../../uol/invoke";
import { OperationError } from "../../uol/errors";
import {
  adminGrant,
  type AdminCreditGrantResult,
} from "../../uol/operations/credits-admin-grant";
import {
  ActionUserError,
  adminAction,
  superAdminAction,
} from "../../safe-action";
import { buildSignedStorageImageUrl } from "../../storage/signed-url";
import { getUserPlan } from "../../subscription/services/user-plan";
import { randomUUID } from "node:crypto";
import {
  getAdminUsersListSnapshot,
  listUsersSchema,
} from "../services/admin-users-list";
// 密码哈希链路：与 bootstrap-super-admin.ts 完全一致，写入 account.password，禁止明文/自造哈希
import { hashPassword } from "better-auth/crypto";
// 积分账户惰性创建（新建用户后初始化积分账户，余额 0）
import { ensureCreditsBalance } from "../../credits/core";
// 邮箱规范化 + 注册身份登记/查重（防薅羊毛账本，建号/改邮箱需同步）
import { normalizeEmail } from "../../auth/email-domain";
import {
  isRegistrationEmailTaken,
  recordRegistrationIdentity,
} from "../../auth/registration-identity";

const withAdminUsersAction = (name: string) =>
  adminAction.metadata({ action: `support.adminUsers.${name}` });
const withSuperAdminUsersAction = (name: string) =>
  superAdminAction.metadata({ action: `support.adminUsers.${name}` });

/**
 * 高敏操作的目标权限护栏（封禁、积分发放等用 adminAction 的操作）。
 *
 * WHY: 这些操作仅要求 adminAction（普通 admin 即可），但 getUserBasicOrThrow 不校验
 * 目标角色。若无护栏，普通 admin 可封禁/锁死 super_admin，破坏权限层级（见审计 S-H5）。
 * 规则：超管可操作任意账户；非超管仅能操作"权限等级严格低于自己"的账户。
 * APP_USER_ROLES 为升序（user < observer_admin < admin < super_admin），index 即等级。
 */
function assertCanActOnTarget(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
  operation: string
) {
  if (!canActOnTargetRole(actorRole, targetRole)) {
    throw new ActionUserError(
      `无权对该账户执行${operation}：目标权限不低于操作者`
    );
  }
}

const userIdSchema = z.object({
  userId: z.string().min(1, "用户ID不能为空"),
});

const reasonSchema = z
  .string()
  .trim()
  .min(1, "请填写操作原因")
  .max(300, "原因最多300字符");

const updateUserRoleSchema = userIdSchema.extend({
  role: z.enum(APP_USER_ROLES),
  reason: z.string().trim().max(300).optional(),
});

const banUserSchema = userIdSchema.extend({
  banned: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

const adjustCreditsSchema = userIdSchema.extend({
  amount: z
    .number()
    .positive("扣减积分必须大于0")
    .max(1000000, "单次最多扣减100万积分"),
  reason: reasonSchema,
});

const setCreditsStatusSchema = userIdSchema.extend({
  status: z.enum(["active", "frozen"]),
  reason: reasonSchema,
});

const setUserPlanSchema = userIdSchema.extend({
  plan: z.enum(["free", "starter", "pro", "ultra", "enterprise"]),
  reason: reasonSchema,
});

const setExternalApiKeyStatusSchema = z.object({
  keyId: z.string().min(1, "API Key ID 不能为空"),
  isActive: z.boolean(),
  reason: reasonSchema,
});

// 管理员手动创建用户：用户名/邮箱/密码必填，角色与邮箱验证状态可选
const createUserSchema = z.object({
  name: z.string().trim().min(1, "请填写用户名").max(60, "用户名最多60字符"),
  email: z.string().trim().email("邮箱格式不正确").max(254, "邮箱过长"),
  password: z.string().min(8, "密码至少8位").max(128, "密码最多128位"),
  // 仅超管可建号，可直接指定角色（与 updateUserRoleAction 一致，允许 super_admin）；默认普通用户
  role: z.enum(APP_USER_ROLES).default("user"),
  // 是否标记邮箱已验证（管理员代建账号通常视为可信）
  emailVerified: z.boolean().default(true),
  reason: reasonSchema,
});

// 编辑用户基础资料：用户名与绑定邮箱（均可单独修改）
const updateUserProfileSchema = userIdSchema
  .extend({
    name: z
      .string()
      .trim()
      .min(1, "请填写用户名")
      .max(60, "用户名最多60字符")
      .optional(),
    email: z
      .string()
      .trim()
      .email("邮箱格式不正确")
      .max(254, "邮箱过长")
      .optional(),
    emailVerified: z.boolean().optional(),
    reason: reasonSchema,
  })
  .superRefine((data, ctx) => {
    // 至少修改一个字段，避免空操作
    if (
      data.name === undefined &&
      data.email === undefined &&
      data.emailVerified === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "请至少修改一项资料",
      });
    }
  });

// 重设用户密码：直接覆盖 account 表 credential 记录的哈希
const setUserPasswordSchema = userIdSchema.extend({
  password: z.string().min(8, "密码至少8位").max(128, "密码最多128位"),
  reason: reasonSchema,
});

function getMonthlyPriceIdForPlan(plan: Exclude<SubscriptionPlan, "free">) {
  const priceIdMap: Record<Exclude<SubscriptionPlan, "free">, string> = {
    starter: PRICE_IDS.STARTER_MONTHLY,
    pro: PRICE_IDS.PRO_MONTHLY,
    ultra: PRICE_IDS.ULTRA_MONTHLY,
    enterprise: PRICE_IDS.ENTERPRISE_MONTHLY,
  };
  const priceId = priceIdMap[plan]?.trim();
  if (!priceId) {
    // 用 ActionUserError 让提示原样透传前端(否则生产环境被统一替换成"服务器错误")。
    throw new ActionUserError(
      `套餐「${plan}」尚未配置月付 Price ID,请先在系统设置中为该套餐配置价格后再切换。`
    );
  }
  return priceId;
}

function normalizeAdminCreditAmount(amount: number) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function sanitizeSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function writeAdminAuditLog(params: {
  adminUserId: string;
  targetUserId?: string | null;
  action: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(adminAuditLog).values({
    id: crypto.randomUUID(),
    adminUserId: params.adminUserId,
    targetUserId: params.targetUserId ?? null,
    action: params.action,
    reason: params.reason?.trim() || null,
    before: sanitizeSnapshot(params.before),
    after: sanitizeSnapshot(params.after),
    metadata: params.metadata,
  });
}

async function getUserBasicOrThrow(userId: string) {
  const [targetUser] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      bannedReason: user.bannedReason,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!targetUser) {
    throw new ActionUserError("用户不存在");
  }

  return targetUser;
}

export const getAllUsersAction = withAdminUsersAction("getAllUsers")
  .schema(listUsersSchema)
  .action(async ({ parsedInput, ctx }) =>
    getAdminUsersListSnapshot(parsedInput, ctx.role)
  );

export const getUserDetailAction = withAdminUsersAction("getUserDetail")
  .schema(userIdSchema)
  .action(async ({ parsedInput }) => {
    const userId = parsedInput.userId;
    await expireStalePendingGenerations({ userId, limit: 100 });

    const [
      userRows,
      balanceRows,
      subscriptionRows,
      activeBatches,
      transactions,
      generations,
      apiKeys,
      auditLogs,
      generationSummary,
    ] = await Promise.all([
      db.select().from(user).where(eq(user.id, userId)).limit(1),
      db
        .select()
        .from(creditsBalance)
        .where(eq(creditsBalance.userId, userId))
        .limit(1),
      db
        .select()
        .from(subscription)
        .where(eq(subscription.userId, userId))
        .limit(1),
      db
        .select()
        .from(creditsBatch)
        .where(
          and(
            eq(creditsBatch.userId, userId),
            eq(creditsBatch.status, "active"),
            sql`${creditsBatch.remaining} > 0`
          )
        )
        .orderBy(desc(creditsBatch.issuedAt))
        .limit(10),
      db
        .select()
        .from(creditsTransaction)
        .where(eq(creditsTransaction.userId, userId))
        .orderBy(desc(creditsTransaction.createdAt))
        .limit(20),
      db
        .select({
          id: generation.id,
          prompt: generation.prompt,
          revisedPrompt: generation.revisedPrompt,
          model: generation.model,
          size: generation.size,
          status: generation.status,
          storageKey: generation.storageKey,
          storageBucket: generation.storageBucket,
          fileSize: generation.fileSize,
          creditsConsumed: generation.creditsConsumed,
          error: generation.error,
          metadata: generation.metadata,
          createdAt: generation.createdAt,
          completedAt: generation.completedAt,
        })
        .from(generation)
        .where(eq(generation.userId, userId))
        .orderBy(desc(generation.createdAt))
        .limit(12),
      db
        .select({
          id: externalApiKey.id,
          name: externalApiKey.name,
          keyPrefix: externalApiKey.keyPrefix,
          lastFour: externalApiKey.lastFour,
          creditLimit: externalApiKey.creditLimit,
          creditsUsed: externalApiKey.creditsUsed,
          lastUsedAt: externalApiKey.lastUsedAt,
          isActive: externalApiKey.isActive,
          createdAt: externalApiKey.createdAt,
          updatedAt: externalApiKey.updatedAt,
        })
        .from(externalApiKey)
        .where(eq(externalApiKey.userId, userId))
        .orderBy(desc(externalApiKey.createdAt)),
      db
        .select({
          id: adminAuditLog.id,
          adminUserId: adminAuditLog.adminUserId,
          action: adminAuditLog.action,
          reason: adminAuditLog.reason,
          metadata: adminAuditLog.metadata,
          createdAt: adminAuditLog.createdAt,
        })
        .from(adminAuditLog)
        .where(eq(adminAuditLog.targetUserId, userId))
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(20),
      db
        .select({
          total: sql<number>`count(*)`.mapWith(Number),
          completed:
            sql<number>`sum(case when ${generation.status} = 'completed' then 1 else 0 end)`.mapWith(
              Number
            ),
          failed:
            sql<number>`sum(case when ${generation.status} = 'failed' then 1 else 0 end)`.mapWith(
              Number
            ),
          creditsConsumed:
            sql<number>`coalesce(sum(${generation.creditsConsumed}), 0)`.mapWith(
              Number
            ),
        })
        .from(generation)
        .where(eq(generation.userId, userId)),
    ]);

    const userData = userRows[0];
    if (!userData) {
      throw new Error("用户不存在");
    }

    const sub = subscriptionRows[0] ?? null;
    const planInfo = await getUserPlan(userId);
    return {
      user: userData,
      creditsBalance: balanceRows[0] ?? null,
      subscription: sub,
      plan: planInfo.plan,
      activeBatches,
      transactions,
      generations: generations.map((item) => ({
        ...item,
        imageUrl: buildSignedStorageImageUrl(
          item.storageKey,
          item.storageBucket
        ),
      })),
      apiKeys,
      auditLogs,
      generationSummary: generationSummary[0] ?? {
        total: 0,
        completed: 0,
        failed: 0,
        creditsConsumed: 0,
      },
    };
  });

export const updateUserRoleAction = withSuperAdminUsersAction("updateUserRole")
  .schema(updateUserRoleSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    const targetUser = await getUserBasicOrThrow(data.userId);

    await db
      .update(user)
      .set({
        role: data.role,
        updatedAt: new Date(),
      })
      .where(eq(user.id, data.userId));

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: "user.role.update",
      reason: data.reason || "管理员修改用户角色",
      before: { role: targetUser.role },
      after: { role: data.role },
    });

    revalidatePath("/dashboard/users");
    return { message: `用户角色已更新为 ${getUserRoleLabel(data.role)}` };
  });

export const banUserAction = withAdminUsersAction("banUser")
  .schema(banUserSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    const targetUser = await getUserBasicOrThrow(data.userId);
    // 目标权限护栏：禁止普通 admin 封禁/解封管理员及超管账户（防锁死超管，见 S-H5）。
    assertCanActOnTarget(
      ctx.role,
      targetUser.role,
      data.banned ? "封禁" : "解封"
    );
    const reason = data.reason || (data.banned ? "管理员操作" : "解除封禁");

    await db
      .update(user)
      .set({
        banned: data.banned,
        bannedReason: data.banned ? reason : null,
        updatedAt: new Date(),
      })
      .where(eq(user.id, data.userId));

    // 封禁须立即撤销现有访问：删除目标的所有会话行，被封用户的活跃会话不再有效。
    // 否则其 7 天会话仍可调用受保护操作（protectedAction 的 banned 复查也会拦，但删行更彻底）。
    if (data.banned) {
      await db.delete(session).where(eq(session.userId, data.userId));
    }

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: data.banned ? "user.ban" : "user.unban",
      reason,
      before: {
        banned: targetUser.banned,
        bannedReason: targetUser.bannedReason,
      },
      after: {
        banned: data.banned,
        bannedReason: data.banned ? reason : null,
      },
    });

    revalidatePath("/dashboard/users");
    return {
      message: data.banned ? "用户已被封禁" : "用户已被解封",
    };
  });

export const adminGrantCreditsAction = withAdminUsersAction("grantCredits")
  .schema(adminGrant.input)
  .action(async ({ parsedInput: data, ctx }) => {
    let result: AdminCreditGrantResult;
    try {
      result = await invokeOperation<AdminCreditGrantResult>(
        adminGrant.name,
        data,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    } catch (error) {
      if (error instanceof OperationError && error.code !== "internal_error") {
        throw new ActionUserError(error.message);
      }
      throw error;
    }
    revalidatePath("/dashboard/users");
    return {
      message: result.alreadyGranted
        ? "该充值请求已处理，本次未重复发放积分"
        : `已为用户充值 ${result.amount} 积分`,
      ...result,
    };
  });

export const adminAdjustCreditsAction = withSuperAdminUsersAction(
  "adjustCredits"
)
  .schema(adjustCreditsSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    await getUserBasicOrThrow(data.userId);

    // 仅支持"扣减"(已去掉"覆盖余额"路径):从用户积分批次按 FIFO 扣除指定数量。
    const amount = normalizeAdminCreditAmount(data.amount);
    const before = await getCreditsBalance(data.userId);
    const beforeBalance = normalizeAdminCreditAmount(before.balance);

    if (amount > beforeBalance) {
      throw new ActionUserError(
        `用户余额不足,当前余额 ${beforeBalance},无法扣减 ${amount}`
      );
    }

    const consumeResult = await consumeCredits({
      userId: data.userId,
      amount,
      serviceName: "admin_credit_adjustment",
      description: `超管手动扣减积分: ${data.reason}`,
      metadata: {
        adminUserId: ctx.userId,
        reason: data.reason,
        previousBalance: beforeBalance,
      },
    });

    const after = await getCreditsBalance(data.userId);
    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: "credits.deduct",
      reason: data.reason,
      before: {
        balance: beforeBalance,
        status: before.status,
      },
      after: {
        balance: after.balance,
        status: after.status,
      },
      metadata: {
        amount,
        operationResult: {
          type: "consume",
          success: consumeResult.success,
          consumedAmount: consumeResult.consumedAmount,
          remainingBalance: consumeResult.remainingBalance,
          transactionId: consumeResult.transactionId,
          consumedBatches: consumeResult.consumedBatches,
        },
      },
    });

    revalidatePath("/dashboard/users");
    return {
      message: `已扣减 ${amount} 积分`,
      balance: after.balance,
    };
  });

export const setUserPlanAction = withSuperAdminUsersAction("setUserPlan")
  .schema(setUserPlanSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    await getUserBasicOrThrow(data.userId);

    const [before] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.userId, data.userId))
      .limit(1);

    const now = new Date();
    if (data.plan === "free") {
      if (before) {
        await db
          .update(subscription)
          .set({
            status: "canceled",
            currentPeriodEnd: now,
            cancelAtPeriodEnd: false,
            updatedAt: now,
          })
          .where(eq(subscription.userId, data.userId));
      }
    } else {
      const priceId = getMonthlyPriceIdForPlan(data.plan);
      const subscriptionData = {
        subscriptionId: before?.subscriptionId ?? `manual:${data.userId}`,
        priceId,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        updatedAt: now,
      };

      if (before) {
        await db
          .update(subscription)
          .set(subscriptionData)
          .where(eq(subscription.userId, data.userId));
      } else {
        await db.insert(subscription).values({
          id: crypto.randomUUID(),
          userId: data.userId,
          ...subscriptionData,
        });
      }
    }

    const [after] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.userId, data.userId))
      .limit(1);

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: "subscription.plan.set",
      reason: data.reason,
      before,
      after,
      metadata: {
        targetPlan: data.plan,
        grantPlanCredits: false,
        note: "Manual plan change only updates subscription state and does not grant plan credits.",
      },
    });

    revalidatePath("/dashboard/users");
    return {
      message:
        data.plan === "free"
          ? "已将用户套餐改为 Free，不发放套餐积分"
          : `已将用户套餐改为 ${data.plan.toUpperCase()}，不发放套餐积分`,
    };
  });

export const setUserCreditsStatusAction = withAdminUsersAction(
  "setCreditsStatus"
)
  .schema(setCreditsStatusSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    const targetUser = await getUserBasicOrThrow(data.userId);
    assertCanActOnTarget(
      ctx.role,
      targetUser.role,
      data.status === "frozen" ? "冻结积分" : "解冻积分"
    );

    const [before] = await db
      .select()
      .from(creditsBalance)
      .where(eq(creditsBalance.userId, data.userId))
      .limit(1);

    if (data.status === "frozen") {
      await freezeCreditsAccount(data.userId);
    } else {
      await unfreezeCreditsAccount(data.userId);
    }

    const [after] = await db
      .select()
      .from(creditsBalance)
      .where(eq(creditsBalance.userId, data.userId))
      .limit(1);

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: data.status === "frozen" ? "credits.freeze" : "credits.unfreeze",
      reason: data.reason,
      before: before
        ? {
            status: before.status,
            balance: before.balance,
          }
        : undefined,
      after: after
        ? {
            status: after.status,
            balance: after.balance,
          }
        : undefined,
    });

    revalidatePath("/dashboard/users");
    return {
      message: data.status === "frozen" ? "积分账户已冻结" : "积分账户已解冻",
    };
  });

export const setExternalApiKeyStatusAction = withAdminUsersAction(
  "setExternalApiKeyStatus"
)
  .schema(setExternalApiKeyStatusSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    const [apiKey] = await db
      .select({
        id: externalApiKey.id,
        userId: externalApiKey.userId,
        name: externalApiKey.name,
        keyPrefix: externalApiKey.keyPrefix,
        lastFour: externalApiKey.lastFour,
        isActive: externalApiKey.isActive,
        revokedAt: externalApiKey.revokedAt,
      })
      .from(externalApiKey)
      .where(eq(externalApiKey.id, data.keyId))
      .limit(1);

    if (!apiKey) {
      throw new ActionUserError("API Key 不存在");
    }

    // 必须以数据库中的 Key 所有者为目标校验角色，不能只验证操作者具有管理员身份。
    const targetUser = await getUserBasicOrThrow(apiKey.userId);
    assertCanActOnTarget(
      ctx.role,
      targetUser.role,
      data.isActive ? "启用 API Key" : "禁用 API Key"
    );

    if (data.isActive && apiKey.revokedAt != null) {
      throw new ActionUserError(
        "API Key 已被用户撤销，不能重新启用，请创建新 Key"
      );
    }

    const updatedKeys = await db
      .update(externalApiKey)
      .set({ isActive: data.isActive, updatedAt: new Date() })
      .where(
        and(
          eq(externalApiKey.id, data.keyId),
          // 读取后用户仍可撤销；条件更新与数据库约束共同保证并发撤销胜出。
          data.isActive ? isNull(externalApiKey.revokedAt) : undefined
        )
      )
      .returning({ id: externalApiKey.id });
    if (updatedKeys.length === 0) {
      throw new ActionUserError("API Key 状态已变化，请刷新后重试");
    }

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: apiKey.userId,
      action: data.isActive
        ? "external_api_key.enable"
        : "external_api_key.disable",
      reason: data.reason,
      before: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        lastFour: apiKey.lastFour,
        isActive: apiKey.isActive,
      },
      after: {
        id: apiKey.id,
        isActive: data.isActive,
      },
    });

    revalidatePath("/dashboard/users");
    return {
      message: data.isActive ? "API Key 已启用" : "API Key 已禁用",
    };
  });

// 管理员手动创建用户
//
// 流程对齐 bootstrap-super-admin.ts 已验证范式：先规范化邮箱并双重查重
//（registration_identity 账本 + user.email 唯一约束兜底），再 insert user →
// insert account(credential, accountId=userId, password=hash) → 初始化积分账户 →
// 登记注册身份。直接 db.insert 不触发 Better Auth 的 databaseHooks（管理员代建号
// 不受公开注册域名白名单约束），与 bootstrap 一致。审计日志不落任何明文/哈希密码。
export const createUserAction = withSuperAdminUsersAction("createUser")
  .schema(createUserSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    // 规范化邮箱（去空格 + 小写），与注册链路一致；user 表查重用此原始地址，
    // registration_identity 查重用 canonical 键（去 Gmail 点号/+tag），两套键互补
    const email = normalizeEmail(data.email);

    // 查重一：注册身份账本（含已删号占位/别名归一）
    if (await isRegistrationEmailTaken(email)) {
      throw new Error("该邮箱已被注册或占用");
    }
    // 查重二：user.email 唯一约束兜底
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${email}`)
      .limit(1);
    if (existing) {
      throw new Error("该邮箱已被注册或占用");
    }

    const userId = randomUUID();
    const now = new Date();

    // 1) 插入用户行（管理员建号：角色与邮箱验证状态由超管显式设置）
    await db.insert(user).values({
      id: userId,
      name: data.name,
      email,
      emailVerified: data.emailVerified,
      role: data.role,
      createdAt: now,
      updatedAt: now,
    });

    // 2) 插入邮密认证记录：providerId="credential"、accountId=userId、password=哈希
    //    与 bootstrap-super-admin.ts 完全一致，登录时 Better Auth 自动校验
    await db.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(data.password),
      createdAt: now,
      updatedAt: now,
    });

    // 3) 初始化积分账户（余额 0；后续可用加积分功能充值）
    await ensureCreditsBalance(userId);

    // 4) 登记注册身份账本，占位该邮箱，防止重复注册领取新用户奖励
    await recordRegistrationIdentity(email, userId);

    // 审计日志：仅记录非敏感快照，绝不写入明文/哈希密码
    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: userId,
      action: "user.create",
      reason: data.reason,
      after: {
        id: userId,
        name: data.name,
        email,
        role: data.role,
        emailVerified: data.emailVerified,
      },
      metadata: { passwordSet: true },
    });

    revalidatePath("/dashboard/users");
    return {
      message: `已创建用户 ${email}`,
      userId,
    };
  });

// 编辑用户基础资料（用户名 / 绑定邮箱 / 邮箱验证状态）
//
// 改名仅更新 user.name；改邮箱需规范化 + 双重查重（排除自身），更新 user.email 后
// 同步 registration_identity 指向新邮箱。仅写入本次实际传入的字段，保持局部更新。
export const updateUserProfileAction = withSuperAdminUsersAction(
  "updateUserProfile"
)
  .schema(updateUserProfileSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    const targetUser = await getUserBasicOrThrow(data.userId);

    // 收集本次实际变更字段（仅写传入项，保持局部更新）
    const updates: {
      name?: string;
      email?: string;
      emailVerified?: boolean;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    let normalizedNewEmail: string | null = null;
    if (data.email !== undefined) {
      normalizedNewEmail = normalizeEmail(data.email);
      // 邮箱无变化时跳过查重；有变化则双重查重（排除自身）
      if (normalizedNewEmail !== normalizeEmail(targetUser.email)) {
        if (await isRegistrationEmailTaken(normalizedNewEmail)) {
          throw new Error("该邮箱已被注册或占用");
        }
        const [conflict] = await db
          .select({ id: user.id })
          .from(user)
          .where(
            and(
              sql`lower(${user.email}) = ${normalizedNewEmail}`,
              sql`${user.id} <> ${data.userId}`
            )
          )
          .limit(1);
        if (conflict) {
          throw new Error("该邮箱已被注册或占用");
        }
        updates.email = normalizedNewEmail;
      }
    }
    if (data.name !== undefined) {
      updates.name = data.name;
    }
    if (data.emailVerified !== undefined) {
      updates.emailVerified = data.emailVerified;
    }

    await db.update(user).set(updates).where(eq(user.id, data.userId));

    // 邮箱真正变更时，同步注册身份账本指向新邮箱（防止旧账本残留导致占位错乱）
    if (updates.email) {
      await recordRegistrationIdentity(updates.email, data.userId);
    }

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: "user.profile.update",
      reason: data.reason,
      before: {
        name: targetUser.name,
        email: targetUser.email,
        emailVerified: targetUser.emailVerified,
      },
      after: {
        name: updates.name ?? targetUser.name,
        email: updates.email ?? targetUser.email,
        emailVerified: updates.emailVerified ?? targetUser.emailVerified,
      },
    });

    revalidatePath("/dashboard/users");
    return { message: "用户资料已更新" };
  });

// 重设用户密码
//
// 查该用户的 credential 账户（providerId="credential"）：存在则覆盖哈希；不存在
//（纯 OAuth 用户）则新增一条 credential 记录，从而赋予其邮密登录能力。
// 哈希走 better-auth/crypto 的 hashPassword；审计日志不落任何明文/哈希密码。
export const setUserPasswordAction = withSuperAdminUsersAction(
  "setUserPassword"
)
  .schema(setUserPasswordSchema)
  .action(async ({ parsedInput: data, ctx }) => {
    await getUserBasicOrThrow(data.userId);

    const passwordHash = await hashPassword(data.password);
    const now = new Date();

    // 查该用户既有的邮密认证记录（providerId="credential"）
    const [credential] = await db
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.userId, data.userId),
          eq(account.providerId, "credential")
        )
      )
      .limit(1);

    if (credential) {
      // 已有邮密记录：直接覆盖哈希
      await db
        .update(account)
        .set({ password: passwordHash, updatedAt: now })
        .where(eq(account.id, credential.id));
    } else {
      // 纯 OAuth 用户尚无邮密记录：新增一条，赋予其邮密登录能力
      await db.insert(account).values({
        id: randomUUID(),
        accountId: data.userId,
        providerId: "credential",
        userId: data.userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 管理员重设密码多用于账号被盗或遗忘：吊销该用户全部会话，旧会话不再随新密码继续有效。
    const revokedSessions = await db
      .delete(session)
      .where(eq(session.userId, data.userId))
      .returning({ id: session.id });

    await writeAdminAuditLog({
      adminUserId: ctx.userId,
      targetUserId: data.userId,
      action: "user.password.reset",
      reason: data.reason,
      // 仅记录操作发生，绝不写入明文或哈希
      metadata: {
        credentialCreated: !credential,
        sessionsRevoked: revokedSessions.length,
      },
    });

    revalidatePath("/dashboard/users");
    return { message: "用户密码已重设" };
  });
