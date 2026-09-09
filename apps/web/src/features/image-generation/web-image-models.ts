/**
 * 声明本地 ChatGPT Web 图像协议的模型边界，供调度与发送前校验共用；仅依赖纯模型解析。
 * 上游取证：basketikun/chatgpt2api dc105e51bd486bd75c8ef4f74be4bc4724bdfc33
 * 的 services/openai_backend_api.py 仍只用 picture_v2，尚无 2.5 版本选择字段。
 */
import { getImageModel } from "./resolution";

/**
 * 将输入与缺省模型按站内规则解析，保留 Web 后缀以外的版本信息；无网络与存储副作用。
 */
function normalizedWebImageModel(model?: string | null): string {
  return (getImageModel(model?.trim().toLowerCase()) || model || "")
    .trim()
    .toLowerCase()
    .replace(/\.web$/, "");
}

/**
 * 2.5 系列缺少可验证的 Web 版本选择协议，返回 false；其他输入保留既有路由行为。
 * 空值跟随站内默认图像模型，避免默认升级后仍静默派发旧 Web 请求。
 */
export function supportsWebImageModel(model?: string | null): boolean {
  const normalized = normalizedWebImageModel(model);
  return !(
    normalized === "gpt-image-2.5" || normalized.startsWith("gpt-image-2.5-")
  );
}

/**
 * 返回 Web 图像协议不兼容的明确错误；可派发时返回 null，不触发账号状态或请求副作用。
 */
export function unsupportedWebImageModelError(
  model?: string | null
): string | null {
  if (supportsWebImageModel(model)) return null;
  const requestedModel = normalizedWebImageModel(model);
  return (
    `WEB_IMAGE_MODEL_UNAVAILABLE: ChatGPT Web 暂无可验证的 ${requestedModel} 版本选择协议，` +
    "请使用支持该模型的 API / Codex 后端。"
  );
}
