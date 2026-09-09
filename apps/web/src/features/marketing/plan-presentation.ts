import {
  PLAN_RANK,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import type {
  PlanCapabilityKey,
  PlanCapabilityMatrix,
} from "@repo/shared/subscription/services/plan-capabilities";

import {
  formatImageRetentionPolicy,
  type ImageRetentionPolicy,
} from "./image-retention-policy";

type PlanPresentationOptions = {
  planId: SubscriptionPlan;
  capabilityMatrix: PlanCapabilityMatrix;
  imageRetentionPolicy: ImageRetentionPolicy;
  locale: string;
};

export type PlanPresentation = {
  monthlyCredits: number;
  description: string;
  features: string[];
};

export function buildPlanPresentation({
  planId,
  capabilityMatrix,
  imageRetentionPolicy,
  locale,
}: PlanPresentationOptions): PlanPresentation {
  const zh = locale.startsWith("zh");
  const copy = (en: string, chinese: string) => (zh ? chinese : en);
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(value);
  const formatCredits = (value: number) =>
    formatNumber(value, { maximumFractionDigits: 0 });
  const formatMegabytes = (value: number) =>
    `${formatNumber(value, { maximumFractionDigits: 0 })}MB`;
  const canUse = (capability: PlanCapabilityKey) =>
    PLAN_RANK[planId] >= PLAN_RANK[capabilityMatrix.features[capability]];
  const limits = capabilityMatrix.limits[planId];
  const credits = formatCredits(limits.monthlyCredits);

  let description: string;
  if (planId === "free") {
    description = copy(
      `Basic image generation with ${credits} one-time credits`,
      `基础创作体验，含 ${credits} 一次性积分`
    );
  } else {
    const highlights = [
      copy(`${credits} credits/month`, `每月 ${credits} 积分`),
    ];
    if (canUse("externalApi.keys.manage")) {
      highlights.push(copy("API access", "开放 API"));
    }
    if (canUse("imageGeneration.chat")) {
      highlights.push(copy("Chat creation", "对话创作"));
    }
    if (canUse("imageGeneration.agent")) {
      highlights.push(copy("Agent iteration", "Agent 迭代"));
    }
    if (canUse("models.premium")) highlights.push("GPT-6 Astra / GPT-5.6");
    description = highlights.join(copy(", ", "，"));
  }

  const features: string[] = [
    planId === "free"
      ? copy(
          "One-time credits follow the issued batch expiry",
          "一次性积分按发放批次有效期计算"
        )
      : copy(
          "Subscription credits are valid for the current plan period",
          "订阅积分按当前套餐周期有效"
        ),
  ];

  const modes = [
    canUse("imageGeneration.text") && copy("text-to-image", "文生图"),
    canUse("imageGeneration.edit") && copy("image editing", "图生图"),
    canUse("imageGeneration.chat") && copy("chat-to-image", "对话生图"),
    canUse("imageGeneration.waterfall") && copy("waterfall", "瀑布流"),
    canUse("imageGeneration.agent") && "Agent",
  ].filter((mode): mode is string => Boolean(mode));
  if (modes.length > 0) {
    features.push(
      copy(
        `Creation modes: ${modes.join(", ")}`,
        `创作模式：${modes.join("、")}`
      )
    );
  }

  if (canUse("imageGeneration.batch")) {
    features.push(
      copy(
        `Batch generation up to ${limits.maxBatchCount} images`,
        `批量生成最多 ${limits.maxBatchCount} 张图`
      )
    );
  }

  features.push(
    copy(
      `Uploads: ${formatMegabytes(limits.maxFileMb)} per image, ${formatMegabytes(
        limits.maxUploadMb
      )} total`,
      `上传：单图 ${formatMegabytes(limits.maxFileMb)}，总量 ${formatMegabytes(
        limits.maxUploadMb
      )}`
    ),
    copy(
      `References: ${limits.maxEditImages} edit images, ${limits.maxChatImages} chat images`,
      `参考图：编辑最多 ${limits.maxEditImages} 张，对话最多 ${limits.maxChatImages} 张`
    )
  );

  const priorityLabel =
    limits.queuePriority === "highest"
      ? copy("highest priority", "最高优先级")
      : limits.queuePriority === "priority"
        ? copy("priority queue", "优先队列")
        : copy("normal queue", "普通队列");
  features.push(
    copy(
      `${priorityLabel}, up to ${limits.imageGenerationConcurrency} concurrent generations`,
      `${priorityLabel}，最多 ${limits.imageGenerationConcurrency} 并发`
    )
  );

  const externalApiParts = [
    canUse("externalApi.chat.completions") && "Chat",
    (canUse("externalApi.images.generate") ||
      canUse("externalApi.images.edit")) &&
      "Images",
    canUse("externalApi.responses") && "Responses",
    canUse("externalApi.agent") && "Agent",
    canUse("externalApi.streaming") && copy("streaming", "流式"),
  ].filter((part): part is string => Boolean(part));
  if (canUse("externalApi.keys.manage") || externalApiParts.length > 0) {
    features.push(
      copy(
        `External API: ${externalApiParts.join(", ") || "API keys"}`,
        `外接 API：${externalApiParts.join("、") || "API Key 管理"}`
      )
    );
  }

  if (canUse("customApi.configure")) {
    features.push(
      copy(
        "Connect your own OpenAI-compatible API",
        "可接入自己的 OpenAI 兼容 API"
      )
    );
  }
  if (canUse("backendGroups.select")) {
    features.push(copy("Selectable backend groups", "可选择后端分组"));
  }
  if (canUse("promptOptimization.control")) {
    features.push(copy("Can minimize prompt changes", "可尽量减少提示词改动"));
  }
  if (canUse("models.premium")) {
    features.push(
      copy(
        "GPT-6 Astra and GPT-5.6 Sol / Terra / Luna available",
        "可使用 GPT-6 Astra 和 GPT-5.6 Sol / Terra / Luna"
      )
    );
  }
  if (canUse("moderation.onlyFailureSettlement")) {
    features.push(
      copy(
        "Moderation failures only charge review credits",
        "审核失败只扣审核积分"
      )
    );
  }

  const moderation = capabilityMatrix.moderation[planId];
  features.push(
    copy(
      `Moderation control up to ${moderation.maxBlockRiskLevel} risk`,
      `审核拦截最高可配置到 ${moderation.maxBlockRiskLevel}`
    )
  );

  const billing = capabilityMatrix.billing[planId];
  if (canUse("imageGeneration.chat") || canUse("imageGeneration.agent")) {
    features.push(
      copy(
        `Chat ${billing.chatRoundCredits} credits/round, Agent ${billing.agentRoundCredits} credits/round before image output fees`,
        `Chat ${billing.chatRoundCredits} 积分/轮，Agent ${billing.agentRoundCredits} 积分/轮，另计出图费用`
      )
    );
  }

  features.push(formatImageRetentionPolicy(imageRetentionPolicy, locale));

  return {
    monthlyCredits: limits.monthlyCredits,
    description,
    features,
  };
}
