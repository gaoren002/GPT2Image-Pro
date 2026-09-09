/**
 * 规范化外部 Responses 原始请求，供图像服务使用；保留扩展字段并应用已校验的模型。
 * 图像简称统一由 resolution 解析，不访问数据库或上游。
 */
import { GPT6_ASTRA_CHAT_MODEL } from "@repo/shared/config/subscription-plan";
import { getUpstreamImageModel } from "./resolution";

export type ResponsesStreamRequestBody = Record<string, unknown> & {
  stream?: boolean;
  tools?: unknown[];
  prompt_cache_key?: string;
};

/** 收窄请求对象，排除数组和空值。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 识别需要填充参数和解析模型的图像工具。 */
function isImageGenerationTool(value: unknown) {
  return isPlainRecord(value) && value.type === "image_generation";
}

/** 识别已有搜索工具，避免重复追加。 */
function isWebSearchTool(value: unknown) {
  return isPlainRecord(value) && value.type === "web_search";
}

/** 识别已有代码解释器工具，避免重复追加。 */
function isCodeInterpreterTool(value: unknown) {
  return isPlainRecord(value) && value.type === "code_interpreter";
}

/** 补全缺省图像参数并解析站内模型别名；不修改调用方传入的工具对象。 */
function normalizeResponsesImageTool(
  value: unknown,
  fallback: Record<string, unknown>
) {
  const tool = isPlainRecord(value) ? { ...value } : {};
  for (const [key, fallbackValue] of Object.entries(fallback)) {
    if (tool[key] === undefined && fallbackValue !== undefined) {
      tool[key] = fallbackValue;
    }
  }
  tool.type = "image_generation";
  if (typeof tool.model === "string") {
    tool.model = getUpstreamImageModel(tool.model);
  }
  return tool;
}

/**
 * 将已通过套餐校验的 model 写入原始请求，校准 Astra 推理强度并规范化所有图像工具。
 * 保留调用方其他扩展字段；强制禁用上游持久化并按管线选择流式模式。
 */
export function normalizeResponsesImageRequestBody(
  rawBody: Record<string, unknown>,
  options: {
    model: string;
    fallbackTool: Record<string, unknown>;
    additionalTools?: Record<string, unknown>[];
    instructions: string;
    stream: boolean;
    defaultToolChoice?: unknown;
  }
): ResponsesStreamRequestBody {
  const body: Record<string, unknown> = {
    ...rawBody,
    model: options.model,
    store: false,
    instructions:
      typeof rawBody.instructions === "string" && rawBody.instructions
        ? rawBody.instructions
        : options.instructions,
    stream: options.stream,
  };
  if (
    options.model === GPT6_ASTRA_CHAT_MODEL &&
    isPlainRecord(body.reasoning) &&
    (body.reasoning.effort === "none" || body.reasoning.effort === "minimal")
  ) {
    body.reasoning = { ...body.reasoning, effort: "low" };
  }
  if (
    body.tool_choice === undefined &&
    options.defaultToolChoice !== undefined
  ) {
    body.tool_choice = options.defaultToolChoice;
  }

  const tools = Array.isArray(rawBody.tools) ? rawBody.tools : [];
  const imageToolIndex = tools.findIndex(isImageGenerationTool);
  if (imageToolIndex >= 0) {
    body.tools = tools.map((item) =>
      isImageGenerationTool(item)
        ? normalizeResponsesImageTool(item, options.fallbackTool)
        : item
    );
  } else {
    body.tools = [
      ...tools,
      normalizeResponsesImageTool(undefined, options.fallbackTool),
    ];
  }
  for (const additionalTool of options.additionalTools || []) {
    if (
      additionalTool.type === "web_search" &&
      (body.tools as unknown[]).some(isWebSearchTool)
    ) {
      continue;
    }
    if (
      additionalTool.type === "code_interpreter" &&
      (body.tools as unknown[]).some(isCodeInterpreterTool)
    ) {
      continue;
    }
    (body.tools as unknown[]).push(additionalTool);
  }

  delete body.size;
  delete body.quality;
  delete body.moderation;
  delete body.output_format;
  delete body.output_compression;

  return body as ResponsesStreamRequestBody;
}
