/**
 * 按套餐能力生成 OpenAI 兼容模型列表，供 /v1/models 和 Responses 权限校验共用。
 * 图像目录与图像管线共用，文本目录与站内订阅能力共用。
 */
import {
  FIREFLY_IMAGE_FAMILY_MODEL_IDS,
  FIREFLY_VIDEO_MODEL_CATALOG,
} from "@repo/shared/adobe/firefly-direct";
import {
  GPT55_CHAT_MODEL,
  PREMIUM_CHAT_MODELS,
  isPlanAtLeast,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { IMAGE_MODEL_IDS } from "@/features/image-generation/resolution";

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

/** 返回当前套餐可使用的 Responses 文本模型；关闭接口时不暴露任何模型。 */
export function getExternalResponsesImageModels(
  plan: SubscriptionPlan,
  options?: { responsesAllowed?: boolean; premiumModelsAllowed?: boolean }
) {
  if (options?.responsesAllowed === false) {
    return [];
  }

  const models: string[] = [GPT55_CHAT_MODEL];
  if (options?.premiumModelsAllowed ?? isPlanAtLeast(plan, "ultra")) {
    models.push(...PREMIUM_CHAT_MODELS);
  }
  return models;
}

/** Chat Completions 与 Responses 共用文本目录，分别遵守各自接口能力开关。 */
export function getExternalChatCompletionModels(
  plan: SubscriptionPlan,
  options?: { chatCompletionsAllowed?: boolean; premiumModelsAllowed?: boolean }
) {
  if (options?.chatCompletionsAllowed === false) {
    return [];
  }

  return getExternalResponsesImageModels(plan, {
    responsesAllowed: true,
    premiumModelsAllowed: options?.premiumModelsAllowed,
  });
}

/** 读取当前能力配置校验模型；未指定模型时允许管线选择套餐默认值。 */
export async function isExternalResponsesImageModelAllowed(
  model: string | undefined,
  plan: SubscriptionPlan
) {
  const capabilities = await getPlanCapabilitySnapshot(plan);
  if (!capabilities.features["externalApi.responses"]) return false;
  if (!model) return true;
  return getExternalResponsesImageModels(plan, {
    responsesAllowed: capabilities.features["externalApi.responses"],
    premiumModelsAllowed: capabilities.features["models.premium"],
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

/** 将站内模型 ID 编码为 OpenAI 模型目录条目，不虚构上游创建时间。 */
function toOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: DEFAULT_MODEL_OWNER,
  };
}

/** 根据用户套餐合并图像、Firefly 和文本目录；共享模型只返回一次。 */
export async function getExternalModelsForUser(
  userId: string
): Promise<OpenAIModelList> {
  const plan = await getUserPlan(userId);
  const capabilities = await getPlanCapabilitySnapshot(plan.plan);
  const imageModels = [...IMAGE_MODEL_IDS];
  const fireflyModels = getExternalFireflyModels({
    imageGenerateAllowed: capabilities.features["externalApi.images.generate"],
  });
  const chatModels = getExternalChatCompletionModels(plan.plan, {
    chatCompletionsAllowed:
      capabilities.features["externalApi.chat.completions"],
    premiumModelsAllowed: capabilities.features["models.premium"],
  });
  const responsesModels = getExternalResponsesImageModels(plan.plan, {
    responsesAllowed: capabilities.features["externalApi.responses"],
    premiumModelsAllowed: capabilities.features["models.premium"],
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
