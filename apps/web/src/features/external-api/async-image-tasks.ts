import { randomUUID } from "node:crypto";
import { logError } from "@repo/shared/logger";
import {
  assertPublicCallbackUrl,
  fetchPublicCallback,
} from "./safe-image-fetch";

type AsyncImageTaskStatus = "processing" | "completed" | "failed";

export type AsyncImageTask = {
  id: string;
  object: "image.generation" | "image" | "editable_file_task";
  userId: string;
  apiKeyId?: string;
  model?: string;
  status: AsyncImageTaskStatus;
  created_at: string;
  completed_at?: string;
  generation_id?: string;
  generationId?: string;
  generation_ids?: string[];
  generationIds?: string[];
  [key: string]: unknown;
};

type CreateAsyncImageTaskParams = {
  userId: string;
  apiKeyId?: string;
  model?: string;
  generationIds?: string[];
};

type CompleteAsyncImageTaskParams = {
  result?: unknown;
  error?: unknown;
  // 完成后的 object 类型。图像任务从 image.generation 转为 image(默认);可编辑文件任务
  // 传 "editable_file_task" 以保持类型不变(不被误标成 image)。
  completedObject?: AsyncImageTask["object"];
};

const TASK_TTL_MS = 30 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 10_000;
const asyncImageTasks = new Map<string, AsyncImageTask>();

// 回调 URL 提交期校验：强制 https + 公网（内网黑名单复用 safe-image-fetch 单一来源）。
export async function validateCallbackUrl(value: string) {
  const url = await assertPublicCallbackUrl(value);
  return url.toString();
}

export function createAsyncImageTask(params: CreateAsyncImageTaskParams) {
  const id = `task_${randomUUID().replace(/-/g, "")}`;
  const generationIds = params.generationIds?.filter(Boolean);
  const now = new Date();
  const task: AsyncImageTask = {
    id,
    object: "image.generation",
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    model: params.model,
    status: "processing",
    created: Math.floor(now.getTime() / 1000),
    created_at: now.toISOString(),
    ...(generationIds?.length === 1
      ? {
          generation_id: generationIds[0],
          generationId: generationIds[0],
        }
      : generationIds?.length
        ? {
            generation_ids: generationIds,
            generationIds,
          }
        : {}),
  };
  asyncImageTasks.set(id, task);
  const timeout = setTimeout(() => asyncImageTasks.delete(id), TASK_TTL_MS);
  if (
    typeof timeout === "object" &&
    "unref" in timeout &&
    typeof timeout.unref === "function"
  ) {
    timeout.unref();
  }
  return task;
}

type CreateAsyncEditableFileTaskParams = {
  userId: string;
  apiKeyId?: string;
  kind: "ppt" | "psd";
  clientTaskId?: string;
};

/**
 * 创建一个可编辑文件(PPT/PSD)异步任务(与图像任务同一内存存储/TTL/回调基础设施)。
 * object=editable_file_task;返回 task_<uuid> 立即回给客户端,后台跑完再 completeAsyncImageTask
 * (completedObject 传 editable_file_task 保持类型)。可编辑文件无 DB generation 行,故只走内存态。
 */
export function createAsyncEditableFileTask(
  params: CreateAsyncEditableFileTaskParams
) {
  const id = `task_${randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const task: AsyncImageTask = {
    id,
    object: "editable_file_task",
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    kind: params.kind,
    ...(params.clientTaskId ? { client_task_id: params.clientTaskId } : {}),
    status: "processing",
    created: Math.floor(now.getTime() / 1000),
    created_at: now.toISOString(),
  };
  asyncImageTasks.set(id, task);
  const timeout = setTimeout(() => asyncImageTasks.delete(id), TASK_TTL_MS);
  if (
    typeof timeout === "object" &&
    "unref" in timeout &&
    typeof timeout.unref === "function"
  ) {
    timeout.unref();
  }
  return task;
}

export function getAsyncImageTask(id: string) {
  return asyncImageTasks.get(id);
}

export function toAsyncImageTaskResponse(task: AsyncImageTask) {
  const { userId: _userId, apiKeyId: _apiKeyId, ...publicTask } = task;
  return publicTask;
}

/** 一条 generation 记录(DB 回退查询用的最小字段集)。 */
export type GenerationTaskRow = {
  id: string;
  model: string;
  status: "pending" | "completed" | "failed";
  revisedPrompt: string | null;
  creditsConsumed: string | number | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

/**
 * 把一条 generation 记录转成 /v1/images/{id} 的响应（DB 回退路径，纯函数 DB-free）。
 *
 * 内存异步任务存储是临时态（仅 async=true 创建、按 task_<uuid> 为键、进程内、30 分钟
 * TTL、多实例不共享、重启即清），同步请求拿到的是 generation_id 而非 task id。本函数让
 * 接口可按 generation_id 从 DB 持久取回，对同步/异步、跨实例/重启都稳。归属校验（userId）
 * 由调用方在查库后完成，本函数只做结构映射，不含权限判断。
 *
 * 结构对齐同步成功响应（data:[{url, revised_prompt}]）+ 任务状态字段；并额外给
 * image_url 顶层兜底，便于只取单一 URL 的客户端。
 */
export function toGenerationImageTaskResponse(
  row: GenerationTaskRow,
  imageUrl: string | null
) {
  const status: AsyncImageTaskStatus =
    row.status === "completed"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : "processing";
  const credits = Number(row.creditsConsumed ?? 0);
  return {
    id: row.id,
    object: status === "completed" ? "image" : "image.generation",
    model: row.model,
    status,
    created: Math.floor(row.createdAt.getTime() / 1000),
    created_at: row.createdAt.toISOString(),
    ...(row.completedAt
      ? { completed_at: row.completedAt.toISOString() }
      : {}),
    generation_id: row.id,
    generationId: row.id,
    ...(status === "completed" && imageUrl
      ? {
          image_url: imageUrl,
          data: [
            {
              url: imageUrl,
              ...(row.revisedPrompt
                ? { revised_prompt: row.revisedPrompt }
                : {}),
            },
          ],
        }
      : {}),
    ...(status === "failed" && row.error
      ? { error: { message: row.error } }
      : {}),
    ...(Number.isFinite(credits) ? { credits_consumed: credits } : {}),
  };
}

export function completeAsyncImageTask(
  id: string,
  params: CompleteAsyncImageTaskParams
) {
  const existing = asyncImageTasks.get(id);
  if (!existing) return undefined;

  const now = new Date();
  const completedAt = now.toISOString();
  const payload = params.error ?? params.result;
  const payloadFields =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : params.error
        ? { error: payload }
        : { result: payload };
  const task: AsyncImageTask = {
    ...existing,
    ...payloadFields,
    object: params.completedObject ?? "image",
    status: params.error ? "failed" : "completed",
    completed: Math.floor(now.getTime() / 1000),
    completed_at: completedAt,
  };
  asyncImageTasks.set(id, task);
  return task;
}

export async function postAsyncImageCallback(
  callbackUrl: string,
  payload: AsyncImageTask
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    // 完成时再经逐跳复检投递：弥补"提交校验通过、30 分钟后被 302 跳内网"的 TOCTOU 盲 SSRF。
    const response = await fetchPublicCallback(callbackUrl, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Tokens-Callback": "true",
      },
      body: JSON.stringify(toAsyncImageTaskResponse(payload)),
    });
    if (!response.ok) {
      logError(new Error(`Callback returned HTTP ${response.status}`), {
        source: "external-api-async-image-callback",
        taskId: payload.id,
        callbackUrl,
      });
    }
  } catch (error) {
    logError(error, {
      source: "external-api-async-image-callback",
      taskId: payload.id,
      callbackUrl,
    });
  } finally {
    clearTimeout(timeout);
  }
}
