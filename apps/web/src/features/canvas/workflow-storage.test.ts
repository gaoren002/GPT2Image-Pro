/** 草稿写队列回归：同账号严格顺序、跨账号隔离、重开前屏障与写失败后的恢复。 */
import { describe, expect, it, vi } from "vitest";
import { getCanvasRecovery } from "./document-write-queue";
import {
  createWorkflowDocument,
  serializeWorkflowDocument,
} from "./workflow-model";
import {
  enqueueWorkflowSnapshot,
  enqueueWorkflowWrite,
  restoreWorkflowDraft,
  waitForWorkflowWrites,
} from "./workflow-storage";

/** 可控异步屏障，模拟慢 IDB 提交，不依赖时间延迟或真实磁盘。 */
function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("工作流串行保存", () => {
  it("旧快照完成后才能写新快照，新挂载读取等待末次 flush", async () => {
    const gate = deferred();
    const events: string[] = [];
    let stored = "";
    const old = enqueueWorkflowWrite("queue-order", async () => {
      events.push("old-start");
      await gate.promise;
      stored = "old";
      events.push("old-complete");
    });
    const latest = enqueueWorkflowWrite("queue-order", async () => {
      stored = "latest";
      events.push("latest-complete");
    });
    const read = waitForWorkflowWrites("queue-order").then(() => {
      events.push(`read:${stored}`);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["old-start"]);
    gate.release();
    await Promise.all([old, latest, read]);
    expect(events).toEqual([
      "old-start",
      "old-complete",
      "latest-complete",
      "read:latest",
    ]);
  });
  it("不同账号不会被另一个账号的未完成保存阻塞", async () => {
    const gate = deferred();
    let firstDone = false;
    const first = enqueueWorkflowWrite("account-a", async () => {
      await gate.promise;
      firstDone = true;
    });
    await enqueueWorkflowWrite("account-b", async () => undefined);
    expect(firstDone).toBe(false);
    await waitForWorkflowWrites("account-b");
    gate.release();
    await first;
  });
  it("保存失败显式拒绝，后续快照仍可提交且读取屏障不死锁", async () => {
    const failed = enqueueWorkflowWrite("queue-recover", async () => {
      throw new Error("quota");
    });
    const values: string[] = [];
    const next = enqueueWorkflowWrite("queue-recover", async () => {
      values.push("recovered");
    });
    await expect(failed).rejects.toThrow("quota");
    await next;
    await waitForWorkflowWrites("queue-recover");
    expect(values).toEqual(["recovered"]);
  });
});

describe("工作流卸载失败后的恢复", () => {
  it("末次保存失败后重开恢复最新任务编号，不能读取旧 IDB 并误报 saved", async () => {
    const userId = "workflow-unmount-failure";
    const oldScene = serializeWorkflowDocument(createWorkflowDocument());
    const latest = createWorkflowDocument();
    const node = latest.nodes[1];
    if (node?.data.kind !== "generate") throw new Error("缺少生成节点");
    node.data.attempt = {
      generationId: "5cd4d421-ff67-444d-8329-64385858c530",
      state: "unconfirmed",
      startedAt: "2026-10-25T01:00:00.000Z",
    };
    const latestScene = serializeWorkflowDocument(latest);
    const gate = deferred();
    let persisted = oldScene;
    const saving = enqueueWorkflowSnapshot(userId, latestScene, async () => {
      await gate.promise;
      throw new Error("QuotaExceededError");
    });
    const failed = expect(saving).rejects.toThrow("QuotaExceededError");
    const read = vi.fn(async () => persisted);
    const reopening = restoreWorkflowDraft(userId, read);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    gate.release();
    await failed;
    const restored = await reopening;
    expect(persisted).toBe(oldScene);
    expect(restored.document).toEqual(latest);
    expect(restored.status).toBe("error");
    expect(restored.error).toMatch(/尚未保存/);
    expect(read).not.toHaveBeenCalled();
    expect(getCanvasRecovery(userId, "workflow")?.scene).toBe(latestScene);

    await enqueueWorkflowSnapshot(userId, latestScene, async (scene) => {
      persisted = scene;
    });
    expect(getCanvasRecovery(userId, "workflow")).toBeUndefined();
    expect(await restoreWorkflowDraft(userId, read)).toMatchObject({
      document: latest,
      status: "saved",
      error: "",
    });
  });
  it("旧快照成功不能清理新的失败快照，重开必须恢复最新修订", async () => {
    const userId = "workflow-newer-recovery";
    const oldScene = serializeWorkflowDocument(createWorkflowDocument());
    const latest = createWorkflowDocument();
    latest.viewport = { x: 80, y: 20, zoom: 0.5 };
    const latestScene = serializeWorkflowDocument(latest);
    const gate = deferred();
    const first = enqueueWorkflowSnapshot(userId, oldScene, () => gate.promise);
    const second = enqueueWorkflowSnapshot(userId, latestScene, async () => {
      throw new Error("latest write failed");
    });
    const checked = expect(second).rejects.toThrow("latest write failed");
    gate.release();
    await first;
    await checked;
    expect(getCanvasRecovery(userId, "workflow")?.scene).toBe(latestScene);
    expect(
      await restoreWorkflowDraft(userId, async () => oldScene)
    ).toMatchObject({ document: latest, status: "error" });
    await enqueueWorkflowSnapshot(userId, latestScene, async () => undefined);
  });
  it("有效内存快照可越过损坏的 IDB，恢复副本仍使用同样的 JSON 校验", async () => {
    const userId = "workflow-invalid-disk";
    const scene = serializeWorkflowDocument(createWorkflowDocument());
    await expect(
      enqueueWorkflowSnapshot(userId, scene, async () => {
        throw new Error("disk unavailable");
      })
    ).rejects.toThrow();
    const read = vi.fn(async () => {
      throw new Error("bad disk");
    });
    expect(await restoreWorkflowDraft(userId, read)).toMatchObject({
      status: "error",
      document: createWorkflowDocument(),
    });
    expect(read).not.toHaveBeenCalled();
    await expect(
      enqueueWorkflowSnapshot(userId, "broken JSON", async () => {
        throw new Error("bad recovery");
      })
    ).rejects.toThrow();
    await expect(
      restoreWorkflowDraft(userId, async () => scene)
    ).rejects.toThrow(/JSON/);
    expect(getCanvasRecovery(userId, "workflow")?.scene).toBe("broken JSON");
    await enqueueWorkflowSnapshot(userId, scene, async () => undefined);
  });
});
