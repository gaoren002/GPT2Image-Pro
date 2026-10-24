/**
 * UOL Bindings - 启动时延迟绑定真实 execute 实现
 *
 * 职责：在 apps/web 启动时，将 packages/shared 中定义的 operation stub
 * 替换为真实的 service-fn 实现。解决跨包依赖问题：
 * - 操作定义在 packages/shared（不可导入 apps/web）
 * - 部分 execute 实现依赖 apps/web 的 service-fn（DB、外部 API 等）
 *
 * 使用方：uol-init.ts 在应用启动时调用此模块（副作用导入）
 * 关键依赖：@repo/shared/uol（bindExecute）、各 features service-fn
 *
 * 约定：
 * - 此文件在 import 时执行所有 bindExecute 调用
 * - 每个绑定块对应一个 operation，注明源 service-fn 位置
 * - 尚未接线的 operation 用 TODO 注释标记
 */

// 副作用导入：触发所有操作注册到 registry
import "@repo/shared/uol/operations";

import { bindExecute } from "@repo/shared/uol";
import type { Principal, OperationContext } from "@repo/shared/uol";

import { runImageGenerationForUser } from "@/features/image-generation/operations";
import type { ImageQuality } from "@/features/image-generation/types";
import { runEditableFileForUser } from "@/features/image-generation/editable-file-operations";
import { listAdminImageBackendPool } from "@/features/image-backend-pool/service";

// ---------------------------------------------------------------------------
// image-generation 域
// ---------------------------------------------------------------------------

/**
 * image.generate - 统一管线核心
 * 源: apps/web/src/features/image-generation/operations.ts
 */
bindExecute(
  "image.generate",
  async (
    input: {
      userId: string;
      prompt: string;
      negativePrompt?: string;
      model?: string;
      size?: string;
      quality?: string;
      style?: string;
      count?: number;
      generationId?: string;
      backendGroupId?: string;
      relayOnly?: boolean;
      extra?: Record<string, unknown>;
    },
    _principal: Principal,
    _ctx: OperationContext,
  ) => {
    const result = await runImageGenerationForUser({
      mode: "generate",
      userId: input.userId,
      prompt: input.prompt,
      model: input.model,
      size: input.size,
      quality: input.quality as ImageQuality | undefined,
      n: input.count,
      generationId: input.generationId,
      relayOnly: input.relayOnly,
    });

    if (result.error) {
      throw new Error(result.error);
    }

    // 将 ImageGenerationOperationResult 映射到 UOL output schema
    const images: { url: string; revisedPrompt?: string }[] = [];
    if (result.imageUrl) {
      images.push({
        url: result.imageUrl,
        revisedPrompt: result.revisedPrompt,
      });
    }
    if (result.imageOutputs) {
      for (const output of result.imageOutputs) {
        if (output.imageUrl) {
          images.push({
            url: output.imageUrl,
            revisedPrompt: output.revisedPrompt,
          });
        }
      }
    }

    return {
      generationId: result.generationId ?? input.generationId ?? "",
      images,
      creditsUsed: result.creditsConsumed,
      model: result.model,
    };
  },
);

/**
 * file.generatePpt / file.generatePsd - 可编辑文件(PPT/PSD)生成
 * 源: apps/web/src/features/image-generation/editable-file-operations.ts
 * 用户、文件类型与 clientRequestId 共同派生幂等键；PSD 强校验非空图。
 */
function bindEditableFile(name: "file.generatePpt" | "file.generatePsd") {
  const kind = name === "file.generatePsd" ? "psd" : "ppt";
  bindExecute(
    name,
    async (
      input: {
        userId: string;
        clientRequestId: string;
        prompt: string;
        base64Images?: string[];
      },
      principal: Principal,
      ctx: OperationContext,
    ) => {
      ctx.assertOwnership("editable task", input.userId);
      const result = await runEditableFileForUser({
        userId: input.userId,
        apiKeyId: principal.type === "apiKey" ? principal.apiKeyId : undefined,
        kind,
        prompt: input.prompt,
        base64Images: input.base64Images ?? [],
        taskId: input.clientRequestId,
      });
      return {
        taskId: input.clientRequestId,
        conversationId: result.conversationId,
        primaryUrl: result.primaryUrl,
        zipUrl: result.zipUrl,
        creditsUsed: result.creditsCharged,
        requestFingerprint: result.requestFingerprint,
        publicTaskId: result.publicTaskId,
      };
    },
  );
}
bindEditableFile("file.generatePpt");
bindEditableFile("file.generatePsd");

// TODO: image.generateAction - 委托 image.generate
// TODO: image.delete - deleteGenerationAction 逻辑
// TODO: image.getStatus - getGenerationStatus 逻辑
// TODO: image.getUserGenerations - 分页查询逻辑
// TODO: image.getUserGenerationCount - 计数查询逻辑
// TODO: image.getUserRecentGenerations - 最近生成查询
// TODO: image.getGenerationById - 单条查询
// TODO: image.getGenerationStats - 管理员统计
// TODO: image.getUserApiConfig - getUserApiConfig 逻辑
// TODO: image.getEffectiveConfig - getEffectiveConfig 逻辑
// TODO: image.selectWebCandidate - selectChatGptWebImageCandidate 逻辑

// ---------------------------------------------------------------------------
// image-backend-pool 域
// ---------------------------------------------------------------------------

/**
 * pool.getAdminPool - 管理后台池总览
 * 源: apps/web/src/features/image-backend-pool/service.ts
 */
bindExecute(
  "pool.getAdminPool",
  async (
    _input: Record<string, never>,
    _principal: Principal,
    _ctx: OperationContext,
  ) => {
    const pool = await listAdminImageBackendPool();
    return pool;
  },
);

// TODO: pool.getSelectableGroups - getSelectableImageBackendGroupsAction 逻辑
// TODO: pool.setPreference - setUserImageBackendPreferenceAction 逻辑
// TODO: pool.getGroupOptions - getImageBackendGroupOptionsAction 逻辑
// TODO: pool.saveGroup - saveImageBackendGroupAction 逻辑
// TODO: pool.deleteGroup - deleteImageBackendGroupAction 逻辑
// TODO: pool.saveAccount - saveImageBackendAccountAction 逻辑
// TODO: pool.bulkUpdateAccounts - bulkUpdateImageBackendAccountsAction 逻辑
// TODO: pool.bulkDeleteAccounts - bulkDeleteImageBackendAccountsAction 逻辑
// TODO: pool.deleteMember - deleteImageBackendMemberAction 逻辑
// TODO: pool.saveApi - saveImageBackendApiAction 逻辑
// TODO: pool.importFromRefreshTokens - importImageBackendAccountsFromRefreshTokensAction
// TODO: pool.importWebFromAccessTokens - importImageBackendWebAccountsFromAccessTokensAction
// TODO: pool.refreshAccountInfo - refreshImageBackendAccountInfoAction 逻辑
// TODO: pool.refreshAccountsInfo - refreshImageBackendAccountsInfoAction 逻辑
// TODO: pool.getSub2ApiStatus - getSub2ApiSyncStatusAction 逻辑
// TODO: pool.getSub2ApiSourceGroups - getSub2ApiSourceGroupsAction 逻辑
// TODO: pool.getSub2ApiAutoSyncTasks - getSub2ApiAutoSyncTasksAction 逻辑
// TODO: pool.syncSub2ApiAccounts - syncImageBackendAccountsFromSub2ApiAction
// TODO: pool.runSub2ApiManualSync - runSub2ApiManualSyncAction 逻辑
// TODO: pool.runSub2ApiAutoSyncNow - runSub2ApiAutoSyncTaskNowAction 逻辑
// TODO: pool.setSub2ApiTaskEnabled - setSub2ApiAutoSyncTaskEnabledAction
// TODO: pool.setSub2ApiTaskOverwrite - setSub2ApiAutoSyncTaskOverwriteLocalUnavailableStateAction
// TODO: pool.updateSub2ApiTaskOptions - updateSub2ApiAutoSyncTaskOptionsAction
// TODO: pool.deleteSub2ApiTask - deleteSub2ApiAutoSyncTaskAction
// TODO: pool.cronSub2ApiSync - cron 调度逻辑
// TODO: pool.cronRefreshStale - cron 调度逻辑

// ---------------------------------------------------------------------------
// user-auth 域
// ---------------------------------------------------------------------------

// TODO: user.list - getAllUsersAction 逻辑（DB 查询在 packages/shared 但需运行时 DB 连接）
// TODO: user.getDetail - getUserDetailAction 逻辑
// TODO: user.updateRole - updateUserRoleAction 逻辑
// TODO: user.ban - banUserAction 逻辑
// TODO: user.grantCredits - adminGrantCreditsAction 逻辑
// TODO: user.adjustCredits - adminAdjustCreditsAction 逻辑
// TODO: user.setSubscription - setUserPlanAction 逻辑
// TODO: user.setCreditsStatus - setUserCreditsStatusAction 逻辑
// TODO: user.setExternalApiKeyStatus - setExternalApiKeyStatusAction 逻辑
// TODO: user.create - createUserAction 逻辑
// TODO: user.updateProfile - updateUserProfileAction 逻辑
// TODO: user.setPassword - setUserPasswordAction 逻辑

// ---------------------------------------------------------------------------
// external-api 域
// ---------------------------------------------------------------------------

// TODO: externalApi.handleImageGenerations - image-generations handler 逻辑
// TODO: externalApi.handleImageEdits - image-edits handler 逻辑
// TODO: externalApi.handleChatCompletions - chat-completions handler 逻辑
// TODO: externalApi.handleResponses - responses handler 逻辑
// TODO: externalApi.handleAgentImages - agent-images handler 逻辑

// ---------------------------------------------------------------------------
// support 域
// ---------------------------------------------------------------------------

// TODO: support.createTicket - createTicketAction 逻辑
// TODO: support.listTickets - getTicketsAction 逻辑
// TODO: support.getTicketDetail - getTicketDetailAction 逻辑
// TODO: support.replyTicket - replyTicketAction 逻辑
// TODO: support.closeTicket - closeTicketAction 逻辑
// TODO: support.adminListTickets - adminGetTicketsAction 逻辑
// TODO: support.adminReplyTicket - adminReplyTicketAction 逻辑
// TODO: support.adminUpdateTicketStatus - adminUpdateTicketStatusAction 逻辑
