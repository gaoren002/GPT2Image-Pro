/** 可编辑文件任务的纯契约：请求只留 SHA256，持久结果仅含对象引用；由服务与传输共用。 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const editableResultReferencesSchema = z.object({
  conversationId: z.string().max(512),
  primary: z.object({ key: z.string().min(1), bucket: z.string().min(1) }),
  zip: z
    .object({ key: z.string().min(1), bucket: z.string().min(1) })
    .nullable(),
});
export type EditableResultReferences = z.infer<
  typeof editableResultReferencesSchema
>;
export type EditableTaskIdentity = {
  userId: string;
  apiKeyId?: string | undefined;
  kind: "ppt" | "psd";
  taskId: string;
  requestFingerprint: string;
};
export type EditableTaskClaim = { taskId: string; claimToken: string };

/** 生成原 d82980fb 的财务键；taskId 不落库，避免用户把内容塞进自定义 ID。 */
export function editableTaskId(userId: string, kind: string, taskId: string) {
  return `editable-file:${createHash("sha256")
    .update(JSON.stringify([userId, kind, taskId.trim()]))
    .digest("hex")}`;
}

/** 内容哈希带顺序/类型/轮次计费意图，价格变更不改变同一请求的身份；不保存原始输入。 */
export function editableRequestFingerprint(input: {
  kind: "ppt" | "psd";
  prompt: string;
  base64Images: string[];
  chatRound?: boolean;
}) {
  const images = input.base64Images.map((image) =>
    createHash("sha256")
      .update(
        Buffer.from(
          image
            .trim()
            .replace(/^data:[^,]*,/, "")
            .replace(/\s/g, ""),
          "base64"
        )
      )
      .digest("hex")
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        input.kind,
        input.prompt,
        images,
        input.chatRound === true,
      ])
    )
    .digest("hex");
}

/** 稳定冲突码；不能把其他 Key/不同指纹的结果作为合法重放返回。 */
export class EditableFileTaskAlreadyConsumedError extends Error {
  readonly code = "editable_file_task_already_consumed";
  readonly status = 409;
  constructor() {
    super(
      "Editable file task ID is already in use. Query the original task or start a new task."
    );
    this.name = "EditableFileTaskAlreadyConsumedError";
  }
}

/** 可重取结果/待退款的固定错误，禁止附带上游异常、prompt、URL 或凭据。 */
export class EditableTaskPendingError extends Error {
  readonly status = 503;
  constructor(
    readonly code:
      | "editable_file_delivery_pending"
      | "editable_file_refund_pending"
  ) {
    super(
      "Editable file task is recoverable. Query this task ID for its current state."
    );
    this.name = "EditableTaskPendingError";
  }
}
