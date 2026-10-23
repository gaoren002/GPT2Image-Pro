/**
 * 管理员用户列表的共享查询服务，供 SSR 首屏和既有 adminAction 调用。
 * 调用方必须先验证会话；本入口再断言其服务端取得的角色，仅允许 admin/super_admin。
 * 复用既有字段投影与统计，不读取密码、会话内容或 API Key 明文。
 */
import { db } from "@repo/database";
import {
  creditsBalance,
  externalApiKey,
  generation,
  subscription,
  user,
} from "@repo/database/schema";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ADMIN_MANAGEMENT_ROLES, canAccessAdminArea } from "../../auth/roles";
import { PRICE_IDS } from "../../config/payment";
import {
  getPlanFromPriceId,
  type SubscriptionPlan,
} from "../../config/subscription-plan";

const userStatusSchema = z.enum(["all", "active", "banned", "unverified"]);
const subscriptionStatusSchema = z.enum([
  "all",
  "none",
  "active",
  "canceled",
  "past_due",
  "incomplete",
]);
const creditsStatusSchema = z.enum(["all", "active", "frozen"]);
const planFilterSchema = z.enum([
  "all",
  "free",
  "starter",
  "pro",
  "ultra",
  "enterprise",
]);

export const listUsersSchema = z
  .object({
    query: z.string().trim().optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(10).max(100).default(20),
    status: userStatusSchema.default("all"),
    subscriptionStatus: subscriptionStatusSchema.default("all"),
    creditsStatus: creditsStatusSchema.default("all"),
    plan: planFilterSchema.default("all"),
  })
  .optional();

type ListUsersInput = z.infer<typeof listUsersSchema>;
type PlanFilter = z.infer<typeof planFilterSchema>;

/** 将 schema 的可选输入归一为列表查询的既有默认筛选。 */
function normalizeListInput(input: ListUsersInput) {
  return {
    query: input?.query?.trim() || "",
    page: input?.page ?? 1,
    pageSize: input?.pageSize ?? 20,
    status: input?.status ?? "all",
    subscriptionStatus: input?.subscriptionStatus ?? "all",
    creditsStatus: input?.creditsStatus ?? "all",
    plan: input?.plan ?? "all",
  };
}

/** 未知或未配置的价格 ID 沿用免费套餐展示。 */
function getPlanFromSubscriptionPriceId(priceId: string | null | undefined) {
  if (!priceId) {
    return "free" satisfies SubscriptionPlan;
  }
  return getPlanFromPriceId(priceId) ?? ("free" satisfies SubscriptionPlan);
}

/** 根据订阅状态和截止时间判断列表行应显示的套餐；保留原列表语义。 */
function isSubscriptionWithinPeriod(sub: {
  currentPeriodEnd: Date | null;
  status: string | null;
}) {
  if (!sub.status) {
    return false;
  }
  if (sub.status === "lifetime") {
    return true;
  }
  const withinPeriod =
    !sub.currentPeriodEnd || sub.currentPeriodEnd > new Date();
  return (
    (["active", "trialing"].includes(sub.status) && withinPeriod) ||
    (sub.status === "canceled" && withinPeriod)
  );
}

/** 构造原列表的有效订阅 SQL 条件，供套餐筛选和统计复用。 */
function effectiveSubscriptionCondition() {
  return sql<boolean>`(
    ${subscription.status} = 'lifetime'
    OR (
      ${subscription.status} IN ('active', 'trialing')
      AND (
        ${subscription.currentPeriodEnd} IS NULL
        OR ${subscription.currentPeriodEnd} > now()
      )
    )
    OR (
      ${subscription.status} = 'canceled'
      AND ${subscription.currentPeriodEnd} IS NOT NULL
      AND ${subscription.currentPeriodEnd} > now()
    )
  )`;
}

/** 收集目标套餐已配置的价格 ID；未配置时筛选结果应为空。 */
function getPlanPriceIds(plan: Exclude<PlanFilter, "all" | "free">) {
  return Object.values(PRICE_IDS).filter((value): value is string => {
    if (!value) {
      return false;
    }
    return getPlanFromPriceId(value) === plan;
  });
}

/** 使用同一组参数化条件读取实体行与数量，避免 SSR/action 筛选口径漂移。 */
function buildUserFilters(input: ReturnType<typeof normalizeListInput>) {
  const filters = [];

  if (input.query) {
    const query = `%${input.query}%`;
    filters.push(
      or(
        ilike(user.id, query),
        ilike(user.name, query),
        ilike(user.email, query)
      )
    );
  }

  if (input.status === "active") {
    filters.push(eq(user.banned, false));
  } else if (input.status === "banned") {
    filters.push(eq(user.banned, true));
  } else if (input.status === "unverified") {
    filters.push(eq(user.emailVerified, false));
  }

  if (input.creditsStatus !== "all") {
    filters.push(eq(creditsBalance.status, input.creditsStatus));
  }

  if (input.subscriptionStatus === "none") {
    filters.push(sql`${subscription.id} IS NULL`);
  } else if (input.subscriptionStatus !== "all") {
    filters.push(eq(subscription.status, input.subscriptionStatus));
  }

  if (input.plan === "free") {
    filters.push(
      or(
        sql`${subscription.id} IS NULL`,
        sql`NOT ${effectiveSubscriptionCondition()}`
      )
    );
  } else if (input.plan !== "all") {
    const priceIds = getPlanPriceIds(input.plan);
    if (priceIds.length > 0) {
      filters.push(inArray(subscription.priceId, priceIds));
      filters.push(effectiveSubscriptionCondition());
    } else {
      filters.push(sql`false`);
    }
  }

  return filters.length > 0 ? and(...filters) : undefined;
}

/**
 * 查询经认证管理员可见的分页快照；不缓存跨用户结果，数据库失败直接上抛。
 * rawInput 沿用 action 的 schema，undefined 代表默认第一页；角色不能来自客户端输入。
 */
export async function getAdminUsersListSnapshot(
  rawInput: z.input<typeof listUsersSchema>,
  actorRole: string | null | undefined
) {
  if (!canAccessAdminArea(actorRole)) {
    throw new Error("此操作需要管理员权限");
  }
  const input = normalizeListInput(listUsersSchema.parse(rawInput));
  const where = buildUserFilters(input);
  const offset = (input.page - 1) * input.pageSize;

  const baseQuery = db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      banned: user.banned,
      bannedReason: user.bannedReason,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      creditsBalance:
        sql<number>`coalesce(${creditsBalance.balance}, 0)`.mapWith(Number),
      creditsTotalEarned:
        sql<number>`coalesce(${creditsBalance.totalEarned}, 0)`.mapWith(Number),
      creditsTotalSpent:
        sql<number>`coalesce(${creditsBalance.totalSpent}, 0)`.mapWith(Number),
      creditsStatus: creditsBalance.status,
      subscriptionStatus: subscription.status,
      subscriptionPriceId: subscription.priceId,
      subscriptionCurrentPeriodEnd: subscription.currentPeriodEnd,
    })
    .from(user)
    .leftJoin(creditsBalance, eq(creditsBalance.userId, user.id))
    .leftJoin(subscription, eq(subscription.userId, user.id));

  const countQuery = db
    .select({ count: count() })
    .from(user)
    .leftJoin(creditsBalance, eq(creditsBalance.userId, user.id))
    .leftJoin(subscription, eq(subscription.userId, user.id));

  const [rows, totalResult, statsResults] = await Promise.all([
    (where ? baseQuery.where(where) : baseQuery)
      .orderBy(desc(user.createdAt))
      .limit(input.pageSize)
      .offset(offset),
    where ? countQuery.where(where) : countQuery,
    Promise.all([
      db.select({ count: count() }).from(user),
      db
        .select({ count: count() })
        .from(user)
        .where(
          inArray(user.role, ["observer_admin", ...ADMIN_MANAGEMENT_ROLES])
        ),
      db.select({ count: count() }).from(user).where(eq(user.banned, true)),
      db
        .select({ count: count() })
        .from(subscription)
        .where(effectiveSubscriptionCondition()),
    ]),
  ]);

  const userIds = rows.map((row) => row.id);
  const [generationCounts, apiKeyCounts] =
    userIds.length > 0
      ? await Promise.all([
          db
            .select({
              userId: generation.userId,
              total: sql<number>`count(*)`.mapWith(Number),
              failed:
                sql<number>`sum(case when ${generation.status} = 'failed' then 1 else 0 end)`.mapWith(
                  Number
                ),
            })
            .from(generation)
            .where(inArray(generation.userId, userIds))
            .groupBy(generation.userId),
          db
            .select({
              userId: externalApiKey.userId,
              total: sql<number>`count(*)`.mapWith(Number),
              active:
                sql<number>`sum(case when ${externalApiKey.isActive} then 1 else 0 end)`.mapWith(
                  Number
                ),
            })
            .from(externalApiKey)
            .where(inArray(externalApiKey.userId, userIds))
            .groupBy(externalApiKey.userId),
        ])
      : [[], []];

  const generationCountMap = new Map(
    generationCounts.map((item) => [item.userId, item])
  );
  const apiKeyCountMap = new Map(
    apiKeyCounts.map((item) => [item.userId, item])
  );

  return {
    users: rows.map((row) => {
      const generationStats = generationCountMap.get(row.id);
      const apiKeyStats = apiKeyCountMap.get(row.id);
      return {
        ...row,
        plan: isSubscriptionWithinPeriod({
          status: row.subscriptionStatus,
          currentPeriodEnd: row.subscriptionCurrentPeriodEnd,
        })
          ? getPlanFromSubscriptionPriceId(row.subscriptionPriceId)
          : ("free" satisfies SubscriptionPlan),
        creditsStatus: row.creditsStatus ?? "active",
        generationCount: generationStats?.total ?? 0,
        failedGenerationCount: generationStats?.failed ?? 0,
        apiKeyCount: apiKeyStats?.total ?? 0,
        activeApiKeyCount: apiKeyStats?.active ?? 0,
      };
    }),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total: totalResult[0]?.count ?? 0,
    },
    stats: {
      totalUsers: statsResults[0][0]?.count ?? 0,
      admins: statsResults[1][0]?.count ?? 0,
      banned: statsResults[2][0]?.count ?? 0,
      activeSubscriptions: statsResults[3][0]?.count ?? 0,
    },
  };
}

/** SSR 与客户端列表 action 共用的返回类型，类型导入不会带入数据库模块。 */
export type AdminUsersListSnapshot = Awaited<
  ReturnType<typeof getAdminUsersListSnapshot>
>;
