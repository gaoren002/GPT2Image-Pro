/** 工作流的浏览器 HTTP 适配；仅调用现有站内生图/编辑路由，不实现计费或上游访问。 */
import { z } from "zod";
import {
  isWorkflowImageUrl,
  type WorkflowImage,
  type WorkflowRunPlan,
  workflowImageSchema,
} from "./workflow-model";

export const MAX_WORKFLOW_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const responseSchema = z.object({
  generationId: z.string().optional(),
  imageUrl: z.string().optional(),
  error: z.string().optional(),
});

/** 区分提交前失败和结果未知；submitted 为真时 UI 必须先引导历史核对，不能重试。 */
export class WorkflowExecutionError extends Error {
  constructor(
    message: string,
    readonly submitted: boolean
  ) {
    super(message);
    this.name = "WorkflowExecutionError";
  }
}

/** 有界读取响应并保留 AbortSignal；错误/超限时释放流，不继续下载剩余正文。 */
async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>[]> {
  if (response.redirected) throw new Error("本站请求发生跳转，已拒绝读取");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("响应超过工作流大小限制");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务器返回空响应");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("响应超过工作流大小限制");
      chunks.push(new Uint8Array(value));
    }
    signal.throwIfAborted();
    return chunks;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** 下载本站签名图作为编辑输入或继续编辑的 Blob；拒绝重定向，凭据仅限同源。 */
export async function fetchWorkflowImage(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Blob> {
  if (!isWorkflowImageUrl(url))
    throw new Error("只能读取本站 /api/storage/ 图片");
  signal.throwIfAborted();
  const response = await fetcher(url, {
    signal,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `参考图读取失败（${response.status}），请刷新近期作品后重新选择`
    );
  }
  const type =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (!Object.hasOwn(imageExtensions, type)) {
    await response.body?.cancel();
    throw new Error("参考图必须为 PNG、JPEG、WebP 或 GIF");
  }
  const bytes = await readResponseBytes(
    response,
    MAX_WORKFLOW_IMAGE_BYTES,
    signal
  );
  const blob = new Blob(bytes, { type });
  if (!blob.size) throw new Error("参考图内容为空");
  return blob;
}

/**
 * 执行唯一的单节点请求。先下载输入，再等待调用方落盘任务编号，然后才 POST。
 * 提交后任意异常均按结果未知处理；调用方展示错误和历史入口，绝不在此自动重试。
 */
export async function executeWorkflowNode({
  plan,
  generationId,
  signal,
  beforeSubmit,
  fetcher = fetch,
}: {
  plan: WorkflowRunPlan;
  generationId: string;
  signal: AbortSignal;
  beforeSubmit: () => Promise<void>;
  fetcher?: typeof fetch;
}): Promise<WorkflowImage> {
  let submitted = false;
  try {
    z.uuid().parse(generationId);
    const files: File[] = [];
    let totalBytes = 0;
    for (const [index, image] of plan.images.entries()) {
      workflowImageSchema.parse(image);
      const blob = await fetchWorkflowImage(image.url, signal, fetcher);
      totalBytes += blob.size;
      if (totalBytes > MAX_UPLOAD_BYTES)
        throw new Error("参考图总大小不能超过 64 MiB");
      files.push(
        new File(
          [blob],
          `reference-${index + 1}.${imageExtensions[blob.type]}`,
          { type: blob.type }
        )
      );
    }
    const parameters = {
      prompt: plan.prompt,
      model: plan.model,
      size: plan.size,
      quality: plan.quality,
      count: 1,
      generationId,
      stream: false,
    };
    let body: string | FormData = JSON.stringify(parameters);
    if (files.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters))
        form.set(key, String(value));
      for (const file of files) form.append("image[]", file);
      body = form;
    }
    signal.throwIfAborted();
    await beforeSubmit();
    signal.throwIfAborted();
    submitted = true;
    const response = await fetcher(
      files.length ? "/api/images/edit" : "/api/images/generate",
      {
        method: "POST",
        body,
        signal,
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          ...(typeof body === "string"
            ? { "Content-Type": "application/json" }
            : {}),
        },
      }
    );
    const chunks = await readResponseBytes(
      response,
      MAX_RESPONSE_BYTES,
      signal
    );
    const text = await new Blob(chunks).text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`未收到有效 JSON 结果（${response.status}）`);
    }
    const result = responseSchema.parse(raw);
    if (!response.ok || result.error)
      throw new Error(
        result.error?.slice(0, 1200) || `请求失败（${response.status}）`
      );
    if (result.generationId && result.generationId !== generationId)
      throw new Error("返回任务编号不匹配，请在历史记录核对");
    if (!result.imageUrl || !isWorkflowImageUrl(result.imageUrl))
      throw new Error("未收到可用的本站图片结果，请在历史记录核对");
    return workflowImageSchema.parse({
      id: generationId,
      prompt: plan.prompt,
      url: result.imageUrl,
      thumbnailUrl: result.imageUrl,
    });
  } catch (error) {
    throw new WorkflowExecutionError(
      error instanceof Error ? error.message.slice(0, 1400) : "图片请求失败",
      submitted
    );
  }
}
