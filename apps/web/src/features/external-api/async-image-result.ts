/** 普通 async 的可重建响应引用；不携带 b64/内容，不增加任何持久化表或对象。 */
import {
  buildSignedStorageImageUrl,
  parseStorageImageUrl,
} from "@repo/shared/storage/signed-url";
import type { ImageGenerationOperationResult } from "@/features/image-generation/batch-runner";
import {
  getExternalFinalImageOutputs,
  toOpenAIImagesResponse,
  toOpenAIErrorPayload,
  toExternalGenerationUsage,
} from "./images";

export type AsyncImageResult = {
  results: readonly ImageGenerationOperationResult[];
  responseFormat: "url" | "b64_json";
  created: number;
  publicBaseUrl?: string;
};

export type AsyncImageResultReference = {
  userId: string;
  responseFormat: "url" | "b64_json";
  created: number;
  publicBaseUrl?: string;
  results: {
    generationId?: string;
    creditsConsumed?: number;
    error?: string;
    historyPending?: boolean;
    deliveryAvailable?: boolean;
    settlementStatus?: "refund_pending" | "refunded";
    creditsLastKnown?: number;
    refundTargetCredits?: number;
    outputs: {
      generationId?: string;
      bucket: string;
      key: string;
      revisedPrompt?: string;
    }[];
  }[];
};

/** 只接受可信管线刚保存的站内对象；未知字段和原图即使误传也不进入引用对象。 */
export function toAsyncImageResultReference(
  input: AsyncImageResult,
  userId: string
): AsyncImageResultReference {
  return {
    userId,
    created: input.created,
    responseFormat: input.responseFormat,
    publicBaseUrl: input.publicBaseUrl,
    results: input.results.map((result) => ({
      generationId: result.generationId,
      creditsConsumed: result.creditsConsumed,
      error: result.error?.slice(0, 4096),
      historyPending: result.historyPending,
      deliveryAvailable: result.deliveryAvailable,
      settlementStatus: result.settlementStatus,
      creditsLastKnown: result.creditsLastKnown,
      refundTargetCredits: result.refundTargetCredits,
      outputs:
        result.error && !result.deliveryAvailable && !result.settlementStatus
          ? []
          : getExternalFinalImageOutputs(result).map((output) => {
              const reference =
                output.imageUrl &&
                parseStorageImageUrl(
                  output.imageUrl,
                  process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL
                );
              if (!reference)
                throw new Error("Missing stored async image reference");
              return {
                generationId: output.generationId,
                bucket: reference.bucket,
                key: reference.key,
                revisedPrompt: output.revisedPrompt || result.revisedPrompt,
              };
            }),
    })),
  };
}

/**
 * 每次投递重签并按 response_format 编码；不把生成的 b64 写回任务 Map。
 *
 * @param responseFormat 缺省用提交时的格式；任务模式查询传 url
 */
export async function renderAsyncImageResult(
  request: Request,
  reference: AsyncImageResultReference,
  responseFormat: "url" | "b64_json" = reference.responseFormat
) {
  const deliveryRequest = reference.publicBaseUrl
    ? new Request(reference.publicBaseUrl, { signal: request.signal })
    : request;
  const results = reference.results.map((result) => ({
    generationId: result.generationId,
    creditsConsumed: result.creditsConsumed,
    error: result.error,
    historyPending: result.historyPending,
    deliveryAvailable: result.deliveryAvailable,
    settlementStatus: result.settlementStatus,
    creditsLastKnown: result.creditsLastKnown,
    refundTargetCredits: result.refundTargetCredits,
    imageOutputs: result.outputs.map((output) => ({
      generationId: output.generationId,
      imageUrl:
        buildSignedStorageImageUrl(output.key, output.bucket) || undefined,
      revisedPrompt: output.revisedPrompt,
      outputRole: "final" as const,
    })),
  }));
  let resolvedReady = false;
  // 仅补偿中的成员重读账本；R11 后台完成后不能继续把旧净扣费快照当真。
  for (const result of results) {
    if (!result.settlementStatus || !result.generationId) continue;
    const {
      readGenerationNetCredits,
      readGenerationCompletionState,
      readGenerationCompletionRefundPlan,
    } = await import("@repo/shared/generation-maintenance");
    result.creditsConsumed = await readGenerationNetCredits(
      reference.userId,
      result.generationId
    );
    if (result.creditsConsumed !== undefined) {
      const state = await readGenerationCompletionState(
        reference.userId,
        result.generationId
      );
      if (state !== "unknown") {
        result.error = undefined;
        result.settlementStatus = undefined;
        result.deliveryAvailable = true;
        result.historyPending = state === "ready";
        resolvedReady = true;
        continue;
      }
    }
    try {
      const plan = await readGenerationCompletionRefundPlan(
        reference.userId,
        result.generationId,
        result.creditsLastKnown ?? 0,
        result.refundTargetCredits
      );
      result.creditsConsumed = plan.net;
      result.refundTargetCredits = plan.targetCredits;
      const pending = plan.net > plan.targetCredits;
      result.settlementStatus = pending ? "refund_pending" : "refunded";
      result.deliveryAvailable = pending;
    } catch {
      result.settlementStatus = "refund_pending";
      result.deliveryAvailable = true;
    }
  }
  const payload = await toAsyncImageResultPayload(deliveryRequest, {
    results,
    responseFormat,
    created: reference.created,
  });
  return {
    ...payload,
    ...(resolvedReady && results.every((result) => !result.error)
      ? { status: "completed" }
      : {}),
  };
}

/** 单个后台成员抛错也须汇总其他成功成员，不能让 batch throw 抹掉已付费输出。 */
export async function runAsyncImageGeneration(
  generationId: string,
  run: () => Promise<ImageGenerationOperationResult>
): Promise<ImageGenerationOperationResult> {
  try {
    return await run();
  } catch (error) {
    return {
      generationId,
      error:
        error instanceof Error
          ? error.message.slice(0, 4096)
          : "Async image generation failed",
    };
  }
}

/** async 批次部分失败也交付已成功的付费图片；保留原错误字段并附全批次用量。 */
export async function toAsyncImageResultPayload(
  request: Request,
  input: AsyncImageResult
) {
  const successes = input.results
    .filter((result) => !result.error || result.deliveryAvailable)
    .map((result) => ({ ...result, error: undefined }));
  const failure = input.results.find((result) => result.error);
  const images = await toOpenAIImagesResponse(
    request,
    successes,
    input.responseFormat,
    input.created
  );
  return {
    ...images,
    ...(failure
      ? toOpenAIErrorPayload(
          failure.error?.slice(0, 4096) || "Async image failed"
        )
      : {}),
    ...toAsyncGenerationUsage(input.results),
  };
}

/** 终态补偿费用未知必须为 null/pending，不能被常规缺省汇总冒充已退款的 0。 */
export function toAsyncGenerationUsage(
  results: readonly Pick<
    ImageGenerationOperationResult,
    | "generationId"
    | "creditsConsumed"
    | "historyPending"
    | "settlementStatus"
    | "creditsLastKnown"
  >[]
) {
  const usage = toExternalGenerationUsage(results);
  const compensations = results.filter((result) => result.settlementStatus);
  return {
    ...usage,
    ...(results.some((result) => result.historyPending)
      ? { history_pending: true }
      : {}),
    ...(compensations.length
      ? {
          credits_consumed: compensations.some(
            (result) => result.creditsConsumed === undefined
          )
            ? null
            : usage.credits_consumed,
          settlement_status: compensations.some(
            (result) => result.settlementStatus === "refund_pending"
          )
            ? "refund_pending"
            : "refunded",
          settlements: compensations.map((result) => ({
            generation_id: result.generationId,
            status: result.settlementStatus,
            credits_consumed: result.creditsConsumed ?? null,
            last_known_credits: result.creditsLastKnown,
          })),
        }
      : {}),
  };
}
