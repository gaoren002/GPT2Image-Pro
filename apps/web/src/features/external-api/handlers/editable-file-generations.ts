/**
 * v1 可编辑文件生成 handler:POST /v1/ppts、POST /v1/psds。
 *
 * 职责(薄传输适配):鉴权(Bearer)→ 能力门禁(export.ppt/export.psd)→ 解析 body →
 *   调 runEditableFileForUser(单一账号池/计费真相)。
 * 契约对齐 basketikun/chatgpt2api:{ client_task_id?, prompt, base64_images[] }。PSD 强制非空图。
 * 计费/账号池/storage 全在 service;handler 不碰钱。
 *
 * 两种返回(与图像/视频 API 一致):
 * - 同步(默认):keep-alive JSON 撑住长任务,跑完返回 editable_file_task 结果。
 * - 异步(async:true 或 ?async=true):立即返回 task_<uuid>,后台跑完更新任务;可轮询
 *   GET /v1/editable-file-tasks/{task_id} 或用 callback_url 完成回调。任务为进程内内存态、
 *   完成后 30 分钟 TTL、多实例不共享(可编辑文件无 DB generation 行,故不作持久回退)。
 * client_task_id 在编排层按用户/文件类型认领；已消费的任务拒绝重复执行，结果恢复尚无持久任务层。
 */
import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  AsyncImageTaskCapacityError,
  completeAsyncImageTask,
  createAsyncEditableFileTask,
  postAsyncImageCallback,
  toAsyncImageTaskCapacityResponse,
  toAsyncImageTaskResponse,
  validateCallbackUrl,
} from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  createJsonKeepAliveResponse,
  openAIImageError,
  toOpenAIErrorPayload,
} from "@/features/external-api/images";
import type { EditableFileKind } from "@/features/image-generation/chatgpt-web";
import { runEditableFileForUser } from "@/features/image-generation/editable-file-operations";

const editableFileSchema = z.object({
  client_task_id: z.string().max(200).optional(),
  prompt: z.string().min(1, "prompt is required").max(8000),
  base64_images: z.array(z.string()).default([]),
  async: z.boolean().optional(),
  callback_url: z.string().url().optional(),
});

/** 文件编排的本地结算/重放错误保留稳定 code，避免被保活适配统一改写成上游错误。 */
function toEditableFileErrorPayload(error: unknown, label: string) {
  const message =
    error instanceof Error ? error.message : `${label} generation failed`;
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "editable_file_task_already_consumed") {
    return toOpenAIErrorPayload(message, {
      status: 409,
      type: "invalid_request_error",
      code,
    });
  }
  if (
    code === "editable_file_refund_pending" ||
    code === "editable_file_quota_release_pending"
  ) {
    return toOpenAIErrorPayload(message, {
      status: 503,
      type: "server_error",
      code,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return toOpenAIErrorPayload(message, {
      status: 499,
      type: "invalid_request_error",
      code: "editable_file_cancelled",
    });
  }
  return toOpenAIErrorPayload(message);
}

/** 构造 PPT/PSD 薄适配：额度与钱包只由编排处理，异步接收后脱离 HTTP 取消信号。 */
function makeEditableFileHandler(
  kind: EditableFileKind,
  capability: "export.ppt" | "export.psd",
  label: string
) {
  return withApiLogging(async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }
    if (!(await canUsePlanCapability(auth.plan, capability))) {
      return openAIImageError(
        `${label} generation is not enabled for this plan.`,
        403,
        "insufficient_plan"
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return openAIImageError("Invalid JSON body");
    }
    const parsed = editableFileSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }
    if (kind === "psd" && parsed.data.base64_images.length === 0) {
      return openAIImageError("base64_images is empty");
    }

    const clientTaskId = parsed.data.client_task_id?.trim();
    // client_task_id 作幂等/审计标识(计费 sourceRef);缺省用服务端 uuid。
    const taskId = clientTaskId || randomUUID();

    const useAsync =
      parsed.data.async === true ||
      request.nextUrl.searchParams.get("async") === "true";

    // 回调 URL 提交期校验(强制 https + 公网;完成时再逐跳复检投递)。
    let callbackUrl: string | undefined;
    if (parsed.data.callback_url) {
      try {
        callbackUrl = await validateCallbackUrl(parsed.data.callback_url);
      } catch (error) {
        return openAIImageError(
          error instanceof Error ? error.message : "Invalid callback_url."
        );
      }
    }

    // 单次生成 + 成功结果构建(sync/async 共用同一产出结构)。
    const runOnce = async () => {
      const result = await runEditableFileForUser({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        kind,
        prompt: parsed.data.prompt,
        base64Images: parsed.data.base64_images,
        taskId,
        signal: useAsync ? undefined : request.signal,
      });
      return {
        object: "editable_file_task" as const,
        id: taskId,
        taskId,
        status: "success" as const,
        kind,
        result: {
          conversation_id: result.conversationId,
          primary_url: result.primaryUrl,
          zip_url: result.zipUrl,
        },
        credits_charged: result.creditsCharged,
      };
    };

    if (useAsync) {
      let task: ReturnType<typeof createAsyncEditableFileTask>;
      try {
        task = createAsyncEditableFileTask({
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          kind,
          clientTaskId,
        });
      } catch (error) {
        if (error instanceof AsyncImageTaskCapacityError) {
          return toAsyncImageTaskCapacityResponse(error);
        }
        throw error;
      }
      // 后台跑完更新内存任务 + 可选回调;fire-and-forget(常驻进程,promise 随进程存活)。
      void (async () => {
        try {
          const payload = await runOnce();
          const completed = completeAsyncImageTask(task.id, {
            completedObject: "editable_file_task",
            result: {
              taskId: payload.taskId,
              kind: payload.kind,
              result: payload.result,
              credits_charged: payload.credits_charged,
            },
          });
          if (completed && callbackUrl) {
            await postAsyncImageCallback(callbackUrl, completed);
          }
        } catch (error) {
          const errorPayload = toEditableFileErrorPayload(error, label);
          const completed = completeAsyncImageTask(task.id, {
            completedObject: "editable_file_task",
            error: errorPayload,
          });
          if (completed && callbackUrl) {
            await postAsyncImageCallback(callbackUrl, completed);
          }
        }
      })();
      return Response.json(toAsyncImageTaskResponse(task));
    }

    return createJsonKeepAliveResponse(() =>
      runOnce().catch((error: unknown) =>
        toEditableFileErrorPayload(error, label)
      )
    );
  });
}

export const postExternalPptGenerations = makeEditableFileHandler(
  "ppt",
  "export.ppt",
  "PPT"
);

export const postExternalPsdGenerations = makeEditableFileHandler(
  "psd",
  "export.psd",
  "PSD"
);
