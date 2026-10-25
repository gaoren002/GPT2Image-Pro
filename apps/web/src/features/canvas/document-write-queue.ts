/** 画布 Tab 的进程内保存屏障；同账号同工作区重挂载时先等旧快照，其他文档互不阻塞。 */
const pendingWrites = new Map<string, Promise<void>>();
type Recovery = { scene: string; error: string };
const unsavedDrafts = new Map<string, Recovery>();

/** 未落盘的最后草稿保留在当前页面进程；切回 Tab 时可恢复并提示用户重试或导出。 */
export function getCanvasRecovery(
  userId: string,
  workspace: string
): Readonly<Recovery> | undefined {
  return unsavedDrafts.get(JSON.stringify([userId, workspace]));
}

/** 提交确认前保留快照，只有同一最新快照确认写入后才清理恢复副本。 */
export function enqueueCanvasSnapshot(
  userId: string,
  workspace: string,
  scene: string,
  write: (scene: string) => Promise<void>
) {
  const key = JSON.stringify([userId, workspace]);
  const draft = { scene, error: "画布尚未确认保存" };
  unsavedDrafts.set(key, draft);
  return enqueueCanvasWrite(userId, workspace, () => write(scene))
    .then(() => {
      if (unsavedDrafts.get(key) === draft) unsavedDrafts.delete(key);
    })
    .catch((failure: unknown) => {
      if (unsavedDrafts.get(key) === draft) {
        draft.error =
          failure instanceof Error ? failure.message : "画布保存失败";
      }
      throw failure;
    });
}

/** 捕获任务后按调用顺序保存；故障只影响对应调用，不阻断后续用户重试。 */
export function enqueueCanvasWrite(
  userId: string,
  workspace: string,
  write: () => Promise<void>
): Promise<void> {
  const key = JSON.stringify([userId, workspace]);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  pendingWrites.set(key, next);
  void next
    .finally(() => {
      if (pendingWrites.get(key) === next) pendingWrites.delete(key);
    })
    .catch(() => undefined);
  return next;
}

/** 新实例读取前等同文档的已排队保存；上次保存失败时仍读取最后成功的原草稿。 */
export async function waitForCanvasWrites(userId: string, workspace: string) {
  await pendingWrites
    .get(JSON.stringify([userId, workspace]))
    ?.catch(() => undefined);
}
