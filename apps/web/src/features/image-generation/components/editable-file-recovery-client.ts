/** 可编辑文件提交/断连恢复：只凭会话与本次尝试ID查询，不重发生成请求、不保存输入内容。 */
import { readEditableFileResponse } from "./chat-input-images";

/** 页面把此地址持久写入本次assistant消息，刷新后仍可取得状态和已完成文件URL。 */
export function editableFileTaskQueryUrl(taskId: string, kind: "ppt" | "psd") {
  return `/api/editable-file/tasks/${encodeURIComponent(taskId)}?kind=${kind}`;
}

/**
 * 先处理上传引用确认；仅断连或生成响应错误时查询已存在任务。无完成态时保留原错误，
 * 同一次尝试绝不自动再POST，上游未知结果由服务端过期退款解决。
 */
export async function readRecoverableEditableFileResponse(
  submit: () => Promise<Response>,
  task: { taskId: string; kind: "ppt" | "psd" },
  receive: (payload: unknown) => void
): ReturnType<typeof readEditableFileResponse> {
  try {
    const response = await submit();
    const data = await readEditableFileResponse(response, receive);
    if (!response.ok || data.error)
      throw new Error(
        (typeof data.error === "string" ? data.error : data.error?.message) ||
          "File generation failed"
      );
    return data;
  } catch (original) {
    try {
      const response = await fetch(
        editableFileTaskQueryUrl(task.taskId, task.kind),
        { cache: "no-store" }
      );
      if (response.ok) {
        const taskResult: unknown = await response.json();
        if (
          taskResult &&
          typeof taskResult === "object" &&
          "status" in taskResult &&
          taskResult.status === "completed" &&
          "result" in taskResult &&
          taskResult.result &&
          typeof taskResult.result === "object" &&
          "primaryUrl" in taskResult.result &&
          typeof taskResult.result.primaryUrl === "string"
        ) {
          const zip =
            "zipUrl" in taskResult.result ? taskResult.result.zipUrl : null;
          return {
            result: {
              primary_url: taskResult.result.primaryUrl,
              zip_url: typeof zip === "string" ? zip : null,
            },
            ...("creditsCharged" in taskResult &&
            typeof taskResult.creditsCharged === "number"
              ? { credits_charged: taskResult.creditsCharged }
              : {}),
          };
        }
      }
    } catch {
      /* 查询失败保留原错误；任务与结果仍可从消息中的查询地址重取。 */
    }
    throw original;
  }
}
