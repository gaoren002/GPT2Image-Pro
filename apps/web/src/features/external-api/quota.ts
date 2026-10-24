import { db } from "@repo/database";
import { externalApiKey } from "@repo/database/schema";
import { and, eq } from "drizzle-orm";

import {
  getExternalApiKeyQuotaRemaining,
  roundQuotaCredits,
} from "./quota-math";

// 纯逻辑已抽到 quota-math.ts（DB-free 可单测），此处 re-export 保持调用方导入路径不变。
// Key 额度的扣减与退回已并入消费/退款事务（credits/core），这里只保留查询。
export {
  getExternalApiKeyQuotaRemaining,
  normalizeExternalApiKeyCreditLimit,
} from "./quota-math";

export async function getExternalApiKeyQuota(params: {
  apiKeyId: string;
  userId: string;
}) {
  const [key] = await db
    .select({
      id: externalApiKey.id,
      name: externalApiKey.name,
      keyPrefix: externalApiKey.keyPrefix,
      lastFour: externalApiKey.lastFour,
      isActive: externalApiKey.isActive,
      creditLimit: externalApiKey.creditLimit,
      creditsUsed: externalApiKey.creditsUsed,
      lastUsedAt: externalApiKey.lastUsedAt,
      createdAt: externalApiKey.createdAt,
    })
    .from(externalApiKey)
    .where(
      and(
        eq(externalApiKey.id, params.apiKeyId),
        eq(externalApiKey.userId, params.userId)
      )
    )
    .limit(1);

  if (!key) {
    throw new Error("API key not found");
  }

  const creditLimit = key.creditLimit ?? null;
  const creditsUsed = roundQuotaCredits(Number(key.creditsUsed || 0));
  return {
    ...key,
    creditLimit,
    creditsUsed,
    creditsRemaining: getExternalApiKeyQuotaRemaining(creditLimit, creditsUsed),
  };
}
