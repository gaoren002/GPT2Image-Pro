"use client";

/** 画布的近期作品抽屉；只展示本人图片，导入与刷新均提供明确的等待反馈。 */
import { Button } from "@repo/ui/components/button";
import { Loader2, RefreshCw, X } from "lucide-react";
import Image from "next/image";
import type { CanvasImageSource } from "./types";

/** 素材入口保持可见；窄屏使用同一可关闭的绝对定位面板。 */
export function CanvasImageShelf({
  images,
  busy,
  refreshing,
  onAdd,
  onRefresh,
  onClose,
}: {
  images: CanvasImageSource[];
  busy: boolean;
  refreshing: boolean;
  onAdd: (image: CanvasImageSource) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="近期作品"
      className="absolute inset-y-2 left-2 z-20 flex w-64 max-w-[calc(100%-16px)] flex-col rounded-lg border bg-background shadow-lg"
    >
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm font-medium">近期作品</span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={refreshing || busy}
            aria-label="刷新作品列表"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="关闭作品列表"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="px-3 pt-3 text-xs text-muted-foreground">
        点击加入画布，拖动图片调整位置。
      </p>
      <div className="grid grid-cols-2 gap-2 overflow-y-auto p-3">
        {images.map((image) => (
          <button
            key={image.id}
            type="button"
            disabled={busy}
            onClick={() => onAdd(image)}
            title={image.prompt}
            className="group relative aspect-square overflow-hidden rounded-md border bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
          >
            {/* 本站签名缩略图直接加载，避免 Next 优化器丢失私有请求上下文。 */}
            <Image
              src={image.thumbnailUrl}
              alt={image.prompt.slice(0, 80) || "生成图片"}
              fill
              unoptimized
              sizes="112px"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          </button>
        ))}
      </div>
      {!images.length && (
        <p className="p-4 text-sm text-muted-foreground">
          还没有生成作品。也可以使用画布工具栏的图片按钮导入本机图片。
        </p>
      )}
      {busy && (
        <div
          role="status"
          className="flex items-center gap-2 border-t p-3 text-xs"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          正在导入图片
        </div>
      )}
    </aside>
  );
}
