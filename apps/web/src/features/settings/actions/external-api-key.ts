"use server";

import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { db } from "@repo/database";
import { externalApiKey } from "@repo/database/schema";
import { normalizeExternalApiKeyCreditLimit } from "@/features/external-api/quota";
import { listImageBackendGroupOptions } from "@/features/image-backend-pool/service";
import { protectedAction } from "@repo/shared/safe-action";
import {
  canUsePlanCapability,
  normalizePlanModerationBlockRiskLevel,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";

const API_KEY_PREFIX = "g2i";

function hashApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function createApiKey() {
  return `${API_KEY_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

const withExternalApiKeyAction = (name: string) =>
  protectedAction.metadata({ action: `settings.externalApiKey.${name}` });

async function ensureExternalApiAllowed(userId: string) {
  const plan = await getUserPlan(userId);
  if (!(await canUsePlanCapability(plan.plan, "externalApi.keys.manage"))) {
    throw new Error("External API access requires Starter plan or higher.");
  }
  return plan.plan;
}

async function normalizeSelectableGenerationGroupId(
  groupId: string | null | undefined,
  plan: Awaited<ReturnType<typeof getUserPlan>>["plan"]
) {
  if (!groupId || groupId === "default") return null;
  if (!(await canUsePlanCapability(plan, "backendGroups.select"))) {
    throw new Error("当前套餐不可手动选择生图分组");
  }
  const groups = await listImageBackendGroupOptions({
    userSelectableOnly: true,
    plan,
  });
  if (!groups.some((group) => group.id === groupId)) {
    throw new Error("Image backend group is not selectable");
  }
  return groupId;
}

async function normalizeRelayOnly(
  relayOnly: boolean | undefined,
  plan: Awaited<ReturnType<typeof getUserPlan>>["plan"]
) {
  if (!relayOnly) return false;
  if (!(await canUsePlanCapability(plan, "externalApi.relay"))) {
    throw new Error("纯中转模式需要 Pro 及以上套餐");
  }
  return true;
}

export const getExternalApiKeys = withExternalApiKeyAction("list").action(
  async ({ ctx }) => {
    const plan = await getUserPlan(ctx.userId);
    const keys = await db
      .select({
        id: externalApiKey.id,
        name: externalApiKey.name,
        keyPrefix: externalApiKey.keyPrefix,
        lastFour: externalApiKey.lastFour,
        moderationBlockRiskLevel: externalApiKey.moderationBlockRiskLevel,
        generationGroupId: externalApiKey.generationGroupId,
        creditLimit: externalApiKey.creditLimit,
        creditsUsed: externalApiKey.creditsUsed,
        relayOnly: externalApiKey.relayOnly,
        asyncTaskMode: externalApiKey.asyncTaskMode,
        lastUsedAt: externalApiKey.lastUsedAt,
        isActive: externalApiKey.isActive,
        createdAt: externalApiKey.createdAt,
      })
      .from(externalApiKey)
      .where(eq(externalApiKey.userId, ctx.userId))
      .orderBy(desc(externalApiKey.createdAt));

    const groups = await listImageBackendGroupOptions({
      userSelectableOnly: true,
      plan: plan.plan,
    });
    const canUseRelay = await canUsePlanCapability(
      plan.plan,
      "externalApi.relay"
    );
    return { keys, groups, canUseRelay };
  }
);

export const createExternalApiKey = withExternalApiKeyAction("create")
  .schema(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      moderationBlockRiskLevel: z.enum(["low", "medium", "high"]).optional(),
      generationGroupId: z.string().trim().optional().nullable(),
      creditLimit: z.number().min(0).nullable().optional(),
      relayOnly: z.boolean().optional(),
      asyncTaskMode: z.boolean().optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const plan = await ensureExternalApiAllowed(ctx.userId);

    const apiKey = createApiKey();
    const keyPrefix = apiKey.slice(0, 7);
    const generationGroupId = await normalizeSelectableGenerationGroupId(
      parsedInput.generationGroupId,
      plan
    );
    const relayOnly = await normalizeRelayOnly(parsedInput.relayOnly, plan);

    await db.insert(externalApiKey).values({
      id: nanoid(),
      userId: ctx.userId,
      name: parsedInput.name || "默认 API Key",
      keyPrefix,
      keyHash: hashApiKey(apiKey),
      lastFour: apiKey.slice(-4),
      moderationBlockRiskLevel: await normalizePlanModerationBlockRiskLevel(
        plan,
        parsedInput.moderationBlockRiskLevel
      ),
      generationGroupId,
      creditLimit: normalizeExternalApiKeyCreditLimit(parsedInput.creditLimit),
      relayOnly,
      asyncTaskMode: parsedInput.asyncTaskMode === true,
    });

    return { apiKey };
  });

export const revokeExternalApiKey = withExternalApiKeyAction("revoke")
  .schema(
    z.object({
      id: z.string().min(1),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const keys = await db
      .select({ id: externalApiKey.id })
      .from(externalApiKey)
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      )
      .limit(1);

    if (!keys[0]) {
      throw new Error("API key not found");
    }

    await db
      .update(externalApiKey)
      .set({
        isActive: false,
        revokedAt: sql`COALESCE(${externalApiKey.revokedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true };
  });

export const deleteExternalApiKey = withExternalApiKeyAction("delete")
  .schema(
    z.object({
      id: z.string().min(1),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const keys = await db
      .select({ id: externalApiKey.id, isActive: externalApiKey.isActive })
      .from(externalApiKey)
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      )
      .limit(1);

    if (!keys[0]) {
      throw new Error("API key not found");
    }
    if (keys[0].isActive) {
      throw new Error("Revoke API key before deleting it");
    }

    await db
      .delete(externalApiKey)
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId),
          eq(externalApiKey.isActive, false)
        )
      );

    return { success: true };
  });

export const updateExternalApiKeyModeration = withExternalApiKeyAction(
  "updateModeration"
)
  .schema(
    z.object({
      id: z.string().min(1),
      moderationBlockRiskLevel: z.enum(["low", "medium", "high"]),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const plan = await ensureExternalApiAllowed(ctx.userId);
    const normalized = await normalizePlanModerationBlockRiskLevel(
      plan,
      parsedInput.moderationBlockRiskLevel
    );

    await db
      .update(externalApiKey)
      .set({
        moderationBlockRiskLevel: normalized,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true, moderationBlockRiskLevel: normalized };
  });

export const updateExternalApiKeyGroup = withExternalApiKeyAction("updateGroup")
  .schema(
    z.object({
      id: z.string().min(1),
      generationGroupId: z.string().trim().optional().nullable(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const plan = await ensureExternalApiAllowed(ctx.userId);
    const generationGroupId = await normalizeSelectableGenerationGroupId(
      parsedInput.generationGroupId,
      plan
    );
    await db
      .update(externalApiKey)
      .set({
        generationGroupId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true };
  });

export const updateExternalApiKeyQuota = withExternalApiKeyAction("updateQuota")
  .schema(
    z.object({
      id: z.string().min(1),
      creditLimit: z.number().min(0).nullable(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureExternalApiAllowed(ctx.userId);
    const creditLimit = normalizeExternalApiKeyCreditLimit(
      parsedInput.creditLimit
    );

    await db
      .update(externalApiKey)
      .set({
        creditLimit,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true, creditLimit };
  });

export const updateExternalApiKeyRelay = withExternalApiKeyAction("updateRelay")
  .schema(
    z.object({
      id: z.string().min(1),
      relayOnly: z.boolean(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const plan = await ensureExternalApiAllowed(ctx.userId);
    // 仅 Pro+ 可开启纯中转；关闭（false）任何套餐都允许。
    const relayOnly = await normalizeRelayOnly(parsedInput.relayOnly, plan);

    await db
      .update(externalApiKey)
      .set({
        relayOnly,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true, relayOnly };
  });

/**
 * 开关异步任务模式（兼容速度马）：开启后该 Key 的生图/编辑一律异步、立即返回 requestId，
 * 结果用 GET /v1/tasks/{requestId} 查询。只改响应格式，不涉及额外权限，任何可用外接 API
 * 的套餐都可开关。只更新本人的 Key。
 */
export const updateExternalApiKeyAsyncTaskMode = withExternalApiKeyAction(
  "updateAsyncTaskMode"
)
  .schema(
    z.object({
      id: z.string().min(1),
      asyncTaskMode: z.boolean(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureExternalApiAllowed(ctx.userId);
    await db
      .update(externalApiKey)
      .set({
        asyncTaskMode: parsedInput.asyncTaskMode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(externalApiKey.id, parsedInput.id),
          eq(externalApiKey.userId, ctx.userId)
        )
      );

    return { success: true, asyncTaskMode: parsedInput.asyncTaskMode };
  });
