"use server";

import {
  isSubscriptionPlan,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";

import {
  adminAction,
  imageBackendPoolViewerAction,
  protectedAction,
} from "@repo/shared/safe-action";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
  getRuntimeSettingString,
  setSystemSettings,
} from "@repo/shared/system-settings";
import { z } from "zod";

import {
  deleteAdobeAccount,
  importAdobeAccount,
  importAdobeAccountsBatch,
  listAdobeAccounts,
  setAdobeAccountEnabled,
} from "@/features/image-generation/adobe-direct";

import {
  bulkUpdateImageBackendAccounts,
  countAvailableWebAccountsInGroup,
  deleteAllErrorImageBackendAccounts,
  deleteImageBackendGroup,
  deleteImageBackendMembers,
  deleteSub2ApiAutoSyncTask,
  fromSafetyOverride,
  getUserImageBackendPreference,
  importImageBackendAccountsFromRefreshTokens,
  importImageBackendWebAccountsFromAccessTokens,
  isSub2ApiPostgresConfigured,
  listAdminImageBackendAccounts,
  listAdminImageBackendPool,
  listImageBackendGroupOptions,
  listSelectableImageBackendGroups,
  listSub2ApiAutoSyncTasksForAdmin,
  listSub2ApiSourceGroups,
  probeImageBackendApi,
  readSub2ApiSyncProgress,
  refreshImageBackendAccountInfo,
  refreshImageBackendAccountsInfo,
  runSub2ApiAutoSyncTaskNow,
  runSub2ApiManualSync,
  setImageBackendAccountAlwaysActive,
  setImageBackendAdobeAlwaysActive,
  setImageBackendAdobeEnabled,
  setImageBackendApiAlwaysActive,
  setImageBackendApiEnabled,
  setSub2ApiAutoSyncTaskEnabled,
  setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState,
  setUserImageBackendPreference,
  syncImageBackendAccountsFromSub2Api,
  updateSub2ApiAutoSyncTaskOptions,
  upsertImageBackendAccount,
  upsertImageBackendAdobe,
  upsertImageBackendApi,
  upsertImageBackendGroup,
} from "./service";

const nullableGroupIdSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value !== "default" ? value : null));

const optionalGroupIdSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value && value !== "default"
        ? value
        : null
  );

const safetyOverrideSchema = z.enum(["inherit", "enabled", "disabled"]);
const accountBackendSchema = z.enum(["web", "responses"]);
const groupBackendTypeSchema = z.enum(["mixed", "web", "responses"]);
// 分组分辨率档位：full=全参(4K)，standard=仅约 1.2K。默认 standard，与
// service 侧 getGroupSizeTier 的兜底一致（未标注的旧分组按 1.2K 展示）。
const groupSizeTierSchema = z.enum(["standard", "full"]).default("standard");
const apiInterfaceModeSchema = z.enum(["images", "responses", "mixed"]);
// 池 API 尺寸方言：上游对 size 参数的兼容形态（存 metadata.sizeDialect）。
// wxh=直传 WxH（默认）；exact-ratio=吸附到精确比例栅格；ratio-string=发比例串。
const apiSizeDialectSchema = z.enum(["wxh", "exact-ratio", "ratio-string"]);
const chatCompletionsUpstreamModeSchema = z.enum([
  "responses",
  "chat_completions",
  "images",
]);
const imagesUpstreamModeSchema = z.enum(["images", "responses"]);
const sub2ApiTokenSyncModeSchema = z.enum(["web", "responses", "both"]);
const sub2ApiPlanFilterSchema = z.enum([
  "all",
  "free",
  "plus",
  "pro",
  "non_free",
]);
const subscriptionPlanSchema = z
  .string()
  .trim()
  .optional()
  .transform(
    (value): SubscriptionPlan => (isSubscriptionPlan(value) ? value : "free")
  );

const adminAccountListSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(100).default(20),
  groupId: z.string().trim().max(128).default("all"),
  implementationMode: z.enum(["all", "web", "responses"]).default("all"),
  status: z
    .enum(["all", "active", "limited", "error", "disabled", "cooling"])
    .default("all"),
  search: z.string().trim().max(256).default(""),
});

const adminAccountErrorDeleteSchema = adminAccountListSchema.pick({
  groupId: true,
  implementationMode: true,
  search: true,
});

const withImageBackendPoolAdminAction = (name: string) =>
  adminAction.metadata({ action: `imageBackendPool.${name}` });

const withImageBackendPoolViewerAction = (name: string) =>
  imageBackendPoolViewerAction.metadata({ action: `imageBackendPool.${name}` });

export const getSelectableImageBackendGroupsAction = protectedAction
  .metadata({ action: "imageBackendPool.selectableGroups" })
  .action(async ({ ctx }) => {
    const plan = await getUserPlan(ctx.userId);
    const [groups, selectedGroupId] = await Promise.all([
      listSelectableImageBackendGroups(plan.plan),
      getUserImageBackendPreference(ctx.userId, plan.plan),
    ]);
    return { groups, selectedGroupId };
  });

export const setUserImageBackendPreferenceAction = protectedAction
  .metadata({ action: "imageBackendPool.setPreference" })
  .schema(
    z.object({
      groupId: nullableGroupIdSchema,
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const plan = await getUserPlan(ctx.userId);
    await setUserImageBackendPreference(
      ctx.userId,
      parsedInput.groupId,
      plan.plan
    );
    return { success: true };
  });

export const getAdminImageBackendPoolAction = withImageBackendPoolViewerAction(
  "list"
).action(async () => {
  return listAdminImageBackendPool();
});

export const getAdminImageBackendAccountsAction =
  withImageBackendPoolViewerAction("listAccounts")
    .schema(adminAccountListSchema)
    .action(async ({ parsedInput }) => {
      return listAdminImageBackendAccounts(parsedInput);
    });

export const getSub2ApiSyncStatusAction = withImageBackendPoolAdminAction(
  "sub2ApiSyncStatus"
).action(async () => {
  return {
    configured: await isSub2ApiPostgresConfigured(),
  };
});

// 全量同步进行中由前端轮询读取进度(进程内单槽,best-effort)。
export const getSub2ApiSyncProgressAction = withImageBackendPoolAdminAction(
  "sub2ApiSyncProgress"
).action(async () => {
  const progress = readSub2ApiSyncProgress();
  return { progress: progress ? { ...progress } : null };
});

export const getSub2ApiSourceGroupsAction = withImageBackendPoolAdminAction(
  "sub2ApiSourceGroups"
).action(async () => {
  const groups = await listSub2ApiSourceGroups();
  return { groups };
});

export const getSub2ApiAutoSyncTasksAction = withImageBackendPoolAdminAction(
  "sub2ApiAutoSyncTasks"
).action(async () => {
  const tasks = await listSub2ApiAutoSyncTasksForAdmin();
  return { tasks };
});

export const runSub2ApiAutoSyncTaskNowAction = withImageBackendPoolAdminAction(
  "runSub2ApiAutoSyncTaskNow"
)
  .schema(
    z.object({
      taskId: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    return runSub2ApiAutoSyncTaskNow(parsedInput.taskId);
  });

export const setSub2ApiAutoSyncTaskEnabledAction =
  withImageBackendPoolAdminAction("setSub2ApiAutoSyncTaskEnabled")
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        enabled: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setSub2ApiAutoSyncTaskEnabled(parsedInput);
      return { success: true };
    });

export const setSub2ApiAutoSyncTaskOverwriteLocalUnavailableStateAction =
  withImageBackendPoolAdminAction(
    "setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState"
  )
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        overwriteLocalUnavailableState: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState(parsedInput);
      return { success: true };
    });

export const updateSub2ApiAutoSyncTaskOptionsAction =
  withImageBackendPoolAdminAction("updateSub2ApiAutoSyncTaskOptions")
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        enabled: z.boolean(),
        webGroupId: optionalGroupIdSchema,
        responsesGroupId: optionalGroupIdSchema,
        syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
        allowMobileRtImport: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        overwriteLocalUnavailableState: z.boolean().default(true),
        planFilter: sub2ApiPlanFilterSchema.default("non_free"),
        intervalMinutes: z.coerce.number().int().min(1).default(720),
      })
    )
    .action(async ({ parsedInput }) => {
      await updateSub2ApiAutoSyncTaskOptions(parsedInput);
      return { success: true };
    });

export const deleteSub2ApiAutoSyncTaskAction = withImageBackendPoolAdminAction(
  "deleteSub2ApiAutoSyncTask"
)
  .schema(
    z.object({
      taskId: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    await deleteSub2ApiAutoSyncTask(parsedInput.taskId);
    return { success: true };
  });

export const saveImageBackendGroupAction = withImageBackendPoolAdminAction(
  "saveGroup"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(500).optional(),
      isEnabled: z.boolean().default(true),
      isDefault: z.boolean().default(false),
      isUserSelectable: z.boolean().default(true),
      contentSafety: safetyOverrideSchema.default("inherit"),
      backendType: groupBackendTypeSchema.default("mixed"),
      sizeTier: groupSizeTierSchema,
      minPlan: subscriptionPlanSchema,
      billingMultiplier: z.coerce.number().min(0.01).max(100).default(1),
      childGroupIds: z.array(z.string().trim().min(1)).max(100).default([]),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
    })
  )
  .action(async ({ parsedInput }) => {
    const id = await upsertImageBackendGroup({
      id: parsedInput.id,
      name: parsedInput.name,
      description: parsedInput.description || null,
      isEnabled: parsedInput.isEnabled,
      isDefault: parsedInput.isDefault,
      isUserSelectable: parsedInput.isUserSelectable,
      contentSafetyEnabled: fromSafetyOverride(parsedInput.contentSafety),
      backendType: parsedInput.backendType,
      sizeTier: parsedInput.sizeTier,
      minPlan: parsedInput.minPlan,
      billingMultiplier: parsedInput.billingMultiplier,
      childGroupIds: parsedInput.childGroupIds,
      priority: parsedInput.priority,
    });
    return { success: true, id };
  });

export const deleteImageBackendGroupAction = withImageBackendPoolAdminAction(
  "deleteGroup"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    await deleteImageBackendGroup(parsedInput.id);
    return { success: true };
  });

// 质量计价倍率：quality 档位 → 正倍率（只配部分档位）。未配置档位计 1 倍；
// service 侧经 normalizeQualityBillingForStorage 清洗收敛（空表落 null）。
// 池 API 与账号共用。
const qualityBillingSchema = z
  .partialRecord(
    z.enum(["auto", "low", "medium", "high", "xhigh", "max"]),
    z.number().finite().positive().max(100)
  )
  .nullish();

// 池 API 按模型计价（出站模型 id → 统一倍率或质量分档表，精确命中；
// 存 metadata.modelBilling）。键为任意非空模型名（上限 100 条，与
// parseModelBilling 口径一致）。
const modelBillingEntrySchema = z.union([
  z.number().finite().positive().max(100),
  z
    .partialRecord(
      z.enum(["auto", "low", "medium", "high", "xhigh", "max"]),
      z.number().finite().positive().max(100)
    ),
]);
const modelBillingSchema = z
  .record(z.string().trim().min(1).max(120), modelBillingEntrySchema)
  .nullish();

export const saveImageBackendAccountAction = withImageBackendPoolAdminAction(
  "saveAccount"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      groupId: nullableGroupIdSchema,
      groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().max(200).optional(),
      accessToken: z.string().trim().optional(),
      refreshToken: z.string().trim().optional(),
      implementationMode: accountBackendSchema.default("web"),
      model: z.string().trim().max(120).optional(),
      qualityBilling: qualityBillingSchema,
      contentSafetyEnabled: z.boolean().default(true),
      isEnabled: z.boolean().default(true),
      alwaysActive: z.boolean().default(false),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
      concurrency: z.coerce.number().int().min(1).max(100).default(1),
      status: z.string().trim().max(80).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const id = await upsertImageBackendAccount({
      id: parsedInput.id,
      groupId: parsedInput.groupId,
      groupIds: parsedInput.groupIds,
      name: parsedInput.name,
      email: parsedInput.email || null,
      accessToken: parsedInput.accessToken || undefined,
      refreshToken: parsedInput.refreshToken || undefined,
      implementationMode: parsedInput.implementationMode,
      model: parsedInput.model || null,
      qualityBilling: parsedInput.qualityBilling ?? null,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      isEnabled: parsedInput.isEnabled,
      alwaysActive: parsedInput.alwaysActive,
      priority: parsedInput.priority,
      concurrency: parsedInput.concurrency,
      status: parsedInput.status || "active",
    });
    return { success: true, id };
  });

export const bulkUpdateImageBackendAccountsAction =
  withImageBackendPoolAdminAction("bulkUpdateAccounts")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
        groupId: optionalGroupIdSchema,
        implementationMode: accountBackendSchema.optional(),
        contentSafetyEnabled: z.boolean().optional(),
        isEnabled: z.boolean().optional(),
        status: z.string().trim().max(80).optional(),
        resetAvailability: z.boolean().optional(),
        priority: z.coerce.number().int().min(0).max(10000).optional(),
        concurrency: z.coerce.number().int().min(1).max(100).optional(),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await bulkUpdateImageBackendAccounts({
        accountIds: parsedInput.accountIds,
        groupId: parsedInput.groupId,
        implementationMode: parsedInput.implementationMode || null,
        contentSafetyEnabled:
          parsedInput.contentSafetyEnabled === undefined
            ? null
            : parsedInput.contentSafetyEnabled,
        isEnabled:
          parsedInput.isEnabled === undefined ? null : parsedInput.isEnabled,
        status: parsedInput.status === undefined ? null : parsedInput.status,
        resetAvailability:
          parsedInput.resetAvailability === undefined
            ? null
            : parsedInput.resetAvailability,
        priority:
          parsedInput.priority === undefined ? null : parsedInput.priority,
        concurrency:
          parsedInput.concurrency === undefined
            ? null
            : parsedInput.concurrency,
      });
      return { success: true, ...result };
    });

export const bulkDeleteImageBackendAccountsAction =
  withImageBackendPoolAdminAction("bulkDeleteAccounts")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await deleteImageBackendMembers({
        accountIds: parsedInput.accountIds,
      });
      return {
        success: true,
        deletedCount: result.deletedAccountCount,
      };
    });

export const deleteAllErrorImageBackendAccountsAction =
  withImageBackendPoolAdminAction("deleteAllErrorAccounts")
    .schema(adminAccountErrorDeleteSchema)
    .action(async ({ parsedInput }) => {
      const result = await deleteAllErrorImageBackendAccounts(parsedInput);
      return {
        success: true,
        deletedCount: result.deletedAccountCount,
      };
    });

export const importImageBackendAccountsFromRefreshTokensAction =
  withImageBackendPoolAdminAction("importAccountsFromRefreshTokens")
    .schema(
      z.object({
        refreshTokensText: z.string().trim().min(1),
        webGroupId: nullableGroupIdSchema,
        responsesGroupId: nullableGroupIdSchema,
        syncMode: sub2ApiTokenSyncModeSchema.default("both"),
        useMobileRt: z.boolean().default(false),
        namePrefix: z.string().trim().max(80).optional(),
        model: z.string().trim().max(120).optional(),
        contentSafetyEnabled: z.boolean().default(true),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(100).default(1),
        importBatchId: z.string().trim().min(1).max(128).optional(),
        startIndex: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await importImageBackendAccountsFromRefreshTokens({
        refreshTokensText: parsedInput.refreshTokensText,
        webGroupId: parsedInput.webGroupId,
        responsesGroupId: parsedInput.responsesGroupId,
        syncMode: parsedInput.syncMode,
        useMobileRt: parsedInput.useMobileRt,
        namePrefix: parsedInput.namePrefix || null,
        model: parsedInput.model || null,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        priority: parsedInput.priority,
        concurrency: parsedInput.concurrency,
        importBatchId: parsedInput.importBatchId,
        startIndex: parsedInput.startIndex,
      });
      return { success: true, ...result };
    });

export const importImageBackendWebAccountsFromAccessTokensAction =
  withImageBackendPoolAdminAction("importWebAccountsFromAccessTokens")
    .schema(
      z.object({
        accessTokensText: z.string().trim().min(1),
        webGroupId: nullableGroupIdSchema,
        namePrefix: z.string().trim().max(80).optional(),
        model: z.string().trim().max(120).optional(),
        contentSafetyEnabled: z.boolean().default(true),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(100).default(1),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await importImageBackendWebAccountsFromAccessTokens({
        accessTokensText: parsedInput.accessTokensText,
        webGroupId: parsedInput.webGroupId,
        namePrefix: parsedInput.namePrefix || null,
        model: parsedInput.model || null,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        priority: parsedInput.priority,
        concurrency: parsedInput.concurrency,
      });
      return { success: true, ...result };
    });

export const syncImageBackendAccountsFromSub2ApiAction =
  withImageBackendPoolAdminAction("syncSub2ApiAccounts")
    .schema(
      z.object({
        webGroupId: nullableGroupIdSchema,
        responsesGroupId: nullableGroupIdSchema,
        sourceGroupId: nullableGroupIdSchema,
        sourceGroupName: z.string().trim().max(120).optional(),
        syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
        allowMobileRtImport: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        planFilter: sub2ApiPlanFilterSchema.default("non_free"),
        createSyncTask: z.boolean().default(false),
        overwriteLocalUnavailableState: z.boolean().default(true),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await syncImageBackendAccountsFromSub2Api({
        webGroupId: parsedInput.webGroupId,
        responsesGroupId: parsedInput.responsesGroupId,
        sourceGroupId: parsedInput.sourceGroupId,
        sourceGroupName: parsedInput.sourceGroupName || null,
        syncMode: parsedInput.allowMobileRtImport
          ? parsedInput.syncMode
          : "responses",
        allowMobileRtImport: parsedInput.allowMobileRtImport,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        limit: parsedInput.limit,
        offset: parsedInput.offset,
        planFilter: parsedInput.planFilter,
        createSyncTask: parsedInput.createSyncTask,
        cleanupManagedAccounts: parsedInput.createSyncTask,
        overwriteLocalUnavailableState:
          parsedInput.overwriteLocalUnavailableState,
      });
      return { success: true, ...result };
    });

export const runSub2ApiManualSyncAction = withImageBackendPoolAdminAction(
  "runSub2ApiManualSync"
)
  .schema(
    z.object({
      webGroupId: nullableGroupIdSchema,
      responsesGroupId: nullableGroupIdSchema,
      sourceGroupId: nullableGroupIdSchema,
      sourceGroupName: z.string().trim().max(120).optional(),
      syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
      allowMobileRtImport: z.boolean().default(false),
      contentSafetyEnabled: z.boolean().default(true),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      planFilter: sub2ApiPlanFilterSchema.default("non_free"),
      createSyncTask: z.boolean().default(true),
      overwriteLocalUnavailableState: z.boolean().default(true),
      intervalMinutes: z.coerce.number().int().min(1).default(720),
    })
  )
  .action(async ({ parsedInput }) => {
    const result = await runSub2ApiManualSync({
      webGroupId: parsedInput.webGroupId,
      responsesGroupId: parsedInput.responsesGroupId,
      sourceGroupId: parsedInput.sourceGroupId,
      sourceGroupName: parsedInput.sourceGroupName || null,
      syncMode: parsedInput.allowMobileRtImport
        ? parsedInput.syncMode
        : "responses",
      allowMobileRtImport: parsedInput.allowMobileRtImport,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      limit: parsedInput.limit,
      planFilter: parsedInput.planFilter,
      createSyncTask: parsedInput.createSyncTask,
      overwriteLocalUnavailableState:
        parsedInput.overwriteLocalUnavailableState,
      intervalMinutes: parsedInput.intervalMinutes,
    });
    return result;
  });

export const saveImageBackendApiAction = withImageBackendPoolAdminAction(
  "saveApi"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      groupId: nullableGroupIdSchema,
      groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
      name: z.string().trim().min(1).max(120),
      baseUrl: z.string().trim().url(),
      apiKey: z.string().trim().optional(),
      model: z.string().trim().max(120).optional(),
      modelMapping: z
        .array(
          z.object({
            from: z.string().trim().min(1).max(120),
            to: z.string().trim().min(1).max(120),
            whenQuality: z
              .enum(["high", "medium", "low", "auto", "xhigh", "max"])
              .optional(),
            setQuality: z
              .enum(["high", "medium", "low", "auto", "xhigh", "max"])
              .optional(),
          })
        )
        .max(50)
        .optional(),
      qualityBilling: qualityBillingSchema,
      modelBilling: modelBillingSchema,
      interfaceMode: apiInterfaceModeSchema.default("mixed"),
      chatCompletionsUpstreamMode:
        chatCompletionsUpstreamModeSchema.default("responses"),
      imagesUpstreamMode: imagesUpstreamModeSchema.default("images"),
      sizeDialect: apiSizeDialectSchema.default("wxh"),
      useStream: z.boolean().default(false),
      contentSafetyEnabled: z.boolean().default(true),
      isEnabled: z.boolean().default(true),
      alwaysActive: z.boolean().default(false),
      failureCooldownEnabled: z.boolean().default(false),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
      concurrency: z.coerce.number().int().min(1).max(10000).default(10),
      // Adobe 来源：上游实为 Adobe 的 gpt 格式 api。开启后吃成员倍率并进 firefly 候选。
      adobeSourced: z.boolean().default(false),
      // 成员计费倍率（仅 adobeSourced 时生效），口径同 Adobe 伪账号。
      billingMultiplier: z.coerce.number().min(0.01).max(100).default(1),
      status: z.string().trim().max(80).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const id = await upsertImageBackendApi({
      id: parsedInput.id,
      groupId: parsedInput.groupId,
      groupIds: parsedInput.groupIds,
      name: parsedInput.name,
      baseUrl: parsedInput.baseUrl,
      apiKey: parsedInput.apiKey || undefined,
      model: parsedInput.model || null,
      modelMapping: parsedInput.modelMapping || null,
      qualityBilling: parsedInput.qualityBilling ?? null,
      modelBilling: parsedInput.modelBilling ?? null,
      interfaceMode: parsedInput.interfaceMode,
      chatCompletionsUpstreamMode: parsedInput.chatCompletionsUpstreamMode,
      imagesUpstreamMode: parsedInput.imagesUpstreamMode,
      sizeDialect: parsedInput.sizeDialect,
      useStream: parsedInput.useStream,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      isEnabled: parsedInput.isEnabled,
      alwaysActive: parsedInput.alwaysActive,
      failureCooldownEnabled: parsedInput.failureCooldownEnabled,
      priority: parsedInput.priority,
      concurrency: parsedInput.concurrency,
      adobeSourced: parsedInput.adobeSourced,
      billingMultiplier: parsedInput.billingMultiplier,
      status: parsedInput.status || "active",
    });
    return { success: true, id };
  });

export const saveImageBackendAdobeAction = withImageBackendPoolAdminAction(
  "saveAdobe"
)
  .schema(
    z
      .object({
        id: z.string().trim().optional(),
        groupId: nullableGroupIdSchema,
        groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
        name: z.string().trim().min(1).max(120),
        mode: z.enum(["gateway", "direct"]).default("gateway"),
        baseUrl: z.string().trim().default(""),
        apiKey: z.string().trim().optional(),
        enabledModels: z
          .array(z.string().trim().min(1).max(60))
          .max(20)
          .optional(),
        defaultRatio: z.string().trim().max(20).default("1x1"),
        defaultResolution: z.string().trim().max(10).default("2k"),
        gptImageQuality: z.enum(["low", "medium", "high"]).default("high"),
        billingMultiplier: z.coerce.number().positive().max(1000).default(1),
        supportsVideo: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        isEnabled: z.boolean().default(true),
        alwaysActive: z.boolean().default(false),
        failureCooldownEnabled: z.boolean().default(false),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(10000).default(10),
        status: z.string().trim().max(80).optional(),
      })
      // gateway 模式必须有合法 baseUrl；direct 模式凭据走 Adobe 账号（另表），baseUrl 可空。
      .refine(
        (value) =>
          value.mode === "direct" || /^https?:\/\//i.test(value.baseUrl),
        { message: "baseUrl must be a valid URL", path: ["baseUrl"] }
      )
  )
  .action(async ({ parsedInput }) => {
    const id = await upsertImageBackendAdobe({
      id: parsedInput.id,
      groupId: parsedInput.groupId,
      groupIds: parsedInput.groupIds,
      name: parsedInput.name,
      mode: parsedInput.mode,
      baseUrl: parsedInput.baseUrl,
      apiKey: parsedInput.apiKey || undefined,
      enabledModels: parsedInput.enabledModels ?? null,
      defaultRatio: parsedInput.defaultRatio,
      defaultResolution: parsedInput.defaultResolution,
      gptImageQuality: parsedInput.gptImageQuality,
      billingMultiplier: parsedInput.billingMultiplier,
      supportsVideo: parsedInput.supportsVideo,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      isEnabled: parsedInput.isEnabled,
      alwaysActive: parsedInput.alwaysActive,
      failureCooldownEnabled: parsedInput.failureCooldownEnabled,
      priority: parsedInput.priority,
      concurrency: parsedInput.concurrency,
      status: parsedInput.status || "active",
    });
    return { success: true, id };
  });

export const setImageBackendAdobeEnabledAction =
  withImageBackendPoolAdminAction("setAdobeEnabled")
    .schema(z.object({ id: z.string().trim().min(1), isEnabled: z.boolean() }))
    .action(async ({ parsedInput }) => {
      await setImageBackendAdobeEnabled(parsedInput);
      return { success: true };
    });

export const setImageBackendAdobeAlwaysActiveAction =
  withImageBackendPoolAdminAction("setAdobeAlwaysActive")
    .schema(
      z.object({ id: z.string().trim().min(1), alwaysActive: z.boolean() })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendAdobeAlwaysActive(parsedInput);
      return { success: true };
    });

// ===== Adobe 模型计费倍率（图像 / 视频 per-model 倍率，复用系统设置）=====

// family → 正数倍率 的 map。空 map 表示全部回退默认倍率 1。非正/非有限值由前端过滤,
// 此处再以 schema 兜底,杜绝脏值落库（财务语义键须为正有限数）。
const modelMultiplierMapSchema = z.record(
  z.string().trim().min(1),
  z.number().finite().positive()
);

/**
 * 读取图像/视频两套 per-model 倍率系统设置（管理员可见）。
 * 复用系统设置存储（IMAGE_MODEL_MULTIPLIERS / VIDEO_MODEL_MULTIPLIERS），不新建 infra。
 */
export const getAdobeModelMultipliersAction = withImageBackendPoolAdminAction(
  "getModelMultipliers"
).action(async () => {
  const [imageRaw, videoRaw] = await Promise.all([
    getRuntimeSettingJson("IMAGE_MODEL_MULTIPLIERS"),
    getRuntimeSettingJson("VIDEO_MODEL_MULTIPLIERS"),
  ]);
  const image = modelMultiplierMapSchema.catch({}).parse(imageRaw ?? {});
  const video = modelMultiplierMapSchema.catch({}).parse(videoRaw ?? {});
  return { success: true, image, video };
});

/**
 * 写回图像/视频两套 per-model 倍率系统设置（管理员）。空 map 即清空(回退默认倍率 1)。
 * 复用 setSystemSettings 的 json 校验与缓存失效;两个 JSON 键非 env 变量,无需同步 env。
 */
export const setAdobeModelMultipliersAction = withImageBackendPoolAdminAction(
  "setModelMultipliers"
)
  .schema(
    z.object({
      image: modelMultiplierMapSchema,
      video: modelMultiplierMapSchema,
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    await setSystemSettings(
      [
        { key: "IMAGE_MODEL_MULTIPLIERS", value: parsedInput.image },
        { key: "VIDEO_MODEL_MULTIPLIERS", value: parsedInput.video },
      ],
      ctx.userId
    );
    return { success: true };
  });

// ===== Adobe 直连账号管理（mode=direct）=====

export const listAdobeAccountsAction = withImageBackendPoolAdminAction(
  "listAdobeAccounts"
)
  .schema(z.object({ adobeId: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    const accounts = await listAdobeAccounts(parsedInput.adobeId);
    return { success: true, accounts };
  });

export const importAdobeAccountAction = withImageBackendPoolAdminAction(
  "importAdobeAccount"
)
  .schema(
    z.object({
      adobeId: z.string().trim().min(1),
      name: z.string().trim().max(120).optional(),
      cookie: z.string().trim().min(1),
      scope: z.string().trim().max(2000).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const account = await importAdobeAccount({
      adobeId: parsedInput.adobeId,
      name: parsedInput.name,
      cookie: parsedInput.cookie,
      scope: parsedInput.scope ?? null,
    });
    return { success: true, account };
  });

export const importAdobeAccountsAction = withImageBackendPoolAdminAction(
  "importAdobeAccounts"
)
  .schema(
    z.object({
      adobeId: z.string().trim().min(1),
      cookiesText: z.string().trim().min(1),
      namePrefix: z.string().trim().max(120).optional(),
      scope: z.string().trim().max(2000).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const result = await importAdobeAccountsBatch({
      adobeId: parsedInput.adobeId,
      cookiesText: parsedInput.cookiesText,
      namePrefix: parsedInput.namePrefix,
      scope: parsedInput.scope ?? null,
    });
    return { success: true, result };
  });

export const deleteAdobeAccountAction = withImageBackendPoolAdminAction(
  "deleteAdobeAccount"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    await deleteAdobeAccount(parsedInput.id);
    return { success: true };
  });

export const setAdobeAccountEnabledAction = withImageBackendPoolAdminAction(
  "setAdobeAccountEnabled"
)
  .schema(z.object({ id: z.string().trim().min(1), isEnabled: z.boolean() }))
  .action(async ({ parsedInput }) => {
    await setAdobeAccountEnabled(parsedInput.id, parsedInput.isEnabled);
    return { success: true };
  });

export const setImageBackendApiEnabledAction = withImageBackendPoolAdminAction(
  "setApiEnabled"
)
  .schema(
    z.object({
      id: z.string().trim().min(1),
      isEnabled: z.boolean(),
    })
  )
  .action(async ({ parsedInput }) => {
    await setImageBackendApiEnabled(parsedInput);
    return { success: true };
  });

export const setImageBackendApiAlwaysActiveAction =
  withImageBackendPoolAdminAction("setApiAlwaysActive")
    .schema(
      z.object({
        id: z.string().trim().min(1),
        alwaysActive: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendApiAlwaysActive(parsedInput);
      return { success: true };
    });

export const setImageBackendAccountAlwaysActiveAction =
  withImageBackendPoolAdminAction("setAccountAlwaysActive")
    .schema(
      z.object({
        id: z.string().trim().min(1),
        alwaysActive: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendAccountAlwaysActive(parsedInput);
      return { success: true };
    });

export const testImageBackendApiAction = withImageBackendPoolAdminAction(
  "testApi"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    const probe = await probeImageBackendApi(parsedInput.id);
    return { success: true, ...probe };
  });

export const deleteImageBackendMemberAction = withImageBackendPoolAdminAction(
  "deleteMember"
)
  .schema(
    z.object({
      type: z.enum(["account", "api", "adobe"]),
      id: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    await deleteImageBackendMembers(
      parsedInput.type === "account"
        ? { accountIds: [parsedInput.id] }
        : parsedInput.type === "adobe"
          ? { adobeIds: [parsedInput.id] }
          : { apiIds: [parsedInput.id] }
    );
    return { success: true };
  });

export const refreshImageBackendAccountInfoAction =
  withImageBackendPoolAdminAction("refreshAccountInfo")
    .schema(z.object({ id: z.string().trim().min(1) }))
    .action(async ({ parsedInput }) => {
      const info = await refreshImageBackendAccountInfo(parsedInput.id);
      return { success: true, info };
    });

export const refreshImageBackendAccountsInfoAction =
  withImageBackendPoolAdminAction("refreshAccountsInfo")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await refreshImageBackendAccountsInfo(
        parsedInput.accountIds
      );
      return { success: true, ...result };
    });

export const getImageBackendGroupOptionsAction = protectedAction
  .metadata({ action: "imageBackendPool.groupOptions" })
  .action(async () => {
    const groups = await listImageBackendGroupOptions();
    return { groups };
  });

// 读取 ChatGPT 注册机配置（moemail + 代理 + IP 刷新 + 号池维持）
export const getChatgptRegisterConfigAction =
  withImageBackendPoolAdminAction("getChatgptRegisterConfig").action(
    async () => {
      const [
        apiKey,
        baseUrl,
        domain,
        domains,
        domainRotationEnabled,
        proxy,
        proxyDisabled,
        refreshUrl,
        refreshMinIntervalSeconds,
        refreshMinAttempts,
        maintainEnabled,
        maintainGroupId,
        maintainTarget,
        maintainMaxPerRun,
        maintainConcurrency,
      ] = await Promise.all([
        getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_API_KEY"),
        getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_BASE_URL"),
        getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_DOMAIN"),
        getRuntimeSettingString("CHATGPT_REGISTER_DOMAINS"),
        getRuntimeSettingBoolean(
          "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED",
          false
        ),
        getRuntimeSettingString("CHATGPT_REGISTER_PROXY"),
        getRuntimeSettingBoolean("CHATGPT_REGISTER_PROXY_DISABLED", false),
        getRuntimeSettingString("CHATGPT_REGISTER_REFRESH_URL"),
        getRuntimeSettingNumber(
          "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
          60
        ),
        getRuntimeSettingNumber("CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS", 100),
        getRuntimeSettingBoolean(
          "CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED",
          false
        ),
        getRuntimeSettingString("CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID"),
        getRuntimeSettingNumber("CHATGPT_REGISTER_POOL_MAINTAIN_TARGET", 0),
        getRuntimeSettingNumber(
          "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN",
          10
        ),
        getRuntimeSettingNumber(
          "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY",
          5
        ),
      ]);
      return {
        apiKey,
        baseUrl,
        domain,
        domains,
        domainRotationEnabled,
        proxy,
        proxyDisabled,
        refreshUrl,
        refreshMinIntervalSeconds,
        refreshMinAttempts,
        maintainEnabled,
        maintainGroupId,
        maintainTarget,
        maintainMaxPerRun,
        maintainConcurrency,
      };
    }
  );

// 查询某分组当前可用 web 账号数（号池维持面板展示用）
export const getGroupAvailableCountAction =
  withImageBackendPoolAdminAction("getGroupAvailableCount")
    .schema(z.object({ groupId: z.string().trim().min(1) }))
    .action(async ({ parsedInput }) => {
      const available = await countAvailableWebAccountsInGroup(
        parsedInput.groupId
      );
      return { available };
    });

// 从 Moemail 服务端查询可用邮箱域名列表
export const getMoemailDomainsAction =
  withImageBackendPoolAdminAction("getMoemailDomains")
    .schema(
      z.object({
        baseUrl: z.string().trim().min(1).optional(),
        apiKey: z.string().trim().min(1).optional(),
      })
    )
    .action(async ({ parsedInput, ctx }) => {
      const baseUrl =
        parsedInput.baseUrl?.replace(/\/$/, "") ??
        (await getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_BASE_URL")) ??
        "https://mail.52ai.org";
      const apiKey =
        parsedInput.apiKey ??
        (await getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_API_KEY"));
      if (!apiKey) {
        throw new Error("未配置 Moemail API Key");
      }
      // Moemail 用 X-API-Key 头鉴权（非 Authorization: Bearer），/api/config 返回
      // emailDomains 为逗号分隔字符串（非 domains 数组）。
      const resp = await fetch(`${baseUrl}/api/config`, {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        throw new Error(`Moemail 返回 ${resp.status}`);
      }
      const data = (await resp.json()) as {
        emailDomains?: string;
      };
      const domains = (data.emailDomains ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      // 自动保存可用域名列表，供「轮换域名」使用（用户手动查询即落库）。
      if (domains.length > 0) {
        await setSystemSettings(
          [{ key: "CHATGPT_REGISTER_DOMAINS", value: domains.join(",") }],
          ctx.userId
        );
      }
      return { domains };
    });

// 保存 ChatGPT 注册机配置（moemail + 代理 + IP 刷新 + 号池维持）
export const saveChatgptRegisterConfigAction =
  withImageBackendPoolAdminAction("saveChatgptRegisterConfig")
    .schema(
      z.object({
        apiKey: z.string().trim().optional(),
        baseUrl: z.string().trim().optional(),
        domain: z.string().trim().optional(),
        domainRotationEnabled: z.boolean().optional(),
        proxy: z.string().trim().optional(),
        proxyDisabled: z.boolean().optional(),
        refreshUrl: z.string().trim().optional(),
        refreshMinIntervalSeconds: z.coerce.number().int().min(1).optional(),
        refreshMinAttempts: z.coerce.number().int().min(1).optional(),
        maintainEnabled: z.boolean().optional(),
        maintainGroupId: z.string().trim().optional(),
        maintainTarget: z.coerce.number().int().min(0).optional(),
        maintainMaxPerRun: z.coerce.number().int().min(1).optional(),
        maintainConcurrency: z.coerce.number().int().min(1).optional(),
      })
    )
    .action(async ({ parsedInput, ctx }) => {
      const entries: Array<{ key: string; value: unknown }> = [];
      const put = (key: string, value: unknown) => {
        if (value !== undefined) entries.push({ key, value });
      };
      put("CHATGPT_REGISTER_MOEMAIL_API_KEY", parsedInput.apiKey);
      put("CHATGPT_REGISTER_MOEMAIL_BASE_URL", parsedInput.baseUrl);
      put("CHATGPT_REGISTER_MOEMAIL_DOMAIN", parsedInput.domain);
      put(
        "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED",
        parsedInput.domainRotationEnabled
      );
      put("CHATGPT_REGISTER_PROXY", parsedInput.proxy);
      put("CHATGPT_REGISTER_PROXY_DISABLED", parsedInput.proxyDisabled);
      put("CHATGPT_REGISTER_REFRESH_URL", parsedInput.refreshUrl);
      put(
        "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
        parsedInput.refreshMinIntervalSeconds
      );
      put(
        "CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS",
        parsedInput.refreshMinAttempts
      );
      put("CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED", parsedInput.maintainEnabled);
      put(
        "CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID",
        parsedInput.maintainGroupId
      );
      put("CHATGPT_REGISTER_POOL_MAINTAIN_TARGET", parsedInput.maintainTarget);
      put(
        "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN",
        parsedInput.maintainMaxPerRun
      );
      put(
        "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY",
        parsedInput.maintainConcurrency
      );
      if (entries.length > 0) {
        await setSystemSettings(entries, ctx.userId);
      }
      return { success: true };
    });
