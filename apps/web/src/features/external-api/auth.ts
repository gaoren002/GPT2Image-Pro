/** 外接 API Key 鉴权与套餐复核；使用时间最多每分钟写一次，不缓存授权状态。 */
import { db } from "@repo/database";
import { externalApiKey, user } from "@repo/database/schema";
import {
  isModerationBlockRiskLevel,
  type ModerationBlockRiskLevel,
} from "@repo/shared/config/subscription-plan";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { describeErrorForLog } from "@repo/shared/db/error-summary";
import { logWarn } from "@repo/shared/logger";
import { and, eq, isNull, lt, or } from "drizzle-orm";

import { getBearerToken, hashApiKey, safeEqual } from "./auth-token";

/** 返回已核验身份和额度快照或 null；鉴权读失败上抛，遥测写失败只告警。 */
export async function authenticateExternalApiRequest(request: Request) {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const keyHash = hashApiKey(token);
  const keys = await db
    .select({
      id: externalApiKey.id,
      userId: externalApiKey.userId,
      keyHash: externalApiKey.keyHash,
      moderationBlockRiskLevel: externalApiKey.moderationBlockRiskLevel,
      creditLimit: externalApiKey.creditLimit,
      creditsUsed: externalApiKey.creditsUsed,
      lastUsedAt: externalApiKey.lastUsedAt,
      relayOnly: externalApiKey.relayOnly,
      asyncTaskMode: externalApiKey.asyncTaskMode,
      userBanned: user.banned,
    })
    .from(externalApiKey)
    .innerJoin(user, eq(user.id, externalApiKey.userId))
    .where(
      and(
        eq(externalApiKey.keyHash, keyHash),
        eq(externalApiKey.isActive, true)
      )
    )
    .limit(1);

  const apiKey = keys[0];
  if (!apiKey || apiKey.userBanned || !safeEqual(keyHash, apiKey.keyHash)) {
    return null;
  }

  const plan = await getUserPlan(apiKey.userId);

  // 请求期复核纯中转权限：套餐降级后立即失效（不依赖降级钩子重置 DB 列）。
  // 失去 externalApi.relay 能力的 key 退回普通模式（仍记录/存储），不报错。
  const relayOnly =
    apiKey.relayOnly === true &&
    (await canUsePlanCapability(plan.plan, "externalApi.relay"));

  const now = new Date();
  const usageCutoff = new Date(now.getTime() - 60_000);
  if (!apiKey.lastUsedAt || apiKey.lastUsedAt < usageCutoff) {
    // 高频轮询不应每次改同一行。SQL 再检时间，避免并发请求的旧快照重复写入。
    // 这是遥测，不是授权条件；写失败必须告警，但不能拒绝已核验的 Key。
    try {
      await db
        .update(externalApiKey)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(
          and(
            eq(externalApiKey.id, apiKey.id),
            eq(externalApiKey.isActive, true),
            or(
              isNull(externalApiKey.lastUsedAt),
              lt(externalApiKey.lastUsedAt, usageCutoff)
            )
          )
        );
    } catch (error) {
      logWarn("API Key 使用时间记录失败", {
        apiKeyId: apiKey.id,
        error: describeErrorForLog(error),
      });
    }
  }

  return {
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    plan: plan.plan,
    moderationBlockRiskLevel: (isModerationBlockRiskLevel(
      apiKey.moderationBlockRiskLevel
    )
      ? apiKey.moderationBlockRiskLevel
      : "low") satisfies ModerationBlockRiskLevel,
    creditLimit: apiKey.creditLimit ?? null,
    creditsUsed: Number(apiKey.creditsUsed || 0),
    relayOnly,
    // 异步任务模式只改提交响应与查询格式，不涉及额外权限，无需按套餐复核。
    asyncTaskMode: apiKey.asyncTaskMode === true,
  };
}
