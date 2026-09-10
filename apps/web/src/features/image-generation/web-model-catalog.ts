/**
 * ChatGPT Web 的已验证模型目录与请求参数，供 chatgpt-web 的 Work/Images 分流使用。
 * 纯模块：仅依赖站内模型常量与类型，不读取账号配置，不发网络请求。
 * 原始 HAR 证据（entry 从 0 开始）：chatgpt-image-generation.har #198 为 Work
 * 目录，#199 为普通目录；work-{sol,terra,luna,gpt55,astra}-chat-all-levels.har
 * 的 POST 与历史 GET 验证了模型和全部 Work 档位；不保存会话数据或原始 HAR。
 */
import {
  GPT6_ASTRA_CHAT_MODEL,
  GPT55_CHAT_MODEL,
  GPT56_LUNA_CHAT_MODEL,
  GPT56_SOL_CHAT_MODEL,
  GPT56_TERRA_CHAT_MODEL,
  type ResponsesImageModel,
} from "@repo/shared/config/subscription-plan";
import type { ThinkingLevel } from "./types";

/** Web 专属目录值；max/ultra 不扩展站内 OpenAI API 的 ThinkingLevel。 */
export type WorkWebThinkingEffort =
  | "min"
  | "standard"
  | "extended"
  | "xhigh"
  | "max"
  | "ultra";

export type WorkWebModel = {
  apiModel: ResponsesImageModel;
  modelSlug: string;
  thinkingEfforts: readonly WorkWebThinkingEffort[];
  defaultThinkingEffort: WorkWebThinkingEffort;
};

/**
 * /backend-api/tpp/models/ 的五个模型；该目录与 /backend-api/models 的同名模型
 * 档位不同，必须按实际 Work 请求保留 xhigh/max/ultra 的差异。
 */
export const WORK_WEB_MODEL_CATALOG = [
  {
    apiModel: GPT55_CHAT_MODEL,
    modelSlug: "gpt-5.5-wm",
    thinkingEfforts: ["min", "standard", "extended", "xhigh"],
    defaultThinkingEffort: "standard",
  },
  {
    apiModel: GPT56_SOL_CHAT_MODEL,
    modelSlug: "gpt-5.6-sol-wm",
    thinkingEfforts: ["min", "standard", "extended", "xhigh", "max", "ultra"],
    defaultThinkingEffort: "min",
  },
  {
    apiModel: GPT56_TERRA_CHAT_MODEL,
    modelSlug: "gpt-5.6-terra-wm",
    thinkingEfforts: ["min", "standard", "extended", "xhigh", "max", "ultra"],
    defaultThinkingEffort: "standard",
  },
  {
    apiModel: GPT56_LUNA_CHAT_MODEL,
    modelSlug: "gpt-5.6-luna-wm",
    thinkingEfforts: ["min", "standard", "extended", "xhigh", "max"],
    defaultThinkingEffort: "standard",
  },
  {
    apiModel: GPT6_ASTRA_CHAT_MODEL,
    modelSlug: "gpt-6-astra-wm",
    thinkingEfforts: ["min", "standard", "extended", "xhigh", "max", "ultra"],
    defaultThinkingEffort: "standard",
  },
] as const satisfies readonly WorkWebModel[];

export type ImagesWebPreset = {
  preset: "instant" | "medium" | "high" | "xhigh" | "pro";
  catalogModelSlug: string;
  requestModelSlug: string;
  /** 实际请求的 effort；Pro 目录预设省略该字段，但实际提交使用 standard。 */
  thinkingEffort?: "standard" | "extended" | "max";
};

export type ImagesWebVersion = {
  version: "latest" | "5.6" | "5.5";
  presets: readonly ImagesWebPreset[];
};

/**
 * Images 五预设。Latest 即时/中/高/极高来自 images-latest-all-levels.har
 * #79/#677/#1227/#1762，Pro 来自 chatgpt-image-generation.har #4。
 * 5.6 各档来自 images-gpt56-home-{1..5}-*.har #64/#76/#75/#98/#70；
 * 5.5 各档来自 images-gpt55-home-{1..5}-*.har #103/#69/#106/#78/#70。
 * 所有列出的请求均 HTTP 200；5.6 即时实际提交 gpt-5-6，不能照抄目录的 instant。
 */
export const IMAGES_WEB_MODEL_CATALOG = [
  {
    version: "latest",
    presets: [
      {
        preset: "instant",
        catalogModelSlug: "gpt-5-6-instant",
        requestModelSlug: "gpt-5-6",
      },
      {
        preset: "medium",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "standard",
      },
      {
        preset: "high",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "extended",
      },
      {
        preset: "xhigh",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "max",
      },
      {
        preset: "pro",
        catalogModelSlug: "gpt-6-pro",
        requestModelSlug: "gpt-6-pro",
        thinkingEffort: "standard",
      },
    ],
  },
  {
    version: "5.6",
    presets: [
      {
        preset: "instant",
        catalogModelSlug: "gpt-5-6-instant",
        requestModelSlug: "gpt-5-6",
      },
      {
        preset: "medium",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "standard",
      },
      {
        preset: "high",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "extended",
      },
      {
        preset: "xhigh",
        catalogModelSlug: "gpt-5-6-thinking",
        requestModelSlug: "gpt-5-6-thinking",
        thinkingEffort: "max",
      },
      {
        preset: "pro",
        catalogModelSlug: "gpt-5-6-pro",
        requestModelSlug: "gpt-5-6-pro",
        thinkingEffort: "standard",
      },
    ],
  },
  {
    version: "5.5",
    presets: [
      {
        preset: "instant",
        catalogModelSlug: "gpt-5-5-instant",
        requestModelSlug: "gpt-5-5-instant",
      },
      {
        preset: "medium",
        catalogModelSlug: "gpt-5-5-thinking",
        requestModelSlug: "gpt-5-5-thinking",
        thinkingEffort: "standard",
      },
      {
        preset: "high",
        catalogModelSlug: "gpt-5-5-thinking",
        requestModelSlug: "gpt-5-5-thinking",
        thinkingEffort: "extended",
      },
      {
        preset: "xhigh",
        catalogModelSlug: "gpt-5-5-thinking",
        requestModelSlug: "gpt-5-5-thinking",
        thinkingEffort: "max",
      },
      {
        preset: "pro",
        catalogModelSlug: "gpt-5-5-pro",
        requestModelSlug: "gpt-5-5-pro",
        thinkingEffort: "standard",
      },
    ],
  },
] as const satisfies readonly ImagesWebVersion[];

export type WebModelRequestOptions = {
  gptModel?: string;
  thinking?: ThinkingLevel;
  promptOptimization?: boolean;
};

export type WorkWebModelRequest = {
  model: string;
  thinking_effort: WorkWebThinkingEffort;
  conversation_origin: "tpp";
  service_tier: "standard";
};

export type ImagesWebModelRequest =
  | {
      model: string;
      thinking_effort?: "standard" | "extended" | "max";
    }
  | WorkWebModelRequest;

/**
 * 将已通过套餐校验的站内模型映射为 Work 请求参数，无副作用。
 * 缺省使用 GPT-5.5；未知或自定义 Web slug 返回 null，由调用方保留原有协议处理。
 * 本函数只处理现有 ThinkingLevel，不接受 Web 目录新增的 max/ultra 输入。
 */
export function resolveWorkWebModel(
  options: WebModelRequestOptions
): WorkWebModelRequest | null {
  const apiModel = options.gptModel?.trim() || GPT55_CHAT_MODEL;
  const model = WORK_WEB_MODEL_CATALOG.find(
    (entry) => entry.apiModel === apiModel
  );
  if (!model) return null;
  const thinking = options.thinking;
  const effort =
    options.promptOptimization === false ||
    thinking === "none" ||
    thinking === "minimal" ||
    thinking === "low"
      ? "min"
      : thinking === "medium"
        ? "standard"
        : thinking === "high"
          ? "extended"
          : thinking === "xhigh"
            ? "xhigh"
            : model.defaultThinkingEffort;
  return {
    model: model.modelSlug,
    thinking_effort: effort,
    conversation_origin: "tpp",
    service_tier: "standard",
  };
}

/**
 * 为 Images 页面已验证的 GPT-5.5/Sol 模型选择实际提交参数，无副作用。
 * 低档和缺省使用已实测 standard：目录存在 min，但本组 Images HAR 未验证该档。
 * Astra/Terra/Luna 没有 Images 菜单别名，复用已实测 Work 主模型 slug，再由调用方
 * 通过 picture_v2 请求生图；自定义 slug 仍返回 null。
 */
export function resolveImagesWebModel(
  options: WebModelRequestOptions
): ImagesWebModelRequest | null {
  const apiModel = options.gptModel?.trim() || GPT55_CHAT_MODEL;
  const version =
    apiModel === GPT55_CHAT_MODEL
      ? "5.5"
      : apiModel === GPT56_SOL_CHAT_MODEL
        ? "5.6"
        : null;
  if (!version) {
    return apiModel === GPT6_ASTRA_CHAT_MODEL ||
      apiModel === GPT56_TERRA_CHAT_MODEL ||
      apiModel === GPT56_LUNA_CHAT_MODEL
      ? resolveWorkWebModel(options)
      : null;
  }
  const thinking = options.thinking;
  const preset =
    options.promptOptimization === false ||
    thinking === "none" ||
    thinking === "minimal"
      ? "instant"
      : thinking === "high"
        ? "high"
        : thinking === "xhigh"
          ? "xhigh"
          : "medium";
  const entry: ImagesWebPreset | undefined = IMAGES_WEB_MODEL_CATALOG.find(
    (item) => item.version === version
  )?.presets.find((item) => item.preset === preset);
  if (!entry) return null;
  return {
    model: entry.requestModelSlug,
    ...(entry.thinkingEffort ? { thinking_effort: entry.thinkingEffort } : {}),
  };
}
