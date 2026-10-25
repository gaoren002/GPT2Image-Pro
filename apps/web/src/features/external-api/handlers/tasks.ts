/**
 * GET /v1/tasks/{requestId}：异步任务模式（兼容速度马）的结果查询。
 *
 * 先查内存任务：须同一用户、同一 Key 创建，否则直接 404，不再回退查库，保证任务在内存期间
 * 只有创建它的 Key 能查。未命中时把 ID 当 generation_id 从数据库取回（同一用户），覆盖
 * 服务重启、切换实例后的单张任务与同步请求。返回 {id, status, progress, error, data}，
 * 状态只有 processing / succeeded / failed，图片地址为带签名的完整公网地址。查询不扣费。
 */
import { withApiLogging } from "@repo/shared/api-logger";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import type { NextRequest } from "next/server";
import {
  getAsyncImageTask,
  resolveAsyncImageTaskResponse,
} from "@/features/external-api/async-image-tasks";
import {
  toGenerationTaskModeResponse,
  toTaskModeResponse,
} from "@/features/external-api/async-task-mode";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  getPublicImageUrl,
  openAIImageError,
} from "@/features/external-api/images";
import { getGenerationById } from "@/features/image-generation/queries";

const NO_STORE = { "Cache-Control": "no-store" };

/** 任务不存在、已过期，或不属于当前 Key/用户时的统一响应，不区分原因以免泄露任务是否存在。 */
function taskNotFound() {
  return openAIImageError(
    "Task not found, expired, or not created by this API key.",
    404,
    "task_not_found"
  );
}

export const getExternalTask = withApiLogging(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
  ) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }

    const { taskId } = await params;
    if (!taskId || taskId.length > 128) {
      return openAIImageError("Invalid task id.");
    }

    const task = getAsyncImageTask(taskId);
    if (task) {
      if (
        task.userId !== auth.userId ||
        (task.apiKeyId !== undefined && task.apiKeyId !== auth.apiKeyId)
      ) {
        return taskNotFound();
      }
      const payload = await resolveAsyncImageTaskResponse(task, request, {
        responseFormat: "url",
      });
      return Response.json(
        toTaskModeResponse(task.id, payload as Record<string, unknown>),
        { headers: NO_STORE }
      );
    }

    // getGenerationById 不带归属过滤，必须在此校验 userId，防止越权读取他人记录。
    const row = await getGenerationById(taskId);
    if (!row || row.userId !== auth.userId) return taskNotFound();
    const signedUrl = row.storageKey
      ? buildSignedStorageImageUrl(row.storageKey, row.storageBucket)
      : null;
    return Response.json(
      toGenerationTaskModeResponse(
        row,
        signedUrl ? (getPublicImageUrl(request, signedUrl) ?? null) : null
      ),
      { headers: NO_STORE }
    );
  }
);
