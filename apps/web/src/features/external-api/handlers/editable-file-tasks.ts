/** 外接可编辑任务轮询：仅需既有opaque task ID；持久记录优先，旧内存任务兼容兜底。 */
import { withApiLogging } from "@repo/shared/api-logger";
import type { getEditableTaskByPublicId } from "@repo/shared/editable-task-lifecycle";
import { invokeOperation } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import {
  getAsyncImageTask,
  toAsyncImageTaskResponse,
} from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { openAIImageError } from "@/features/external-api/images";

export const getExternalEditableFileTask = withApiLogging(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
  ) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth)
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    const { taskId } = await params;
    if (!taskId || taskId.length > 200)
      return openAIImageError("Invalid task_id.");
    const task = await invokeOperation<
      Awaited<ReturnType<typeof getEditableTaskByPublicId>>
    >(
      "file.getTask",
      { taskId },
      {
        type: "apiKey",
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        plan: auth.plan,
        relayOnly: auth.relayOnly,
      }
    );
    if (task)
      return Response.json(
        {
          object: "editable_file_task",
          id: task.publicId,
          taskId: task.publicId,
          kind: task.kind,
          status:
            task.status === "prepared" || task.status === "running"
              ? "processing"
              : task.status === "completed"
                ? "completed"
                : "failed",
          lifecycle_status: task.status,
          request_fingerprint: task.requestFingerprint,
          credits_charged: task.creditsCharged,
          result: task.result
            ? {
                conversation_id: task.result.conversationId,
                primary_url: task.result.primaryUrl,
                zip_url: task.result.zipUrl,
              }
            : null,
          ...(["failed", "refunded", "refund_pending"].includes(task.status)
            ? {
                error: {
                  code:
                    task.status === "refund_pending"
                      ? "editable_file_refund_pending"
                      : "editable_file_failed",
                  message:
                    "This task will not execute again. Start a new task for a new attempt.",
                },
              }
            : {}),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    const legacy = getAsyncImageTask(taskId);
    if (
      legacy?.object === "editable_file_task" &&
      legacy.userId === auth.userId &&
      legacy.apiKeyId === auth.apiKeyId
    )
      return Response.json(toAsyncImageTaskResponse(legacy), {
        headers: { "Cache-Control": "no-store" },
      });
    return openAIImageError("Editable file task not found.", 404);
  }
);
