"use client";

/** Excalidraw 文档恢复与自动保存；故障时内存保留最新快照，切回仍能导出或重试。 */
import {
  getSceneVersion,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { readCanvasDocument, saveCanvasDocument } from "./document-storage";

type Snapshot = {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};
type RestoredScene = Awaited<ReturnType<typeof loadFromBlob>>;
type SaveState = "loading" | "saved" | "saving" | "error";

/** 账号与工作区由父组件 key 隔离；恢复失败时不会启动空白草稿覆盖已有数据。 */
export function useCanvasDocument(
  userId: string,
  workspace: "images" | "whiteboard"
) {
  const [initialData, setInitialData] = useState<RestoredScene | null>(null);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [error, setError] = useState("");
  const saveRef = useRef<() => void>(() => undefined);
  const changeRef = useRef<(snapshot: Snapshot) => void>(() => undefined);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: Snapshot | null = null;
    let lastFingerprint = "";
    let dirty = false;
    let revision = 0;

    /** 捕获当前快照后再排队；旧写入回调不能把更新的修改误标为已保存。 */
    const flush = () => {
      if (timer) clearTimeout(timer);
      if (!latest || !dirty) return;
      let serialized: string;
      try {
        serialized = serializeAsJSON(
          latest.elements,
          latest.appState,
          latest.files,
          "local"
        );
      } catch (failure) {
        if (mounted) {
          setSaveState("error");
          setError(failure instanceof Error ? failure.message : "画布保存失败");
        }
        return;
      }
      dirty = false;
      const savedRevision = revision;
      void saveCanvasDocument(userId, workspace, serialized)
        .then(() => {
          if (mounted && !dirty && savedRevision === revision) {
            setSaveState("saved");
            setError("");
          }
        })
        .catch((failure: unknown) => {
          if (savedRevision === revision) dirty = true;
          if (mounted) {
            setSaveState("error");
            setError(
              failure instanceof Error
                ? failure.message
                : "画布保存失败，请导出备份"
            );
          }
        });
    };
    saveRef.current = flush;
    changeRef.current = (snapshot) => {
      const state = snapshot.appState;
      const fingerprint = [
        getSceneVersion(snapshot.elements),
        state.scrollX,
        state.scrollY,
        state.zoom.value,
        state.viewBackgroundColor,
      ].join(":");
      latest = snapshot;
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      dirty = true;
      revision += 1;
      setSaveState("saving");
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 700);
    };

    void (async () => {
      try {
        const { scene, recoveryError } = await readCanvasDocument(
          userId,
          workspace
        );
        if (!mounted) return;
        const restored = scene
          ? await loadFromBlob(new Blob([scene]), null, null)
          : null;
        if (!mounted) return;
        setInitialData(restored);
        setReady(true);
        setSaveState(recoveryError ? "error" : "saved");
        if (recoveryError)
          setError(
            recoveryError +
              "；已恢复尚未保存的草稿，请重试保存或导出。恢复副本只在当前页面内存中，请勿刷新或关闭页面"
          );
      } catch (failure) {
        if (!mounted) return;
        setError(
          failure instanceof Error ? failure.message : "无法读取本机画布"
        );
        setSaveState("error");
      }
    })();
    /** 离开前尽力提交最后一份快照；持久化层负责跨挂载排序和释放句柄。 */
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
      flush();
      changeRef.current = () => undefined;
      saveRef.current = () => undefined;
    };
  }, [userId, workspace]);

  const onChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles
    ) => {
      changeRef.current({ elements, appState, files });
    },
    []
  );
  const save = useCallback(() => saveRef.current(), []);
  return { ready, initialData, saveState, error, onChange, save };
}
