// @vitest-environment jsdom
/** 真实 React hook 生命周期回归：多会话独占、StrictMode、异步取消、卸载 flush 与失败恢复。 */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCanvasRecovery } from "./document-write-queue";
import { executeWorkflowNode } from "./workflow-execution";
import {
  buildWorkflowRunPlan,
  createWorkflowDocument,
  serializeWorkflowDocument,
  type WorkflowDocument,
} from "./workflow-model";
import {
  enqueueWorkflowSnapshot,
  useWorkflowDocument,
} from "./workflow-storage";
import {
  createWorkflowTestLocks,
  workflowTestGate,
} from "./workflow-test-locks";

const storage = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn<() => Promise<string | null>>(),
  write: vi.fn<(scene: string) => Promise<void>>(),
  close: vi.fn(),
  scene: null as string | null,
}));
vi.mock("./persistence", () => ({ openCanvasStorage: storage.open }));

type View = { root: Root; host: HTMLDivElement; closed: boolean };
const outputs = new Map<string, ReturnType<typeof useWorkflowDocument>>();
let views: View[];
let gates: ReturnType<typeof workflowTestGate>[];
let fake: ReturnType<typeof createWorkflowTestLocks>;

/** 使用真实 Hook，通过 rerender 后的结果观察状态，不替换 React 的 effect/状态调度。 */
function Probe({ userId, slot }: { userId: string; slot: string }) {
  outputs.set(slot, useWorkflowDocument(userId));
  return null;
}
/** 读取最近一次真实渲染结果，缺少 Probe 时明确失败。 */
function output(slot: string) {
  const result = outputs.get(slot);
  if (!result) throw new Error(`缺少测试会话 ${slot}`);
  return result;
}
/** 建立未知付费任务快照；恢复后必须继续禁止重跑，不触发任何 HTTP 请求。 */
function unknownDraft(): WorkflowDocument {
  const document = createWorkflowDocument();
  const node = document.nodes[1];
  if (node?.data.kind !== "generate") throw new Error("缺少生成节点");
  node.data.attempt = {
    generationId: "5cd4d421-ff67-444d-8329-64385858c530",
    state: "unconfirmed",
    startedAt: "2026-10-25T01:00:00.000Z",
  };
  return document;
}
/** 手动异步屏障在 afterEach 兜底释放，测试失败也不把独占锁留给后续用例。 */
function gate() {
  const value = workflowTestGate();
  gates.push(value);
  return value;
}
/** 挂载独立 React root 模拟第二编辑会话；可选 StrictMode 使用 React 的真实 effect 重放。 */
async function mount(userId: string, slot: string, strict = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const view: View = { host, root: createRoot(host), closed: false };
  views.push(view);
  const probe = createElement(Probe, { userId, slot });
  await act(async () =>
    view.root.render(strict ? createElement(StrictMode, null, probe) : probe)
  );
  return view;
}
/** 只卸载指定 root；末次保存由 hook 启动，测试可继续控制其异步提交。 */
async function unmount(view: View) {
  if (view.closed) return;
  view.closed = true;
  await act(async () => view.root.unmount());
  view.host.remove();
}
/** 排空已可完成的 Promise 与 React 更新，不依赖时间延迟。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  outputs.clear();
  views = [];
  gates = [];
  fake = createWorkflowTestLocks();
  vi.stubGlobal("navigator", { locks: fake.manager });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage.scene = null;
  storage.read.mockReset().mockImplementation(async () => storage.scene);
  storage.write.mockReset().mockImplementation(async (scene) => {
    storage.scene = scene;
  });
  storage.close.mockReset();
  storage.open.mockReset().mockResolvedValue({
    read: storage.read,
    write: storage.write,
    close: storage.close,
  });
});
afterEach(async () => {
  for (const pending of gates) pending.release();
  for (const view of views) await unmount(view);
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("工作流编辑会话 hook", () => {
  it("IDB 持续无法打开时仍显示可导出的恢复稿，保存屏障失败禁止 POST，独占锁不能绕过", async () => {
    const userId = "hook-recovery-open-failure";
    const draft = unknownDraft();
    const scene = serializeWorkflowDocument(draft);
    await expect(
      enqueueWorkflowSnapshot(userId, scene, async () => {
        throw new Error("previous write failed");
      })
    ).rejects.toThrow();
    storage.open.mockRejectedValue(new Error("IndexedDB open blocked"));
    await mount(userId, "a");
    expect(output("a").document).toEqual(draft);
    expect(output("a").status).toBe("error");
    expect(output("a").error).toMatch(/尚未保存/);
    expect(storage.open).not.toHaveBeenCalled();
    expect(serializeWorkflowDocument(output("a").current())).toBe(scene);

    await act(async () => {
      await expect(output("a").save()).rejects.toThrow(/open blocked/);
    });
    const fetcher = vi.fn<typeof fetch>();
    const submitted = executeWorkflowNode({
      plan: {
        nodeId: "generate-start",
        prompt: "保存屏障测试",
        model: "gpt-image-2.5",
        size: "1024x1024",
        quality: "medium",
        images: [],
      },
      generationId: "38962509-9ae4-41c5-9ada-ddfd2d6824c7",
      signal: new AbortController().signal,
      beforeSubmit: () => output("a").save(),
      fetcher,
    });
    await act(async () => {
      await expect(submitted).rejects.toMatchObject({
        submitted: false,
        message: "IndexedDB open blocked",
      });
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(output("a").document).toEqual(draft);
    expect(output("a").status).toBe("error");
    expect(getCanvasRecovery(userId, "workflow")?.scene).toBe(scene);
    await mount(userId, "b");
    expect(output("b").document).toBeNull();
    expect(output("b").error).toMatch(/另一个标签页/);
    expect(storage.open).toHaveBeenCalledTimes(2);

    storage.open.mockResolvedValue({
      read: storage.read,
      write: storage.write,
      close: storage.close,
    });
    await act(async () => output("a").save());
    expect(output("a").status).toBe("saved");
    expect(storage.open).toHaveBeenCalledTimes(3);
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(getCanvasRecovery(userId, "workflow")).toBeUndefined();
  });
  it("双会话只允许一个读取/编辑；卸载后重开仍保留 unknown 任务锁", async () => {
    const first = await mount("hook-exclusive", "a");
    expect(output("a").status).toBe("saved");
    await mount("hook-exclusive", "b");
    expect(output("b")).toMatchObject({ document: null, status: "error" });
    expect(output("b").error).toMatch(/另一个标签页/);
    expect(() => output("b").update(createWorkflowDocument())).toThrow(
      /尚未恢复/
    );
    await expect(output("b").save()).rejects.toThrow(/尚未恢复/);
    expect(storage.open).toHaveBeenCalledTimes(1);
    await act(async () => {
      output("a").update(unknownDraft());
      await output("a").save();
    });
    await unmount(first);
    await act(async () => output("b").retry());
    expect(output("b").status).toBe("saved");
    expect(output("b").document).toEqual(unknownDraft());
    expect(() =>
      buildWorkflowRunPlan(
        output("b").current() ?? createWorkflowDocument(),
        "generate-start"
      )
    ).toThrow(/历史记录核对/);
  });
  it("浏览器原生拒绝时不读取 IDB，关闭占用后可以手动重试", async () => {
    fake.denyRequests(true);
    await mount("hook-native-denied", "a");
    expect(output("a").document).toBeNull();
    expect(output("a").error).toMatch(/另一个标签页/);
    expect(storage.open).not.toHaveBeenCalled();
    fake.denyRequests(false);
    await act(async () => output("a").retry());
    expect(output("a").status).toBe("saved");
    expect(storage.open).toHaveBeenCalledTimes(1);
  });
  it("没有 Web Locks 时保持只读失败，不打开或写入 IDB", async () => {
    vi.stubGlobal("navigator", {});
    await mount("hook-no-locks", "a");
    expect(output("a")).toMatchObject({ document: null, status: "error" });
    expect(output("a").error).toMatch(/不支持 Web Locks/);
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });
  it("StrictMode 旧 effect 取消后第二 effect 正常取得锁，不误报占用", async () => {
    await mount("hook-strict", "a", true);
    expect(output("a").status).toBe("saved");
    expect(output("a").error).toBe("");
    expect(fake.calls).toHaveLength(2);
    expect(storage.open).toHaveBeenCalledTimes(1);
    expect(storage.read).toHaveBeenCalledTimes(1);
  });
  it("异步打开数据库期间取消会释放锁，迟到的旧句柄关闭且不读取", async () => {
    const pending = gate();
    const old = { read: vi.fn(), write: vi.fn(), close: vi.fn() };
    storage.open.mockImplementationOnce(async () => {
      await pending.promise;
      return old;
    });
    const first = await mount("hook-cancel-open", "a");
    expect(output("a").status).toBe("loading");
    await unmount(first);
    await mount("hook-cancel-open", "b");
    expect(output("b").status).toBe("saved");
    pending.release();
    await settle();
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.read).not.toHaveBeenCalled();
    expect(fake.held.size).toBe(1);
  });
  it("末次保存未完成时重挂载等待旧锁，提交成功后才可读取最新任务", async () => {
    const pending = gate();
    const first = await mount("hook-pending-save", "a");
    storage.write.mockImplementationOnce(async (scene) => {
      await pending.promise;
      storage.scene = scene;
    });
    await act(async () => output("a").update(unknownDraft()));
    await unmount(first);
    await mount("hook-pending-save", "b");
    expect(output("b").status).toBe("loading");
    expect(storage.open).toHaveBeenCalledTimes(2);
    expect(fake.held.size).toBe(1);
    pending.release();
    await settle();
    expect(output("b").status).toBe("saved");
    expect(output("b").document).toEqual(unknownDraft());
    expect(storage.open).toHaveBeenCalledTimes(3);
  });
  it("卸载后写入失败仍恢复最新草稿并报 error，手动保存成功才清除恢复副本", async () => {
    const userId = "hook-save-failure";
    const pending = gate();
    const first = await mount(userId, "a");
    storage.write.mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("QuotaExceededError");
    });
    await act(async () => output("a").update(unknownDraft()));
    await unmount(first);
    await mount(userId, "b");
    expect(output("b").status).toBe("loading");
    pending.release();
    await settle();
    expect(output("b").document).toEqual(unknownDraft());
    expect(output("b").status).toBe("error");
    expect(output("b").error).toMatch(/QuotaExceededError.*尚未保存/);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(getCanvasRecovery(userId, "workflow")).toBeDefined();
    await act(async () => output("b").save());
    expect(output("b").status).toBe("saved");
    expect(output("b").error).toBe("");
    expect(getCanvasRecovery(userId, "workflow")).toBeUndefined();
  });
  it("卸载移除 visibilitychange 和 pagehide 监听器", async () => {
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const view = await mount("hook-listeners", "a");
    const hidden = addDocument.mock.calls.find(
      ([name]) => name === "visibilitychange"
    )?.[1];
    const hide = addWindow.mock.calls.find(
      ([name]) => name === "pagehide"
    )?.[1];
    await unmount(view);
    expect(hidden).toBeDefined();
    expect(hide).toBeDefined();
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", hidden);
    expect(removeWindow).toHaveBeenCalledWith("pagehide", hide);
  });
});
