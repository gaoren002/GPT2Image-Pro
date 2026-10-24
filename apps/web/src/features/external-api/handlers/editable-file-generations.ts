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
 *   GET /v1/editable-file-tasks/{task_id} 查询持久状态。
 * 内存仅用于本进程准入/尽力回调；接收前持久准备任务，崩溃后过期退款而不重发上游。
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
import { toEditableFileErrorPayload } from "@/features/external-api/editable-file-errors";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  createJsonKeepAliveResponse,
  openAIImageError,
} from "@/features/external-api/images";
import type { EditableFileKind } from "@/features/image-generation/chatgpt-web";
import {
  prepareEditableFileExecution,
  type EditableFileOutput,
} from "@/features/image-generation/editable-file-operations";

const editableFileSchema = z.object({
  client_task_id: z.string().max(200).optional(),
  prompt: z.string().min(1, "prompt is required").max(8000),
  base64_images: z.array(z.string()).default([]),
  async: z.boolean().optional(),
  callback_url: z.string().url().optional(),
});

/** 只透传服务在核验原用户、Key和指纹后附加的恢复ID，绝不使用本次新建内存任务ID。 */
function editableTaskRecoveryFields(error: unknown) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error.code !== "editable_file_task_already_consumed" &&
      error.code !== "editable_file_delivery_pending") ||
    !("publicTaskId" in error) ||
    typeof error.publicTaskId !== "string" ||
    !/^task_[a-zA-Z0-9_-]{16,100}$/.test(error.publicTaskId)
  )
    return {};
  return {
    poll_id: error.publicTaskId,
    poll_url: `/v1/editable-file-tasks/${encodeURIComponent(error.publicTaskId)}`,
  };
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
    const input = {
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      kind,
      prompt: parsed.data.prompt,
      base64Images: parsed.data.base64_images,
      taskId,
      signal: useAsync ? undefined : request.signal,
    };
    const runOnce = async (execute: () => Promise<EditableFileOutput>) => {
      const result = await execute();
      return {
        object: "editable_file_task" as const,
        id: taskId,
        taskId,
        poll_id: result.publicTaskId,
        status: "success" as const,
        kind,
        result: {
          conversation_id: result.conversationId,
          primary_url: result.primaryUrl,
          zip_url: result.zipUrl,
        },
        credits_charged: result.creditsCharged,
        request_fingerprint: result.requestFingerprint,
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
      let execution: Awaited<ReturnType<typeof prepareEditableFileExecution>>;
      try {
        execution = await prepareEditableFileExecution({
          ...input,
          publicTaskId: task.id,
        });
      } catch (error) {
        const payload = {
          ...toEditableFileErrorPayload(error, label),
          ...editableTaskRecoveryFields(error),
        };
        completeAsyncImageTask(task.id, {
          completedObject: "editable_file_task",
          error: payload,
        });
        return Response.json(payload, { status: payload.error.status ?? 500 });
      }
      // 已持久准备才返回接受；进程丢失由任务到期恢复，不重发上游。
      void (async () => {
        try {
          const payload = await runOnce(execution.execute);
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
            await postAsyncImageCallback(callbackUrl, {
              ...completed,
              id: execution.publicTaskId,
            });
          }
        } catch (error) {
          const errorPayload = toEditableFileErrorPayload(error, label);
          const completed = completeAsyncImageTask(task.id, {
            completedObject: "editable_file_task",
            error: errorPayload,
          });
          if (completed && callbackUrl) {
            await postAsyncImageCallback(callbackUrl, {
              ...completed,
              id: execution.publicTaskId,
            });
          }
        }
      })();
      return Response.json(
        {
          ...toAsyncImageTaskResponse(task),
          object: "editable_file_task",
          id: execution.publicTaskId,
          taskId: execution.publicTaskId,
          kind,
          status: "processing",
          request_fingerprint: execution.requestFingerprint,
          poll_url: `/v1/editable-file-tasks/${encodeURIComponent(execution.publicTaskId)}`,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    return createJsonKeepAliveResponse(async () => {
      let execution:
        | Awaited<ReturnType<typeof prepareEditableFileExecution>>
        | undefined;
      try {
        execution = await prepareEditableFileExecution(input);
        return await runOnce(execution.execute);
      } catch (error) {
        return {
          ...toEditableFileErrorPayload(error, label),
          taskId,
          ...(execution
            ? {
                poll_id: execution.publicTaskId,
                request_fingerprint: execution.requestFingerprint,
              }
            : editableTaskRecoveryFields(error)),
        };
      }
    });
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
