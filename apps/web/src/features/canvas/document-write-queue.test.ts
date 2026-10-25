/** 延迟写入、重挂载读取和故障重试的竞态回归，不依赖 React 或浏览器数据库。 */
import { describe, expect, it } from "vitest";
import {
  enqueueCanvasSnapshot,
  enqueueCanvasWrite,
  getCanvasRecovery,
  waitForCanvasWrites,
} from "./document-write-queue";

describe("画布保存屏障", () => {
  it("卸载后的失败仍保留最新草稿，重开不能误当作已保存", async () => {
    await expect(
      enqueueCanvasSnapshot("unsaved", "images", "v2", async () => {
        throw new Error("QuotaExceededError");
      })
    ).rejects.toThrow("QuotaExceededError");
    await waitForCanvasWrites("unsaved", "images");
    expect(getCanvasRecovery("unsaved", "images")).toEqual({
      scene: "v2",
      error: "QuotaExceededError",
    });
    expect(getCanvasRecovery("unsaved", "whiteboard")).toBeUndefined();
    expect(getCanvasRecovery("another", "images")).toBeUndefined();
    await enqueueCanvasSnapshot(
      "unsaved",
      "images",
      "v2",
      async () => undefined
    );
    expect(getCanvasRecovery("unsaved", "images")).toBeUndefined();
  });
  it("旧保存失败不能覆盖更新的恢复快照", async () => {
    let rejectOld: (error: Error) => void = () => undefined;
    const oldWrite = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    const first = enqueueCanvasSnapshot(
      "revisions",
      "images",
      "v1",
      () => oldWrite
    );
    const firstChecked = expect(first).rejects.toThrow("old failure");
    const second = enqueueCanvasSnapshot(
      "revisions",
      "images",
      "v2",
      async () => {
        throw new Error("new failure");
      }
    );
    const secondChecked = expect(second).rejects.toThrow("new failure");
    await Promise.resolve();
    rejectOld(new Error("old failure"));
    await Promise.all([firstChecked, secondChecked]);
    expect(getCanvasRecovery("revisions", "images")).toEqual({
      scene: "v2",
      error: "new failure",
    });
  });
  it("重开同一文档必须等之前的快照落盘", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = enqueueCanvasWrite("same-account", "images", async () => {
      await gate;
      order.push("old saved");
    });
    const reopening = waitForCanvasWrites("same-account", "images").then(() =>
      order.push("read")
    );
    const next = enqueueCanvasWrite("same-account", "images", async () => {
      order.push("new saved");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, reopening, next]);
    expect(order[0]).toBe("old saved");
    expect(order.indexOf("old saved")).toBeLessThan(order.indexOf("new saved"));
    expect(order.indexOf("old saved")).toBeLessThan(order.indexOf("read"));
  });
  it("账号和 Tab 不共享等待队列", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = enqueueCanvasWrite("a", "images", () => gate);
    let completed = 0;
    await Promise.all([
      enqueueCanvasWrite("b", "images", async () => {
        completed += 1;
      }),
      enqueueCanvasWrite("a", "whiteboard", async () => {
        completed += 1;
      }),
    ]);
    expect(completed).toBe(2);
    release();
    await blocked;
  });
  it("失败向调用方传播，但不阻止下一次保存和恢复", async () => {
    await expect(
      enqueueCanvasWrite("fault", "images", async () => {
        throw new Error("disk full");
      })
    ).rejects.toThrow("disk full");
    let saved = false;
    await enqueueCanvasWrite("fault", "images", async () => {
      saved = true;
    });
    await waitForCanvasWrites("fault", "images");
    expect(saved).toBe(true);
  });
});
