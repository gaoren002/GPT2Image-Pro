"use client";

/** 工作流独占编辑、草稿恢复与串行保存；共享队列保留失败快照，Web Locks 防跨标签覆盖任务锁。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueueCanvasSnapshot,
  enqueueCanvasWrite,
  getCanvasRecovery,
  waitForCanvasWrites,
} from "./document-write-queue";
import { openCanvasStorage } from "./persistence";
import {
  createWorkflowDocument,
  loadWorkflowDocument,
  serializeWorkflowDocument,
  type WorkflowDocument,
} from "./workflow-model";
import {
  acquireWorkflowSessionLock,
  type WorkflowSessionLock,
} from "./workflow-session-lock";

/** 每账号按调用顺序执行已捕获快照；失败向调用者传播，同时允许后续保存继续执行。 */
export function enqueueWorkflowWrite(
  userId: string,
  write: () => Promise<void>
): Promise<void> {
  return enqueueCanvasWrite(userId, "workflow", write);
}

/** 新挂载读取前等待旧实例卸载 flush；不同账号之间不互相阻塞。 */
export async function waitForWorkflowWrites(userId: string): Promise<void> {
  await waitForCanvasWrites(userId, "workflow");
}

/** 捕获已序列化的工作流快照，交给同账号/工作区的共享保存队列。 */
export function enqueueWorkflowSnapshot(
  userId: string,
  scene: string,
  write: (scene: string) => Promise<void>
): Promise<void> {
  return enqueueCanvasSnapshot(userId, "workflow", scene, write);
}

/** 调用方先持有会话锁；重开优先恢复未落盘快照并标记 error，坏快照拒绝回退覆盖。 */
export async function restoreWorkflowDraft(
  userId: string,
  read: () => Promise<string | null>
): Promise<{
  document: WorkflowDocument;
  status: "saved" | "error";
  error: string;
}> {
  await waitForWorkflowWrites(userId);
  const recovery = getCanvasRecovery(userId, "workflow");
  const json = recovery ? recovery.scene : await read();
  return {
    document:
      json === null ? createWorkflowDocument() : loadWorkflowDocument(json),
    status: recovery ? "error" : "saved",
    error: recovery
      ? `${recovery.error}；已恢复尚未保存的工作流草稿，请重试保存或导出。恢复副本仅保留在当前页面进程，刷新或关闭页面可能丢失。`
      : "",
  };
}

type SaveStatus = "loading" | "saved" | "saving" | "error";
type DocumentSession = {
  update: (next: WorkflowDocument) => void;
  save: () => Promise<void>;
};

/**
 * 读取失败时保持锁定，不用空白图覆盖原草稿。update 同步更新 ref，save 可作为提交前落盘屏障。
 * 持有 Web Lock 后才恢复；内存恢复不依赖 IDB，读写各自打开并在 finally 关闭句柄。
 * 保存失败仍拒绝提交屏障；卸载等末次保存结束才释放独占锁。
 * 浏览器进程强制退出仍不能保证异步事务完成，内存恢复副本也不会跨进程保留。
 */
export function useWorkflowDocument(userId: string) {
  const [document, setDocument] = useState<WorkflowDocument | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const latest = useRef<WorkflowDocument | null>(null);
  const session = useRef<DocumentSession | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户显式重读失败草稿的会话重建编号。
  useEffect(() => {
    let mounted = true;
    let restored = false;
    let dirty = false;
    let revision = 0;
    const initialization = new AbortController();
    let sessionLock: WorkflowSessionLock | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued = Promise.resolve();
    latest.current = null;
    setDocument(null);
    setStatus("loading");
    setError("");

    /** 捕获当前快照再排队；只允许最新修订号更新保存提示，旧任务不会把新改动标为已保存。 */
    const save = (): Promise<void> => {
      if (timer) clearTimeout(timer);
      if (!restored || !sessionLock || !latest.current)
        return Promise.reject(new Error("工作流尚未恢复，不能保存或运行"));
      let json: string;
      try {
        json = serializeWorkflowDocument(latest.current);
      } catch (failure) {
        const message =
          failure instanceof Error ? failure.message : "工作流无法序列化";
        if (mounted) {
          setStatus("error");
          setError(message);
        }
        return Promise.reject(failure);
      }
      const savedRevision = revision;
      dirty = false;
      if (mounted) setStatus("saving");
      queued = enqueueWorkflowSnapshot(userId, json, async (scene) => {
        const target = await openCanvasStorage(userId, "workflow");
        try {
          await target.write(scene);
        } finally {
          target.close();
        }
      })
        .then(() => {
          if (mounted && revision === savedRevision && !dirty) {
            setStatus("saved");
            setError("");
          }
        })
        .catch((failure: unknown) => {
          if (revision === savedRevision) dirty = true;
          if (mounted) {
            setStatus("error");
            setError(
              failure instanceof Error
                ? failure.message
                : "本机草稿保存失败，请导出备份"
            );
          }
          throw failure;
        });
      return queued;
    };
    session.current = {
      /** 只接收已恢复会话的改动；内存保留 React Flow 的选中态，落盘时投影去除。 */
      update(next) {
        if (!mounted || !restored) throw new Error("工作流尚未恢复");
        latest.current = next;
        revision += 1;
        dirty = true;
        setDocument(next);
        setStatus("saving");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void save().catch(() => undefined);
        }, 650);
      },
      save,
    };

    void (async () => {
      try {
        const acquired = await acquireWorkflowSessionLock(
          userId,
          initialization.signal
        );
        if (!mounted) {
          await acquired.release();
          return;
        }
        sessionLock = acquired;
        const loaded = await restoreWorkflowDraft(userId, async () => {
          initialization.signal.throwIfAborted();
          const target = await openCanvasStorage(userId, "workflow");
          try {
            initialization.signal.throwIfAborted();
            return await target.read();
          } finally {
            target.close();
          }
        });
        if (!mounted) return;
        restored = true;
        dirty = loaded.status === "error";
        latest.current = loaded.document;
        setDocument(loaded.document);
        setStatus(loaded.status);
        setError(loaded.error);
      } catch (failure) {
        if (!mounted) return;
        setStatus("error");
        setError(
          failure instanceof Error ? failure.message : "无法恢复本机工作流"
        );
      }
    })();
    /** 隐藏页面时尽力落盘；离开浏览器时不能等待异步操作，因此任务号必须提交前保存。 */
    const flush = () => {
      if (dirty) void save().catch(() => undefined);
    };
    const onHidden = () => {
      if (globalThis.document.visibilityState === "hidden") flush();
    };
    globalThis.document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted = false;
      initialization.abort();
      session.current = null;
      globalThis.document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
      if (timer) clearTimeout(timer);
      flush();
      void queued
        .catch(() => undefined)
        .finally(async () => {
          await sessionLock?.release();
        });
    };
  }, [userId, reload]);

  /** 从同步 ref 读当前图，避免点击事件在 React 批处理期间使用过时快照。 */
  const current = useCallback(() => latest.current, []);
  /** 应用完整新图；恢复未完成时拒绝，调用者必须通过 ready 分支约束入口。 */
  const update = useCallback((next: WorkflowDocument) => {
    if (!session.current) throw new Error("工作流未就绪");
    session.current.update(next);
  }, []);
  /** 显式保存也用于付费提交屏障；不吞错误，让调用方阻止 POST。 */
  const save = useCallback(
    () => session.current?.save() ?? Promise.reject(new Error("工作流已离开")),
    []
  );
  /** 仅恢复失败页提供重读，不会重置或删除原草稿。 */
  const retry = useCallback(() => setReload((value) => value + 1), []);
  return { document, status, error, current, update, save, retry };
}
