/** 可编辑文件任务查询/到期恢复 UOL；身份仅来自 principal，结果始终重签。 */
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation } from "../registry";

export const editableTaskQuerySchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  kind: z.enum(["ppt", "psd"]).optional(),
});
export type EditableTaskQuery = z.infer<typeof editableTaskQuerySchema>;

export const getEditableFileTask = defineOperation({
  name: "file.getTask",
  domain: "image-generation",
  title: "查询可编辑文件任务",
  description:
    "按原用户和API Key查询持久轮询ID并重签结果；站内可用kind与本次尝试ID恢复。",
  input: editableTaskQuerySchema,
  output: z
    .object({
      taskId: z.string(),
      kind: z.enum(["ppt", "psd"]),
      status: z.string(),
      requestFingerprint: z.string(),
      creditsCharged: z.number(),
      result: z
        .object({
          conversationId: z.string(),
          primaryUrl: z.string(),
          zipUrl: z.string().nullable(),
          creditsCharged: z.number(),
        })
        .nullable(),
    })
    .nullable(),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  /** 不能接受 body 中的 userId/apiKeyId；撤销 Key 由传输认证入口先拒绝。 */
  execute: async (input, principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey")
      throw new OperationError("forbidden", "User identity required");
    const { getEditableTaskByPublicId, getSessionEditableTask } = await import(
      "../../editable-task-lifecycle"
    );
    if (principal.type === "user" && input.kind)
      return getSessionEditableTask({
        userId: principal.userId,
        taskId: input.taskId,
        kind: input.kind,
      });
    return getEditableTaskByPublicId({
      userId: principal.userId,
      apiKeyId: principal.type === "apiKey" ? principal.apiKeyId : undefined,
      publicId: input.taskId,
    });
  },
});

export const recoverEditableFileTasks = defineOperation({
  name: "file.recoverTasks",
  domain: "image-generation",
  title: "恢复可编辑文件任务结算",
  description: "有界扫描过期任务并投递既有退款 outbox；不恢复或重发上游请求。",
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ scanned: z.number(), recovered: z.number() }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  /** cron/system 入口复用同一扫描，不依赖任何进程内任务缓存。 */
  execute: async (input) => {
    const { recoverEditableTasks } = await import(
      "../../editable-task-lifecycle"
    );
    return recoverEditableTasks(input.limit);
  },
});
