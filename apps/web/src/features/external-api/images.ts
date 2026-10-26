import { logWarn } from "@repo/shared/logger";
import { buildPublicImageUrl } from "@repo/shared/storage/signed-url";
import { CLIENT_CLOSED_REQUEST_ERROR } from "@/features/image-generation/abort-reason";
import { readGeneratedImage } from "@/features/image-generation/generated-image";
import type { ImageGenerationOperationResult } from "@/features/image-generation/operations";
import { isContentSafetyRejection } from "@/features/image-generation/sla-classification";
import type { GeneratedImageOutput } from "@/features/image-generation/types";

type OpenAIImageData = {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  prompt_repair_notice?: string;
};

type GenerationBillingResult = Pick<
  ImageGenerationOperationResult,
  "creditsConsumed" | "generationId"
>;

export type ExternalImageStreamEvent = {
  event?: string;
  data: unknown;
};

type JsonKeepAliveOptions = {
  keepAliveMs?: number;
  initialWaitMs?: number;
  status?: number;
};

export type ExternalFinalImageOutput = Pick<
  GeneratedImageOutput,
  | "imageUrl"
  | "imageBase64"
  | "revisedPrompt"
  | "promptRepairNotice"
  | "generationId"
  | "outputRole"
>;

export type ExternalApiErrorOptions = {
  type?: string;
  code?: string | null;
  status?: number;
  generationId?: string;
  creditsConsumed?: number;
};

const DEFAULT_JSON_KEEP_ALIVE_INITIAL_WAIT_MS = 2_000;
const DEFAULT_JSON_KEEP_ALIVE_INTERVAL_MS = 10_000;
const JSON_KEEP_ALIVE_PADDING = `${" ".repeat(2048)}\n`;

export const IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS =
  DEFAULT_JSON_KEEP_ALIVE_INITIAL_WAIT_MS;

function getRequestBaseUrl(request: Request) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BETTER_AUTH_URL ||
    new URL(request.url).origin
  );
}

export function getPublicImageUrl(request: Request, imageUrl?: string) {
  return buildPublicImageUrl(imageUrl, getRequestBaseUrl(request), 3600, {});
}

export async function getImageBase64(request: Request, imageUrl?: string) {
  if (!imageUrl) return undefined;

  const buffer = await readGeneratedImage(
    { imageUrl },
    {
      publicBaseUrl: getRequestBaseUrl(request),
      signal: request.signal,
    }
  );
  return buffer.toString("base64");
}

export async function toOpenAIImageData(
  request: Request,
  result: Pick<
    ImageGenerationOperationResult,
    "imageUrl" | "revisedPrompt" | "promptRepairNotice"
  > & {
    imageBase64?: string;
  },
  responseFormat: "url" | "b64_json"
): Promise<OpenAIImageData> {
  const data: OpenAIImageData = {};

  if (responseFormat === "b64_json") {
    // 纯中转：优先用内联 base64，避免回源我方存储 / 转发客户端凭证到上游。
    data.b64_json =
      result.imageBase64 || (await getImageBase64(request, result.imageUrl));
  } else {
    // url 模式：直返绝对 URL（上游或我方存储均兼容）。
    // 纯中转若上游仅给 base64（无 URL），退化为 data: URI 以保证可用。
    data.url =
      getPublicImageUrl(request, result.imageUrl) ??
      (result.imageBase64
        ? `data:image/png;base64,${result.imageBase64}`
        : undefined);
  }

  if (result.revisedPrompt) {
    data.revised_prompt = result.revisedPrompt;
  }
  if (result.promptRepairNotice) {
    data.prompt_repair_notice = result.promptRepairNotice;
  }

  return data;
}

export function getExternalFinalImageOutputs(
  result: Pick<
    ImageGenerationOperationResult,
    | "imageUrl"
    | "imageBase64"
    | "imageOutputs"
    | "revisedPrompt"
    | "promptRepairNotice"
    | "generationId"
    | "responseText"
    | "responseAgent"
  >
): ExternalFinalImageOutput[] {
  const outputs = (result.imageOutputs || []).filter(
    (output) => output.imageUrl || output.imageBase64
  );
  const choices = outputs.filter((output) => output.outputRole === "choice");
  if (choices.length > 0) return choices;

  const finals = outputs.filter((output) => output.outputRole === "final");
  if (finals.length > 0) return finals;

  const nonDrafts = outputs.filter(
    (output) => output.outputRole !== "agent_draft"
  );
  if (nonDrafts.length > 0) {
    const last = nonDrafts.at(-1);
    if (!last) return [];
    return [{ ...last, outputRole: last.outputRole || "final" }];
  }

  if (result.imageUrl || result.imageBase64) {
    return [
      {
        imageUrl: result.imageUrl,
        imageBase64: result.imageBase64,
        revisedPrompt: result.revisedPrompt,
        promptRepairNotice: result.promptRepairNotice,
        generationId: result.generationId,
        outputRole: "final",
      },
    ];
  }

  if (outputs.length > 0) {
    const last = outputs.at(-1);
    if (!last) return [];
    return [{ ...last, outputRole: "final" }];
  }

  return [];
}

export async function toOpenAIImagesResponse(
  request: Request,
  results: readonly ImageGenerationOperationResult[],
  responseFormat: "url" | "b64_json",
  created = Math.floor(Date.now() / 1000),
  logContext?: Record<string, unknown>
) {
  const data = [];

  for (const [index, result] of results.entries()) {
    if (result.error) {
      const options = {
        generationId: result.generationId,
        creditsConsumed: result.creditsConsumed,
      };
      if (logContext) {
        return toLoggedOpenAIErrorPayload(
          result.error,
          { ...logContext, resultIndex: index },
          options
        );
      }
      return toOpenAIErrorPayload(result.error, options);
    }
    const outputs = getExternalFinalImageOutputs(result);
    if (outputs.length === 0) {
      const message =
        result.responseText?.trim() ||
        result.responseAgent?.trim() ||
        "Image generation completed without an image output";
      const options = {
        generationId: result.generationId,
        creditsConsumed: result.creditsConsumed,
      };
      if (logContext) {
        return toLoggedOpenAIErrorPayload(
          message,
          { ...logContext, resultIndex: index },
          options
        );
      }
      return toOpenAIErrorPayload(message, options);
    }
    for (const output of outputs) {
      data.push(
        await toOpenAIImageData(
          request,
          {
            imageBase64: output.imageBase64,
            imageUrl: output.imageUrl,
            revisedPrompt: output.revisedPrompt || result.revisedPrompt,
          },
          responseFormat
        )
      );
    }
  }

  return {
    created,
    data,
    ...toExternalGenerationUsage(results),
    usage: null,
  };
}

export function toExternalGenerationUsage(
  results: readonly GenerationBillingResult[]
) {
  const generationIds = results
    .map((result) => result.generationId)
    .filter((id): id is string => Boolean(id));
  const creditsConsumed =
    Math.round(
      results.reduce(
        (total, result) => total + Math.max(0, result.creditsConsumed || 0),
        0
      ) * 100
    ) / 100;

  return {
    ...(generationIds.length === 1
      ? {
          generation_id: generationIds[0],
          generationId: generationIds[0],
        }
      : generationIds.length > 1
        ? {
            generation_ids: generationIds,
            generationIds,
          }
        : {}),
    credits_consumed: creditsConsumed,
  };
}

export function openAIImageError(message: string, status = 400, code?: string) {
  return Response.json(
    toOpenAIErrorPayload(message, {
      type: "invalid_request_error",
      code: code ?? null,
      status,
    }),
    { status }
  );
}

export function wantsImageStreamResponse(request: Request, stream?: boolean) {
  if (stream) return true;
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

export function toOpenAIResponseImageItem(params: {
  id: string;
  b64Json: string;
  revisedPrompt?: string;
}) {
  return {
    id: params.id,
    type: "image_generation_call",
    status: "completed",
    result: params.b64Json,
    ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
  };
}

export function toOpenAIResponseTextItem(params: { id: string; text: string }) {
  return {
    id: params.id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: params.text,
        annotations: [],
      },
    ],
  };
}

export function createExternalImageStreamResponse(
  run: (
    emit: (event: ExternalImageStreamEvent) => Promise<void>
  ) => Promise<void>
) {
  const encoder = new TextEncoder();
  const keepAliveMs = 5_000;
  const flushPadding = `: ${" ".repeat(2048)}\n\n`;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;

        const write = (chunk: string) => {
          if (closed || cancelled) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };

        keepAlive = setInterval(() => {
          write(`: ping ${Date.now()}\n\n${flushPadding}`);
        }, keepAliveMs);

        const emit = async ({ event, data }: ExternalImageStreamEvent) => {
          if (event) write(`event: ${event}\n`);
          write(
            `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n: flush ${Date.now()}\n\n${flushPadding}`
          );
        };

        try {
          write(`: open ${Date.now()}\n\n${flushPadding}`);
          await run(emit);
          await emit({ data: "[DONE]" });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Image stream failed";
          const payload = toOpenAIErrorPayload(message);
          await emit({
            event: "error",
            data: toExternalErrorStreamData(message, payload),
          });
        } finally {
          if (keepAlive) {
            clearInterval(keepAlive);
            keepAlive = undefined;
          }
          if (!(closed || cancelled)) {
            closed = true;
            try {
              controller.close();
            } catch {
              // The response runtime may already have closed the stream.
            }
          }
        }
      },
      cancel() {
        cancelled = true;
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "CDN-Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    }
  );
}

function defaultErrorTypeForStatus(status: number) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
}

function parseUpstreamHttpError(message: string) {
  const match = /^Upstream\s+.+?\s+API returned HTTP\s+(\d+):\s*(.*)$/i.exec(
    message
  );
  if (!match) return null;

  const status = Number(match[1]);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;

  const parts = (match[2] || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const code = parts[1] || (status === 429 ? "rate_limit_exceeded" : null);
  const type = parts[2] || defaultErrorTypeForStatus(status);

  return { type, code, status };
}

function parseLooseUpstreamStatusError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("generation task id is already in use")) {
    return {
      type: "invalid_request_error",
      code: "idempotency_conflict",
      status: 409,
    };
  }
  const statusMatch =
    /status_code\s*=\s*(\d{3})/.exec(normalized) ||
    /bad response status code\s+(\d{3})/.exec(normalized) ||
    /response status code\s+(\d{3})/.exec(normalized);
  if (!statusMatch) return null;

  const status = Number(statusMatch[1]);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return null;
  }

  return {
    type: defaultErrorTypeForStatus(status),
    code: status === 429 ? "rate_limit_exceeded" : `upstream_http_${status}`,
    status,
  };
}

function classifyExternalApiError(message: string) {
  if (
    message.startsWith(
      "Image generation input exceeds the request memory budget."
    )
  ) {
    return {
      type: "invalid_request_error",
      code: "image_generation_input_too_large",
      status: 413,
    };
  }
  // 排队阶段取消与运行中客户端断开是同一语义：对方已不在线，按 499 记录，
  // 不能落成 502 上游错误而被当作平台故障。
  if (
    message === "Image generation queue request cancelled." ||
    message === CLIENT_CLOSED_REQUEST_ERROR
  ) {
    return {
      type: "invalid_request_error",
      code: "image_generation_cancelled",
      status: 499,
    };
  }
  if (isContentSafetyRejection(message)) {
    return {
      type: "invalid_request_error",
      code: "content_policy_violation",
      status: 400,
    };
  }

  const upstreamHttpError = parseUpstreamHttpError(message);
  if (upstreamHttpError) return upstreamHttpError;

  const normalized = message.toLowerCase();

  if (
    normalized.includes("failed query:") ||
    normalized.includes("failed to connect to database") ||
    normalized.includes("database connection") ||
    normalized.includes("connection terminated unexpectedly") ||
    normalized.includes("terminating connection due to administrator command")
  ) {
    return {
      type: "server_error",
      code: "internal_backend_error",
      status: 503,
    };
  }

  if (
    normalized.includes("moderation") ||
    normalized.includes("aliyun") ||
    normalized.includes("green-cip") ||
    normalized.includes("readtimeout") ||
    normalized.includes("connecttimeout")
  ) {
    return {
      type: "upstream_error",
      code: "content_moderation_failed",
      status: 502,
    };
  }

  const looseUpstreamStatusError = parseLooseUpstreamStatusError(message);
  if (looseUpstreamStatusError) return looseUpstreamStatusError;

  if (
    normalized.includes("unsupported model") ||
    normalized.includes("unsupported chat model") ||
    normalized.includes("unsupported gpt model") ||
    normalized.includes("unsupported image_model") ||
    normalized.includes("use a gpt-image") ||
    normalized.includes("use a non-image model")
  ) {
    return {
      type: "invalid_request_error",
      code: "unsupported_model",
      status: 400,
    };
  }

  if (
    normalized.includes("insufficient credits") ||
    // 积分不足是 CreditError 的中文文案(credits/core.ts),需归为客户端计费错误,
    // 否则落到 502 upstream_error 兜底,被客户端当成可重试故障而疯狂重试。
    normalized.includes("积分不足")
  ) {
    return {
      type: "insufficient_quota",
      code: "insufficient_credits",
      status: 402,
    };
  }

  if (
    normalized.includes("api key quota exceeded") ||
    normalized.includes("api key credit limit")
  ) {
    return {
      type: "insufficient_quota",
      code: "api_key_quota_exceeded",
      status: 402,
    };
  }

  if (
    normalized.includes("not enabled for this plan") ||
    normalized.includes("requires pro plan") ||
    normalized.includes("requires ultra plan") ||
    normalized.includes("requires enterprise plan")
  ) {
    return {
      type: "invalid_request_error",
      code: "insufficient_plan",
      status: 403,
    };
  }

  if (
    normalized.includes("must be between") ||
    normalized.includes("must be no more than") ||
    normalized.includes("no more than") ||
    normalized.includes("exceeds the") ||
    normalized.includes("character limit") ||
    normalized.includes("context must be")
  ) {
    return {
      type: "invalid_request_error",
      code: "plan_limit_exceeded",
      status: 400,
    };
  }

  if (
    normalized.includes("不支持当前请求类型") ||
    normalized.includes("not support current request type")
  ) {
    return {
      type: "invalid_request_error",
      code: "unsupported_backend_request_type",
      status: 400,
    };
  }

  if (
    normalized.includes("选择的生图后端分组不可用") ||
    normalized.includes("当前套餐不可用")
  ) {
    return {
      type: "invalid_request_error",
      code: "backend_group_unavailable",
      status: 403,
    };
  }

  if (
    normalized.includes("当前生图后端分组没有可用账号或 api") ||
    normalized.includes("没有可用账号或 api") ||
    normalized.includes("no available image backend") ||
    normalized.includes("no available backend") ||
    normalized.includes("no available image quota")
  ) {
    return {
      type: "server_error",
      code: "no_available_image_backend",
      status: 503,
    };
  }

  if (
    normalized.includes("concurrency limit reached") ||
    normalized.includes("queue is busy")
  ) {
    return {
      type: "rate_limit_error",
      code: "image_generation_queue_busy",
      status: 429,
    };
  }

  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("limit has been reached") ||
    normalized.includes("limit_reached") ||
    normalized.includes("quota has been exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("quota_exceeded")
  ) {
    return {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      status: 429,
    };
  }

  return {
    type: "upstream_error",
    code: "image_generation_failed",
    status: 502,
  };
}

function sanitizeExternalApiErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("failed query:") ||
    normalized.includes("failed to connect to database") ||
    normalized.includes("database connection") ||
    normalized.includes("connection terminated unexpectedly") ||
    normalized.includes("terminating connection due to administrator command")
  ) {
    return "Internal backend database error while selecting an image backend. Please retry later.";
  }
  return message;
}

export function toOpenAIErrorPayload(
  message: string,
  options?: ExternalApiErrorOptions
) {
  const classification = classifyExternalApiError(message);
  const status = options?.status ?? classification.status;
  const code =
    options && "code" in options ? options.code : classification.code;
  const generationId = options?.generationId;
  const creditsConsumed = options?.creditsConsumed;
  const safeMessage = sanitizeExternalApiErrorMessage(message);

  return {
    error: {
      message: safeMessage,
      type: options?.type ?? classification.type,
      code,
      status,
      ...(generationId ? { generation_id: generationId, generationId } : {}),
      ...(creditsConsumed !== undefined
        ? { credits_consumed: creditsConsumed }
        : {}),
    },
    ...(generationId ? { generation_id: generationId, generationId } : {}),
    ...(creditsConsumed !== undefined
      ? { credits_consumed: creditsConsumed }
      : {}),
  };
}

export function toExternalErrorStreamData(
  message: string,
  payload: ReturnType<typeof toOpenAIErrorPayload>
) {
  return {
    type: payload.error.type,
    code: payload.error.code,
    status: payload.error.status,
    message,
    error: payload.error,
    ...(payload.generation_id
      ? {
          generation_id: payload.generation_id,
          generationId: payload.generationId,
        }
      : {}),
    ...(payload.credits_consumed !== undefined
      ? { credits_consumed: payload.credits_consumed }
      : {}),
  };
}

export function toLoggedOpenAIErrorPayload(
  message: string,
  context: Record<string, unknown>,
  options?: ExternalApiErrorOptions
) {
  const payload = toOpenAIErrorPayload(message, options);
  logWarn("External API image request failed", {
    ...context,
    errorType: payload.error.type,
    errorCode: payload.error.code,
    status: payload.error.status,
    generationId: payload.generation_id,
    creditsConsumed: payload.credits_consumed,
    message,
  });
  return payload;
}

function isErrorPayload(data: unknown) {
  return Boolean(data && typeof data === "object" && "error" in data);
}

function getJsonStatus(data: unknown, fallback = 200) {
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error?: { status?: unknown } }).error;
    if (typeof error?.status === "number") return error.status;
  }
  if (isErrorPayload(data)) return 400;
  return fallback;
}

export async function createJsonKeepAliveResponse(
  run: () => Promise<unknown>,
  options?: JsonKeepAliveOptions
) {
  const runResult = run().then(
    (data) => data ?? null,
    (error) =>
      toOpenAIErrorPayload(
        error instanceof Error ? error.message : "Image request failed"
      )
  );

  const initialWaitMs =
    options?.initialWaitMs ?? DEFAULT_JSON_KEEP_ALIVE_INITIAL_WAIT_MS;
  const initialResult = await Promise.race([
    runResult,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), initialWaitMs)
    ),
  ]);

  if (initialResult !== undefined) {
    return Response.json(initialResult, {
      status: getJsonStatus(initialResult, options?.status ?? 200),
      headers: {
        "Cache-Control": "no-store, no-transform",
      },
    });
  }

  const encoder = new TextEncoder();
  const keepAliveMs =
    options?.keepAliveMs ?? DEFAULT_JSON_KEEP_ALIVE_INTERVAL_MS;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;

        const write = (chunk: string) => {
          if (closed || cancelled) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };

        write(JSON_KEEP_ALIVE_PADDING);
        keepAlive = setInterval(() => {
          write(JSON_KEEP_ALIVE_PADDING);
        }, keepAliveMs);

        try {
          const data = await runResult;
          write(JSON.stringify(data));
        } finally {
          if (keepAlive) {
            clearInterval(keepAlive);
            keepAlive = undefined;
          }
          if (!(closed || cancelled)) {
            closed = true;
            try {
              controller.close();
            } catch {
              // The response runtime may already have closed the stream.
            }
          }
        }
      },
      cancel() {
        cancelled = true;
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
      },
    }),
    {
      status: options?.status ?? 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "CDN-Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    }
  );
}
