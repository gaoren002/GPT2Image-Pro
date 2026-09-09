import {
  FIREFLY_IMAGE_FAMILY_MODEL_IDS,
  FIREFLY_VIDEO_MODEL_CATALOG,
} from "@repo/shared/adobe/firefly-direct";
import {
  GPT52_CHAT_MODEL,
  GPT53_CODEX_CHAT_MODEL,
  GPT53_CODEX_SPARK_CHAT_MODEL,
  GPT54_CHAT_MODEL,
  GPT54_MINI_CHAT_MODEL,
  GPT55_CHAT_MODEL,
  isPlanAtLeast,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  DEFAULT_IMAGE_MODEL,
  GPT_IMAGE_25_MODELS,
} from "@/features/image-generation/resolution";

const DEFAULT_MODEL_OWNER = "gpt2image";

type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export type OpenAIModelList = {
  object: "list";
  data: OpenAIModel[];
};

export function getExternalResponsesImageModels(
  plan: SubscriptionPlan,
  options?: { responsesAllowed?: boolean; gpt55Allowed?: boolean }
) {
  if (options?.responsesAllowed === false) {
    return [];
  }

  const models: string[] = [
    GPT54_CHAT_MODEL,
    GPT54_MINI_CHAT_MODEL,
    GPT52_CHAT_MODEL,
    GPT53_CODEX_CHAT_MODEL,
    GPT53_CODEX_SPARK_CHAT_MODEL,
  ];
  if (options?.gpt55Allowed ?? isPlanAtLeast(plan, "ultra")) {
    models.push(GPT55_CHAT_MODEL);
  }
  return models;
}

export function getExternalChatCompletionModels(
  plan: SubscriptionPlan,
  options?: { chatCompletionsAllowed?: boolean; gpt55Allowed?: boolean }
) {
  if (options?.chatCompletionsAllowed === false) {
    return [];
  }

  return getExternalResponsesImageModels(plan, {
    responsesAllowed: true,
    gpt55Allowed: options?.gpt55Allowed,
  });
}

export async function isExternalResponsesImageModelAllowed(
  model: string | undefined,
  plan: SubscriptionPlan
) {
  const capabilities = await getPlanCapabilitySnapshot(plan);
  if (!capabilities.features["externalApi.responses"]) return false;
  if (!model) return true;
  return getExternalResponsesImageModels(plan, {
    responsesAllowed: capabilities.features["externalApi.responses"],
    gpt55Allowed: capabilities.features["models.gpt55"],
  }).includes(model.trim());
}

/**
 * Adobe Firefly 模型 id 列表:图像族级 id（分辨率/宽高比走 size 参数）+ 视频全量 id
 * （参数编码在 id 内）。图像与视频生成均由 externalApi.images.generate 门控,关闭时返回
 * 空,避免在 /v1/models 列出无法调用的 model。
 */
export function getExternalFireflyModels(options?: {
  imageGenerateAllowed?: boolean;
}): string[] {
  if (!options?.imageGenerateAllowed) return [];
  return [
    ...FIREFLY_IMAGE_FAMILY_MODEL_IDS,
    ...Object.keys(FIREFLY_VIDEO_MODEL_CATALOG),
  ];
}

function toOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: DEFAULT_MODEL_OWNER,
  };
}

export async function getExternalModelsForUser(
  userId: string
): Promise<OpenAIModelList> {
  const plan = await getUserPlan(userId);
  const capabilities = await getPlanCapabilitySnapshot(plan.plan);
  // 2.5 旗舰双档在前,/v1/models 让 API 用户优先发现当前旗舰;DEFAULT 兜底仍暴露。
  const imageModels = [...GPT_IMAGE_25_MODELS, DEFAULT_IMAGE_MODEL];
  const fireflyModels = getExternalFireflyModels({
    imageGenerateAllowed: capabilities.features["externalApi.images.generate"],
  });
  const chatModels = getExternalChatCompletionModels(plan.plan, {
    chatCompletionsAllowed:
      capabilities.features["externalApi.chat.completions"],
    gpt55Allowed: capabilities.features["models.gpt55"],
  });
  const responsesModels = getExternalResponsesImageModels(plan.plan, {
    responsesAllowed: capabilities.features["externalApi.responses"],
    gpt55Allowed: capabilities.features["models.gpt55"],
  });
  const modelIds = Array.from(
    new Set([
      ...imageModels,
      ...fireflyModels,
      ...chatModels,
      ...responsesModels,
    ])
  );
  return {
    object: "list",
    data: modelIds.map(toOpenAIModel),
  };
}
