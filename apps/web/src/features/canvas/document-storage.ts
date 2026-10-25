/** 本机画布读写边界：先恢复尚未落盘的内存稿，单次访问总会关闭 IDB 句柄。 */
import {
  enqueueCanvasSnapshot,
  getCanvasRecovery,
  waitForCanvasWrites,
} from "./document-write-queue";
import { openCanvasStorage } from "./persistence";

/** 存储暂时不可用时仍展示恢复稿，供导出；不把重新加载页面当作唯一恢复方式。 */
export async function readCanvasDocument(
  userId: string,
  workspace: "images" | "whiteboard"
) {
  await waitForCanvasWrites(userId, workspace);
  const recovery = getCanvasRecovery(userId, workspace);
  if (recovery) return { scene: recovery.scene, recoveryError: recovery.error };
  const storage = await openCanvasStorage(userId, workspace);
  try {
    return { scene: await storage.read(), recoveryError: "" };
  } finally {
    storage.close();
  }
}

/** 每次重试重新打开 IDB；配额或权限恢复后不必刷新页面丢弃未落盘修改。 */
export function saveCanvasDocument(
  userId: string,
  workspace: "images" | "whiteboard",
  scene: string
) {
  return enqueueCanvasSnapshot(userId, workspace, scene, async (snapshot) => {
    const storage = await openCanvasStorage(userId, workspace);
    try {
      await storage.write(snapshot);
    } finally {
      storage.close();
    }
  });
}
