"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  Download,
  ImagePlus,
  MousePointerClick,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageCard } from "@/features/image-generation/components/image-card";
import { batchDeleteGenerationAction } from "@/features/image-generation/actions";
import { generateDownloadFilename } from "@/lib/download-filename";
import dynamic from "next/dynamic";
import type {
  LightboxReferenceImage,
  LightboxGeneration,
} from "@/features/image-generation/components/image-lightbox";

// 懒加载:lightbox 仅在点开某张图时才需要,改 next/dynamic 后从图库首屏 bundle 移出。
const ImageLightbox = dynamic(
  () =>
    import("@/features/image-generation/components/image-lightbox").then(
      (m) => m.ImageLightbox
    ),
  { ssr: false }
);

export interface GenerationWithUrl {
  id: string;
  parentId?: string;
  prompt: string;
  revisedPrompt: string | null;
  promptRepairNotice?: string | null;
  model: string;
  size: string;
  creditsConsumed: number;
  status: "pending" | "completed" | "failed";
  createdAt: string;
  storageKey: string | null;
  storageBucket: string | null;
  imageUrl: string | null;
  // 视频项(视频 tab)：产物 mp4 的签名 URL;imageUrl 为空,渲染 <video> 而非 <img>。
  videoUrl?: string | null;
  outputRole?: "final" | "agent_draft" | "upload" | "video";
  referenceImages?: LightboxReferenceImage[];
  isLayered?: boolean;
}

export interface GalleryClientProps {
  initialGenerations: GenerationWithUrl[];
  totalCount: number;
  finalCount: number;
  draftCount: number;
  uploadCount: number;
  videoCount: number;
  activeTab: "final" | "agent-drafts" | "uploads" | "videos";
  page: number;
  timeZone: string;
}

export function GalleryClient({
  initialGenerations,
  totalCount,
  finalCount,
  draftCount,
  uploadCount,
  videoCount,
  activeTab,
  page,
  timeZone,
}: GalleryClientProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [items, setItems] = useState<GenerationWithUrl[]>(initialGenerations);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // -- 多选模式状态 --
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set()
  );
  /** 记录上一次点选的索引,用于 Shift 范围选择 */
  const lastSelectedIndexRef = useRef<number>(-1);
  /** 批量删除二次确认:第一次点击设为 true,第二次才真正执行 */
  const [confirmBatchDelete, setConfirmBatchDelete] =
    useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const hasMore = items.length < totalCount;

  // -- 多选模式:退出时清空选中集 --
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmBatchDelete(false);
    lastSelectedIndexRef.current = -1;
  }, []);

  // -- 多选模式:切换单个 item 的选中状态,支持 Shift 范围选 --
  const handleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      const currentIndex = items.findIndex((i) => i.id === id);

      setSelectedIds((prev) => {
        const next = new Set(prev);

        // Shift+点击:选中上次与本次之间的所有项
        if (
          event?.shiftKey &&
          lastSelectedIndexRef.current >= 0 &&
          lastSelectedIndexRef.current !== currentIndex
        ) {
          const start = Math.min(
            lastSelectedIndexRef.current,
            currentIndex
          );
          const end = Math.max(
            lastSelectedIndexRef.current,
            currentIndex
          );
          for (let i = start; i <= end; i++) {
            const item = items[i];
            if (item) next.add(item.id);
          }
        } else {
          // 普通点击 / Ctrl+点击:切换单项
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
        }

        return next;
      });

      lastSelectedIndexRef.current = currentIndex;
      // 重置删除二次确认
      setConfirmBatchDelete(false);
    },
    [items]
  );

  // -- 批量下载:依次创建临时 <a> 触发下载,间隔 100ms 避免浏览器拦截 --
  const handleBatchDownload = useCallback(() => {
    const toDownload = items.filter(
      (i) => selectedIds.has(i.id) && i.imageUrl
    );
    if (toDownload.length === 0) return;
    for (let idx = 0; idx < toDownload.length; idx++) {
      const item = toDownload[idx];
      if (!item?.imageUrl) continue;
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.imageUrl as string;
        a.download = generateDownloadFilename(item.prompt, item.createdAt);
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, idx * 100);
    }
    toast.success(
      copy(
        `Downloading ${toDownload.length} images`,
        `正在下载 ${toDownload.length} 张图片`
      )
    );
  }, [items, selectedIds, copy]);

  // -- 批量删除 --
  const handleBatchDelete = useCallback(async () => {
    if (!confirmBatchDelete) {
      setConfirmBatchDelete(true);
      return;
    }
    setBatchDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const result = await batchDeleteGenerationAction({
        generationIds: ids,
      });
      if (result?.data?.success) {
        const count = result.data.deletedCount ?? ids.length;
        setItems((prev) =>
          prev.filter((i) => !selectedIds.has(i.id))
        );
        setSelectedIds(new Set());
        setConfirmBatchDelete(false);
        toast.success(
          copy(
            `Deleted ${count} images`,
            `已删除 ${count} 张图片`
          )
        );
      } else {
        const msg =
          result?.serverError ||
          copy("Failed to delete", "删除失败");
        toast.error(
          typeof msg === "string"
            ? msg
            : copy("Failed to delete", "删除失败")
        );
      }
    } catch {
      toast.error(
        copy("Failed to delete", "删除失败")
      );
    } finally {
      setBatchDeleting(false);
    }
  }, [confirmBatchDelete, selectedIds, copy]);

  // -- 全选 / 取消全选 --
  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
    setConfirmBatchDelete(false);
  }, [items, selectedIds.size]);

  const createHref = `/${locale}/dashboard/create`;
  const galleryHref = (tab: GalleryClientProps["activeTab"], nextPage = 1) =>
    `/${locale}/dashboard/gallery?tab=${tab}&page=${nextPage}`;
  const nextPageHref = galleryHref(activeTab, page + 1);
  // 激活徽标用 primary 反差点缀:Tabs 激活态已是柔和灰底(bg-secondary),
  // 旧的 bg-primary-foreground(白底)在灰底上几乎不可见。
  const countBadgeClass = (active: boolean) =>
    [
      "ml-2 rounded-full px-1.5 py-0 text-[10px] font-normal transition-colors duration-150",
      active
        ? "border-transparent bg-primary text-primary-foreground"
        : "border-border text-muted-foreground",
    ].join(" ");

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  const tabs = (
    <div className="flex items-center gap-3">
      <Tabs value={activeTab} className="flex-1">
        <TabsList className="h-auto flex-wrap justify-start border border-border bg-muted/40">
          <TabsTrigger value="final" asChild>
            <Link href={galleryHref("final")} scroll={false}>
              {copy("Final images", "成品")}
              <Badge
                variant="outline"
                className={countBadgeClass(
                  activeTab === "final"
                )}
              >
                {finalCount}
              </Badge>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="agent-drafts" asChild>
            <Link
              href={galleryHref("agent-drafts")}
              scroll={false}
            >
              {copy("Agent drafts", "Agent 中间图")}
              <Badge
                variant="outline"
                className={countBadgeClass(
                  activeTab === "agent-drafts"
                )}
              >
                {draftCount}
              </Badge>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="uploads" asChild>
            <Link
              href={galleryHref("uploads")}
              scroll={false}
            >
              {copy("User uploads", "用户上传图")}
              <Badge
                variant="outline"
                className={countBadgeClass(
                  activeTab === "uploads"
                )}
              >
                {uploadCount}
              </Badge>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="videos" asChild>
            <Link href={galleryHref("videos")} scroll={false}>
              {copy("Videos", "视频")}
              <Badge
                variant="outline"
                className={countBadgeClass(activeTab === "videos")}
              >
                {videoCount}
              </Badge>
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* 多选模式切换按钮(批量选择/下载是图片专用,视频 tab 隐藏) */}
      {activeTab !== "videos" && (
        <Button
          variant={selectMode ? "secondary" : "outline"}
          size="sm"
          onClick={
            selectMode ? exitSelectMode : () => setSelectMode(true)
          }
          className="shrink-0"
        >
          {selectMode ? (
            <>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {copy("Cancel", "取消")}
            </>
          ) : (
            <>
              <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
              {copy("Select", "选择")}
            </>
          )}
        </Button>
      )}
    </div>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-5">
        {tabs}
        <div className="flex animate-in fade-in flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-6 py-24 text-center duration-400 motion-reduce:animate-none">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <ImagePlus
              className="h-7 w-7 text-muted-foreground"
              strokeWidth={1.2}
            />
          </div>
          <h3 className="mt-5 font-serif text-lg font-medium text-foreground">
            {activeTab === "agent-drafts"
              ? copy("No Agent drafts yet", "还没有 Agent 中间图")
              : activeTab === "uploads"
                ? copy("No user uploads yet", "还没有用户上传图")
                : activeTab === "videos"
                  ? copy("No videos yet", "还没有视频")
                  : copy("No images yet", "还没有图片")}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {activeTab === "agent-drafts"
              ? copy(
                  "Intermediate images from Agent iterations will appear here.",
                  "Agent 自动迭代产生的中间图会显示在这里。"
                )
              : activeTab === "uploads"
                ? copy(
                    "Reference images uploaded for image edits and chats will appear here.",
                    "图生图和 Chat 上传的参考图会显示在这里。"
                  )
                : activeTab === "videos"
                  ? copy(
                      "Videos you generate will appear here. Create one in the Video tab on the create page.",
                      "你生成的视频会显示在这里。在创作页的「视频」tab 里生成。"
                    )
                  : copy(
                      "Your generated images will appear here. Start by creating your first one.",
                      "你生成的图片会显示在这里。先创建第一张图片吧。"
                    )}
          </p>
          <Button asChild variant="outline" className="mt-8">
            <Link href={createHref}>{copy("Create an image", "创建图片")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-5">{tabs}</div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {items.map((item, index) =>
          item.outputRole === "video" ? (
            // 视频项:直接内联 <video>(preload=metadata 显示首帧,点 controls 播放),
            // 不参与多选/批量下载(那套是图片专用)。卡片手感与 ImageCard 统一;
            // 尺寸徽标常显于左上(hover 遮罩会挡住 video controls,故不做遮罩)。
            <div
              key={item.id}
              className="group animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-lg border border-border bg-background lift-hover motion-reduce:animate-none motion-reduce:transition-none"
              // 入场错峰:按网格索引 50ms 递增(12 个一轮回),fill-mode 用 backwards
              // 保证延迟期间停留在动画首帧(透明),避免"先显示再闪回透明"的跳变。
              // 入场时长走内联长属性(400ms),不影响 hover 过渡的 duration-250。
              style={{
                animationDelay: `${(index % 12) * 50}ms`,
                animationDuration: "400ms",
                animationFillMode: "backwards",
              }}
            >
              <div className="relative">
                {item.videoUrl ? (
                  <video
                    src={item.videoUrl}
                    controls
                    preload="metadata"
                    className="aspect-square w-full bg-black object-contain"
                  >
                    <track kind="captions" />
                  </video>
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-muted text-xs text-muted-foreground">
                    {copy("Video unavailable", "视频不可用")}
                  </div>
                )}
                {item.videoUrl && (
                  <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-[5px] bg-black/55 px-2 py-0.5 text-xs text-white/70 backdrop-blur-sm">
                    {item.size}
                  </span>
                )}
              </div>
              <div className="space-y-2 p-3">
                <p className="line-clamp-2 text-sm leading-snug text-foreground">
                  {item.prompt}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {item.model}
                </p>
              </div>
            </div>
          ) : (
            // 入场错峰:与视频卡同一节奏。fill-mode backwards 保证延迟期间
            // 停留在首帧(透明);key 随 tab/page 变化整体重挂载即自动重播。
            <div
              key={item.id}
              className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
              style={{
                animationDelay: `${(index % 12) * 50}ms`,
                animationFillMode: "backwards",
              }}
            >
              <ImageCard
                id={item.id}
                prompt={item.prompt}
                imageUrl={item.imageUrl}
                model={item.model}
                size={item.size}
                creditsConsumed={item.creditsConsumed}
                createdAt={item.createdAt}
                status={item.status}
                timeZone={timeZone}
                selectable={selectMode}
                selected={selectedIds.has(item.id)}
                onSelect={selectMode ? handleSelect : undefined}
                onClick={
                  selectMode ? undefined : () => setSelectedId(item.id)
                }
                badge={
                  item.outputRole === "agent_draft"
                    ? copy("Draft", "中间图")
                    : item.outputRole === "upload"
                      ? copy("Upload", "上传")
                      : undefined
                }
              />
            </div>
          )
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-4">
          <Button asChild variant="outline">
            <Link href={nextPageHref} scroll={false}>
              {copy("Load more", "加载更多")}
            </Link>
          </Button>
        </div>
      )}

      {/* 多选模式下的浮动批量操作栏:从底部滑入淡入,模态级投影 */}
      {selectMode && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-modal animate-in fade-in slide-in-from-bottom-4 duration-250 motion-reduce:animate-none">
            <span className="text-sm text-muted-foreground">
              {copy(
                `Selected ${selectedIds.size} items`,
                `已选择 ${selectedIds.size} 项`
              )}
            </span>
            <div className="h-4 w-px bg-border" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleSelectAll}
            >
              {selectedIds.size === items.length
                ? copy("Deselect all", "取消全选")
                : copy("Select all", "全选")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchDownload}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {copy("Download", "下载")}
            </Button>
            <Button
              variant={
                confirmBatchDelete ? "destructive" : "outline"
              }
              size="sm"
              disabled={batchDeleting}
              onClick={handleBatchDelete}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {confirmBatchDelete
                ? copy(
                    `Confirm delete ${selectedIds.size} items`,
                    `确认删除 ${selectedIds.size} 项`
                  )
                : copy("Delete", "删除")}
            </Button>
          </div>
        </div>
      )}

      {selected && (
        <ImageLightbox
          generation={selected as LightboxGeneration}
          imageUrl={selected.imageUrl}
          open={selectedId !== null}
          timeZone={timeZone}
          onClose={() => setSelectedId(null)}
          onDelete={
            selected.outputRole === "agent_draft" ||
            selected.outputRole === "upload"
              ? undefined
              : handleDelete
          }
        />
      )}
    </>
  );
}
