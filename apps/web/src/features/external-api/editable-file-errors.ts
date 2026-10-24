/** 站内与v1文件生成共用的错误编码；确定的冲突、取消和待恢复状态不归为上游502。 */
import { toOpenAIErrorPayload } from "./images";

/** 文件编排的本地结算/重放错误保留稳定 code，避免被保活适配统一改写成上游错误。 */
export function toEditableFileErrorPayload(error: unknown, label = "File") {
  const message =
    error instanceof Error ? error.message : `${label} generation failed`;
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "editable_file_task_already_consumed") {
    return toOpenAIErrorPayload(message, {
      status: 409,
      type: "invalid_request_error",
      code,
    });
  }
  if (
    code === "editable_file_delivery_pending" ||
    code === "editable_file_refund_pending" ||
    code === "editable_file_quota_release_pending"
  ) {
    return toOpenAIErrorPayload(message, {
      status: 503,
      type: "server_error",
      code,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return toOpenAIErrorPayload(message, {
      status: 499,
      type: "invalid_request_error",
      code: "editable_file_cancelled",
    });
  }
  return toOpenAIErrorPayload(message);
}
