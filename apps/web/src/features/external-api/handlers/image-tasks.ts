import { withApiLogging } from "@repo/shared/api-logger";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import type { NextRequest } from "next/server";
import {
  getAsyncImageTask,
  resolveAsyncImageTaskResponse,
  toGenerationImageTaskResponse,
} from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { openAIImageError } from "@/features/external-api/images";
import { getGenerationById } from "@/features/image-generation/queries";

export const getExternalImageTask = withApiLogging(
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
      return openAIImageError("Invalid task_id.");
    }

    // 1. 先查内存异步任务存储(async 请求创建,按 task_<uuid> 为键;
    // 任务模式的单张任务以 generation_id 为键)。
    const task = getAsyncImageTask(taskId);
    if (
      task &&
      task.userId === auth.userId &&
      (!task.apiKeyId || task.apiKeyId === auth.apiKeyId)
    ) {
      return Response.json(await resolveAsyncImageTaskResponse(task, request), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // 2. 未命中(同步请求拿到的是 generation_id 而非 task id;或多实例/重启/30 分钟
    // TTL 已清)→ 把 taskId 当 generation_id 从 DB 持久取回。getGenerationById 不带
    // 归属过滤,必须在此显式校验 userId 防越权(IDOR):只返回归属本人的记录。
    const row = await getGenerationById(taskId);
    if (row && row.userId === auth.userId) {
      const imageUrl = row.storageKey
        ? buildSignedStorageImageUrl(row.storageKey, row.storageBucket)
        : null;
      return Response.json(toGenerationImageTaskResponse(row, imageUrl), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return openAIImageError("Image task not found or expired.", 404);
  }
);
