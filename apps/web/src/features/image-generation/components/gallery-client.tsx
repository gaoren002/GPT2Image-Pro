"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  Download,
  ImagePlus,
  MousePointerClick,
  Search,
  Trash2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { batchDeleteGenerationAction } from "@/features/image-generation/actions";
import { ImageCard } from "@/features/image-generation/components/image-card";
import type {
  LightboxGeneration,
  LightboxReferenceImage,
} from "@/features/image-generation/components/image-lightbox";
import { generateDownloadFilename } from "@/lib/download-filename";

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
  outputRole?: "final" | "agent_draft" | "upload";
  referenceImages?: LightboxReferenceImage[];
  isLayered?: boolean;
}

export interface GalleryClientProps {
  initialGenerations: GenerationWithUrl[];
  totalCount: number;
  finalCount: number;
  draftCount: number;
  uploadCount: number;
  activeTab: "final" | "agent-drafts" | "uploads";
  page: number;
  timeZone: string;
  /** 当前搜索关键词(URL query,服务端已过滤)。 */
  searchQuery: string;
  /** 当前模型筛选(精确匹配,空为全部)。 */
  searchModel: string;
  /** 日期范围(YYYY-MM-DD,空为不限)。 */
  searchFrom: string;
  searchTo: string;
  /** 模型下拉选项(该用户实际用过的模型)。 */
  modelOptions: string[];
}

export function GalleryClient({
  initialGenerations,
  totalCount,
  finalCount,
  draftCount,
  uploadCount,
  activeTab,
  page,
  timeZone,
  searchQuery,
  searchModel,
  searchFrom,
  searchTo,
  modelOptions,
}: GalleryClientProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const router = useRouter();
  const [items, setItems] = useState<GenerationWithUrl[]>(initialGenerations);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queryInput, setQueryInput] = useState(searchQuery);
  const [modelInput, setModelInput] = useState(searchModel);
  const [fromInput, setFromInput] = useState(searchFrom);
  const [toInput, setToInput] = useState(searchTo);

  useEffect(() => {
    setQueryInput(searchQuery);
    setModelInput(searchModel);
    setFromInput(searchFrom);
    setToInput(searchTo);
  }, [searchQuery, searchModel, searchFrom, searchTo]);

  // -- 多选模式状态 --
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 记录上一次点选的索引,用于 Shift 范围选择 */
  const lastSelectedIndexRef = useRef<number>(-1);
  /** 批量删除二次确认:第一次点击设为 true,第二次才真正执行 */
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
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
          const start = Math.min(lastSelectedIndexRef.current, currentIndex);
          const end = Math.max(lastSelectedIndexRef.current, currentIndex);
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
    const toDownload = items.filter((i) => selectedIds.has(i.id) && i.imageUrl);
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
        setItems((prev) => prev.filter((i) => !selectedIds.has(i.id)));
        setSelectedIds(new Set());
        setConfirmBatchDelete(false);
        toast.success(
          copy(`Deleted ${count} images`, `已删除 ${count} 张图片`)
        );
      } else {
        const msg = result?.serverError || copy("Failed to delete", "删除失败");
        toast.error(
          typeof msg === "string" ? msg : copy("Failed to delete", "删除失败")
        );
      }
    } catch {
      toast.error(copy("Failed to delete", "删除失败"));
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
  // 链接(标签切换/加载更多)保留全部筛选,翻页不丢上下文。
  const filterSuffix = (next: {
    q: string;
    model: string;
    from: string;
    to: string;
  }) => {
    const parts: string[] = [];
    if (next.q) parts.push(`q=${encodeURIComponent(next.q)}`);
    if (next.model) parts.push(`model=${encodeURIComponent(next.model)}`);
    if (next.from) parts.push(`from=${next.from}`);
    if (next.to) parts.push(`to=${next.to}`);
    return parts.length ? `&${parts.join("&")}` : "";
  };
  const currentFilters = {
    q: searchQuery,
    model: searchModel,
    from: searchFrom,
    to: searchTo,
  };
  const galleryHref = (
    tab: GalleryClientProps["activeTab"],
    nextPage = 1,
    filters: {
      q: string;
      model: string;
      from: string;
      to: string;
    } = currentFilters
  ) =>
    `/${locale}/dashboard/gallery?tab=${tab}&page=${nextPage}${filterSuffix(filters)}`;
  const nextPageHref = galleryHref(activeTab, page + 1);

  // startTransition:筛选导航低优先级调度,控件保持即时响应。
  const [, startFilterTransition] = useTransition();

  const filterHref = (next: {
    q: string;
    model: string;
    from: string;
    to: string;
  }) =>
    `/${locale}/dashboard/gallery?tab=${activeTab}&page=1${filterSuffix(next)}`;

  /** 搜索提交(回车/按钮):回到第 1 页。 */
  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    startFilterTransition(() => {
      router.push(
        filterHref({
          q: queryInput.trim(),
          model: modelInput,
          from: fromInput,
          to: toInput,
        })
      );
    });
  };
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
                className={countBadgeClass(activeTab === "final")}
              >
                {finalCount}
              </Badge>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="agent-drafts" asChild>
            <Link href={galleryHref("agent-drafts")} scroll={false}>
              {copy("Agent drafts", "Agent 中间图")}
              <Badge
                variant="outline"
                className={countBadgeClass(activeTab === "agent-drafts")}
              >
                {draftCount}
              </Badge>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="uploads" asChild>
            <Link href={galleryHref("uploads")} scroll={false}>
              {copy("User uploads", "用户上传图")}
              <Badge
                variant="outline"
                className={countBadgeClass(activeTab === "uploads")}
              >
                {uploadCount}
              </Badge>
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* 搜索:URL query 驱动服务端过滤(关键词/模型/日期),标签切换与
          加载更多保留全部筛选 */}
      <form
        onSubmit={handleSearchSubmit}
        className="grid gap-2 md:grid-cols-[minmax(200px,1fr)_160px_140px_140px_auto_auto] md:items-center"
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={copy(
              "Search prompt or model...",
              "搜索提示词或模型..."
            )}
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <select
          value={modelInput}
          onChange={(event) => {
            const next = event.target.value;
            setModelInput(next);
            startFilterTransition(() => {
              router.push(
                filterHref({
                  q: queryInput.trim(),
                  model: next,
                  from: fromInput,
                  to: toInput,
                })
              );
            });
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <option value="">{copy("All models", "全部模型")}</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={fromInput}
          onChange={(event) => {
            const next = event.target.value;
            setFromInput(next);
            startFilterTransition(() => {
              router.push(
                filterHref({
                  q: queryInput.trim(),
                  model: modelInput,
                  from: next,
                  to: toInput,
                })
              );
            });
          }}
          title={copy("From date", "开始日期")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <input
          type="date"
          value={toInput}
          onChange={(event) => {
            const next = event.target.value;
            setToInput(next);
            startFilterTransition(() => {
              router.push(
                filterHref({
                  q: queryInput.trim(),
                  model: modelInput,
                  from: fromInput,
                  to: next,
                })
              );
            });
          }}
          title={copy("To date", "结束日期")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" variant="outline" className="h-9">
          {copy("Search", "搜索")}
        </Button>
        {(searchQuery || searchModel || searchFrom || searchTo) && (
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-2"
            title={copy("Clear", "清除")}
            onClick={() => {
              setQueryInput("");
              setModelInput("");
              setFromInput("");
              setToInput("");
              router.push(
                `/${locale}/dashboard/gallery?tab=${activeTab}&page=1`
              );
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </form>
      {/* 多选模式切换按钮 */}
      <Button
        variant={selectMode ? "secondary" : "outline"}
        size="sm"
        onClick={selectMode ? exitSelectMode : () => setSelectMode(true)}
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
        {items.map((item, index) => (
          // 入场错峰:按网格索引 50ms 递增(12 个一轮回)。fill-mode backwards 保证
          // 延迟期间停留在首帧(透明);key 随 tab/page 变化整体重挂载即自动重播。
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
              onClick={selectMode ? undefined : () => setSelectedId(item.id)}
              badge={
                item.outputRole === "agent_draft"
                  ? copy("Draft", "中间图")
                  : item.outputRole === "upload"
                    ? copy("Upload", "上传")
                    : undefined
              }
            />
          </div>
        ))}
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
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              {selectedIds.size === items.length
                ? copy("Deselect all", "取消全选")
                : copy("Select all", "全选")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleBatchDownload}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {copy("Download", "下载")}
            </Button>
            <Button
              variant={confirmBatchDelete ? "destructive" : "outline"}
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
