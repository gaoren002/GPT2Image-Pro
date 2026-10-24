"use server";

/** 用户自定义 API 设置；复用公共 URL 校验，测活由 health-check 的安全传输执行。 */

import { db } from "@repo/database";
import { userApiConfig } from "@repo/database/schema";
import { protectedAction } from "@repo/shared/safe-action";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { checkImageBackendApiHealth } from "@/features/image-backend-pool/health-check";
import { assertSafeApiBaseUrl } from "@/features/image-generation/safe-api-fetch";

const optionalTrimmedString = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const apiModelMappingEntrySchema = z.object({
  from: z.string().trim().min(1).max(120),
  to: z.string().trim().min(1).max(120),
  whenQuality: z
    .enum(["high", "medium", "low", "auto", "xhigh", "max"])
    .optional(),
  setQuality: z
    .enum(["high", "medium", "low", "auto", "xhigh", "max"])
    .optional(),
});

const apiConfigSchema = z.object({
  baseUrl: z.string().trim().url("Use a valid HTTPS API base URL"),
  apiKey: z.string().trim().min(1, "API key is required"),
  model: optionalTrimmedString,
  modelMapping: z.array(apiModelMappingEntrySchema).max(50).optional(),
  useStream: z.boolean().optional(),
  chatCompletionsUpstreamMode: z
    .enum(["responses", "chat_completions", "images"])
    .default("responses"),
});

const withApiConfigAction = (name: string) =>
  protectedAction.metadata({ action: `settings.apiConfig.${name}` });

async function ensureCustomApiAllowed(userId: string) {
  const plan = await getUserPlan(userId);
  if (!(await canUsePlanCapability(plan.plan, "customApi.configure"))) {
    throw new Error(
      "Custom API configuration requires Starter plan or higher."
    );
  }
}

export const getApiConfig = withApiConfigAction("get").action(
  async ({ ctx }) => {
    const config = await db
      .select()
      .from(userApiConfig)
      .where(eq(userApiConfig.userId, ctx.userId))
      .limit(1);
    return config[0] || null;
  }
);

export const saveApiConfig = withApiConfigAction("save")
  .schema(apiConfigSchema)
  .action(async ({ parsedInput, ctx }) => {
    await ensureCustomApiAllowed(ctx.userId);
    // 保存前复查 DNS；连接时仍由公共传输 pin IP，不能用保存结果信任后续请求。
    await assertSafeApiBaseUrl(parsedInput.baseUrl);

    const existing = await db
      .select()
      .from(userApiConfig)
      .where(eq(userApiConfig.userId, ctx.userId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(userApiConfig)
        .set({
          baseUrl: parsedInput.baseUrl,
          apiKey: parsedInput.apiKey,
          model: parsedInput.model || null,
          modelMapping: parsedInput.modelMapping?.length
            ? parsedInput.modelMapping
            : null,
          useStream: parsedInput.useStream ?? false,
          chatCompletionsUpstreamMode: parsedInput.chatCompletionsUpstreamMode,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(userApiConfig.userId, ctx.userId));
    } else {
      await db.insert(userApiConfig).values({
        id: nanoid(),
        userId: ctx.userId,
        baseUrl: parsedInput.baseUrl,
        apiKey: parsedInput.apiKey,
        model: parsedInput.model || null,
        modelMapping: parsedInput.modelMapping?.length
          ? parsedInput.modelMapping
          : null,
        useStream: parsedInput.useStream ?? false,
        chatCompletionsUpstreamMode: parsedInput.chatCompletionsUpstreamMode,
        isActive: true,
      });
    }

    return { success: true };
  });

export const deleteApiConfig = withApiConfigAction("delete").action(
  async ({ ctx }) => {
    await db.delete(userApiConfig).where(eq(userApiConfig.userId, ctx.userId));
    return { success: true };
  }
);

export const toggleApiConfig = withApiConfigAction("toggle")
  .schema(z.object({ isActive: z.boolean() }))
  .action(async ({ parsedInput, ctx }) => {
    if (parsedInput.isActive) {
      await ensureCustomApiAllowed(ctx.userId);
    }

    await db
      .update(userApiConfig)
      .set({
        isActive: parsedInput.isActive,
        updatedAt: new Date(),
      })
      .where(eq(userApiConfig.userId, ctx.userId));
    return { success: true };
  });

const apiTestSchema = z.object({
  baseUrl: z.string().trim().url("Use a valid HTTPS API base URL"),
  apiKey: z.string().trim().min(1, "API key is required"),
  model: optionalTrimmedString,
  modelMapping: z.array(apiModelMappingEntrySchema).max(50).optional(),
});

/**
 * 测活：对用户填写（或已保存）的自定义 API 端点发起一次真实最小生图请求，
 * 看上游是否真的返回图片（而非仅探连通性）。
 *
 * 入参为当前表单值，便于"保存前先测"。能力门禁与 SSRF 防护：
 * - 需 `customApi.configure` 能力，避免被当作 SSRF/扫描代理；
 * - baseUrl 经公共 HTTPS/DNS 校验，真实出图传输固定已验证 IP 并拒绝重定向。
 * 复用真实出图原语（reportResult=false，不计费/不落库/不改统计），但会真实消耗
 * 上游 1 张图额度；返回结构化结果由前端本地化展示。
 */
export const testApiConfig = withApiConfigAction("test")
  .schema(apiTestSchema)
  .action(async ({ parsedInput, ctx }) => {
    await ensureCustomApiAllowed(ctx.userId);
    await assertSafeApiBaseUrl(parsedInput.baseUrl);
    return checkImageBackendApiHealth({
      baseUrl: parsedInput.baseUrl,
      apiKey: parsedInput.apiKey,
      model: parsedInput.model ?? null,
      modelMapping: parsedInput.modelMapping,
      backendType: "user-api",
    });
  });
