/** 站内可编辑文件重取入口；会话身份与本次尝试ID传入 UOL，结果重签、响应禁止缓存。 */
import { auth } from "@repo/shared/auth";
import { normalizeUserRole } from "@repo/shared/auth/roles";
import type { getEditableTask } from "@repo/shared/editable-task-lifecycle";
import { invokeOperation } from "@repo/shared/uol";
import type { NextRequest } from "next/server";

/** 查询本人无APIKey任务；不得把站内会话提升为某个APIKey的身份。 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const kind = request.nextUrl.searchParams.get("kind");
  if (!taskId || taskId.length > 200 || (kind !== "ppt" && kind !== "psd"))
    return Response.json(
      { error: "taskId and kind are required" },
      { status: 400 }
    );
  const task = await invokeOperation<
    Awaited<ReturnType<typeof getEditableTask>>
  >(
    "file.getTask",
    {
      taskId,
      kind,
    },
    {
      type: "user",
      userId: session.user.id,
      role: normalizeUserRole(session.user.role),
    }
  );
  if (task && request.headers.get("accept")?.includes("text/html")) {
    const statusText =
      task.status === "completed"
        ? "文件已生成，可以下载。"
        : task.status === "prepared" || task.status === "running"
          ? "任务正在处理，请稍后刷新此页。"
          : task.status === "refund_pending"
            ? "任务未完成，退款正在处理。"
            : task.status === "refunded"
              ? "任务未完成，已完成结算。"
              : "任务未执行，未扣费。";
    const primary = task.result
      ? `<p><a href="${escapeHtml(task.result.primaryUrl)}">下载 ${task.kind === "psd" ? "PSD" : "PPTX"}</a></p>`
      : "";
    const zip = task.result?.zipUrl
      ? `<p><a href="${escapeHtml(task.result.zipUrl)}">下载素材 ZIP</a></p>`
      : "";
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>文件任务</title><body><main><h1>文件任务</h1><p>${statusText}</p><p>本次净扣费：${task.creditsCharged}</p>${primary}${zip}</main></body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      }
    );
  }
  return Response.json(task ?? { error: "Task not found" }, {
    status: task ? 200 : 404,
    headers: { "Cache-Control": "no-store" },
  });
}

/** 任务结果URL只在HTML属性里输出，转义避免引号和实体改变页面结构。 */
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}
