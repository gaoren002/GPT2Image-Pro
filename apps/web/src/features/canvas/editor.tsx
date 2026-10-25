"use client";

/** 无限图片工作台：Excalidraw 提供画布交互，本模块接入本人作品、草稿保存与创作交接。 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  MainMenu,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { Button } from "@repo/ui/components/button";
import { Download, Images, Loader2, WandSparkles } from "lucide-react";
import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchCanvasImage } from "./image-import";
import { CanvasImageShelf } from "./image-shelf";
import { getCanvasExportElements, MAX_CANVAS_EXPORT_EDGE } from "./scene-tools";
import type { CanvasEditorProps, CanvasImageSource } from "./types";
import { useCanvasDocument } from "./use-canvas-document";

type EditorProps = CanvasEditorProps & {
  workspace: "images" | "whiteboard";
  incomingImage?: CanvasImageSource;
  onIncomingImageConsumed: () => void;
};

/** 下载浏览器生成的文件；及时回收对象地址，避免在长会话中累积图片内存。 */
function downloadBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "gpt2image-canvas.png";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 画布组件只在专属路由加载；异步导入均在离开或切换账号后中止。 */
export function CanvasEditor({
  userId,
  images,
  onRefreshImages,
  onContinueEditing,
  incomingImage,
  onIncomingImageConsumed,
  workspace,
}: EditorProps) {
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const documentState = useCanvasDocument(userId, workspace);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionCount, setSelectionCount] = useState(0);
  const importController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const consumedRef = useRef("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      importController.current?.abort();
    };
  }, []);

  /** 插入时重新读取当前场景，避免下载期间的拖动或新绘制内容被覆盖。 */
  const addImage = useCallback(
    async (image: CanvasImageSource) => {
      if (!api || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      importController.current = controller;
      try {
        const data = await fetchCanvasImage(image.url, controller.signal);
        if (!alive.current) return false;
        const state = api.getAppState();
        const fileId = crypto.randomUUID() as FileId;
        const [element] = convertToExcalidrawElements([
          {
            type: "image",
            fileId,
            x:
              -state.scrollX +
              state.width / (2 * state.zoom.value) -
              data.width / 2,
            y:
              -state.scrollY +
              state.height / (2 * state.zoom.value) -
              data.height / 2,
            width: data.width,
            height: data.height,
            status: "saved",
            customData: { generationId: image.id },
          },
        ]);
        if (!element) throw new Error("无法创建画布图片");
        api.addFiles([
          {
            id: fileId,
            dataURL: data.dataURL as DataURL,
            mimeType: data.mimeType as BinaryFileData["mimeType"],
            created: Date.now(),
            lastRetrieved: Date.now(),
          },
        ]);
        api.updateScene({
          elements: [...api.getSceneElements(), element],
          appState: { selectedElementIds: { [element.id]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        setShelfOpen(false);
        return true;
      } catch (failure) {
        if (!controller.signal.aborted && alive.current) {
          toast.error(
            failure instanceof Error ? failure.message : "图片导入失败"
          );
        }
        return false;
      } finally {
        busyRef.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [api]
  );

  useEffect(() => {
    if (
      !incomingImage ||
      !api ||
      !documentState.ready ||
      consumedRef.current === incomingImage.url
    )
      return;
    consumedRef.current = incomingImage.url;
    void addImage(incomingImage).then((imported) => {
      if (imported && alive.current) onIncomingImageConsumed();
    });
  }, [
    api,
    documentState.ready,
    incomingImage,
    addImage,
    onIncomingImageConsumed,
  ]);

  /** 合成选区或全图后交接到既有图生图页面，不在画布内另建扣费或上游调用。 */
  const exportImage = async (continueEditing: boolean) => {
    if (!api || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const state = api.getAppState();
      const blob = await exportToBlob({
        elements: getCanvasExportElements(
          api.getSceneElements(),
          state.selectedElementIds
        ),
        appState: {
          ...state,
          exportWithDarkMode: false,
          exportBackground: true,
        },
        files: api.getFiles(),
        maxWidthOrHeight: MAX_CANVAS_EXPORT_EDGE,
        mimeType: "image/png",
      });
      if (!alive.current) return;
      if (continueEditing) await onContinueEditing(blob);
      else downloadBlob(blob);
    } catch (failure) {
      if (alive.current)
        toast.error(
          failure instanceof Error ? failure.message : "画布导出失败"
        );
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  /** 刷新会重新按归属查询并签名，失败保留已有作品列表。 */
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshImages();
    } catch {
      if (alive.current) toast.error("刷新作品失败，请重试");
    } finally {
      if (alive.current) setRefreshing(false);
    }
  };

  if (!documentState.ready) {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      >
        {documentState.error ? (
          <>
            <p>{documentState.error}</p>
            <p>原草稿未被覆盖，请恢复浏览器存储权限后重试。</p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              重新加载
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            正在恢复画布
          </>
        )}
      </div>
    );
  }

  const saveLabel = {
    loading: "恢复中",
    saved: "已保存在此浏览器",
    saving: "正在保存",
    error: "保存失败",
  }[documentState.saveState];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant={shelfOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShelfOpen(!shelfOpen)}
        >
          <Images className="mr-1.5 h-4 w-4" />
          导入作品
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !api}
          onClick={() => void exportImage(false)}
        >
          <Download className="mr-1.5 h-4 w-4" />
          {selectionCount ? "导出选区" : "导出 PNG"}
        </Button>
        <Button
          size="sm"
          disabled={busy || !api}
          onClick={() => void exportImage(true)}
        >
          <WandSparkles className="mr-1.5 h-4 w-4" />
          {selectionCount ? "选区继续创作" : "整图继续创作"}
        </Button>
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {saveLabel}
        </span>
      </div>
      {documentState.error && (
        <div
          role="alert"
          className="flex items-center gap-3 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{documentState.error}。可先从画布菜单导出文件备份。</span>
          <Button size="sm" variant="outline" onClick={documentState.save}>
            重试保存
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={
            documentState.initialData ?? {
              appState: {
                viewBackgroundColor: "#ffffff",
                activeTool: {
                  type: workspace === "whiteboard" ? "freedraw" : "selection",
                  customType: null,
                  locked: false,
                  lastActiveTool: null,
                },
              },
            }
          }
          langCode={locale === "zh" ? "zh-CN" : "en"}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: { toggleTheme: false },
            tools: { image: true },
          }}
          onChange={(elements, appState: AppState, files) => {
            documentState.onChange(elements, appState, files);
            setSelectionCount(Object.keys(appState.selectedElementIds).length);
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
        {shelfOpen && (
          <CanvasImageShelf
            images={images}
            busy={busy}
            refreshing={refreshing}
            onAdd={(image) => void addImage(image)}
            onRefresh={() => void refresh()}
            onClose={() => setShelfOpen(false)}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>Ctrl / ⌘ + 滚轮缩放 · 空格拖动画布 · 双击添加文字</span>
        <span>
          草稿仅保存在此浏览器，按账号隔离。可从菜单导出画布文件备份。
        </span>
      </div>
    </div>
  );
}
