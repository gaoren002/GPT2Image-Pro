/** 工作流持久化不变量：旧文档不能擦除已提交且结果未知的任务，零编辑器/校验库依赖。 */

/** 只收窄普通 JSON 对象，避免读取数组、null 或原型属性作为任务状态。 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读取 JSON 节点；完整工作流结构由 UI 模型校验，存储层只守住未知任务的不可丢失性。 */
function nodes(scene: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(scene);
  const document = record(value);
  if (document?.type !== "gpt2image-workflow" || !Array.isArray(document.nodes))
    throw new Error("工作流草稿格式无效");
  return document.nodes.map((node) => record(node) ?? {});
}

/**
 * 必须在同一个 IDB readwrite 事务里对旧值和新值调用。原未知任务只能保持原编号，
 * 或按同编号确认完成/用户已核对；自动保存、旧内存恢复及导入不能将它换成新任务。
 */
export function assertWorkflowAttemptTransition(
  previous: string,
  next: string
) {
  const nextNodes = nodes(next);
  for (const node of nodes(previous)) {
    const data = record(node.data);
    const attempt = record(data?.attempt);
    if (data?.kind !== "generate" || attempt?.state !== "unconfirmed") continue;
    const replacement = nextNodes.find((candidate) => candidate.id === node.id);
    const nextData = record(replacement?.data);
    const nextAttempt = record(nextData?.attempt);
    if (
      typeof node.id !== "string" ||
      typeof attempt.generationId !== "string" ||
      nextData?.kind !== "generate" ||
      nextAttempt?.generationId !== attempt.generationId ||
      typeof nextAttempt.state !== "string" ||
      !["unconfirmed", "completed", "acknowledged"].includes(nextAttempt.state)
    ) {
      throw new Error(
        "工作流已有未确认任务，不能用旧草稿覆盖。请先导出当前草稿，再重新打开工作流并核对历史任务"
      );
    }
  }
}
