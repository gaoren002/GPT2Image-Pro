"use client";

import { formatCredits } from "@repo/shared/credits/format";
import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ImageIcon,
  ImagePlus,
  Search,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import type {
  LightboxGeneration,
  LightboxReferenceImage,
} from "@/features/image-generation/components/image-lightbox";

// 懒加载:lightbox(大图查看模态)仅在点开某张图时才需要,改 next/dynamic 后从列表页
// 首屏 bundle 移出,点开时再异步加载。
const ImageLightbox = dynamic(
  () =>
    import("@/features/image-generation/components/image-lightbox").then(
      (m) => m.ImageLightbox
    ),
  { ssr: false }
);

import type { GenerationCreditDetails } from "@/features/image-generation/credit-calculation-details";

export interface HistoryGeneration {
  id: string;
  prompt: string;
  revisedPrompt: string | null;
  promptRepairNotice?: string | null;
  model: string;
  size: string;
  creditsConsumed: number;
  creditDetails: GenerationCreditDetails | null;
  status: "pending" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  storageKey: string | null;
  storageBucket: string | null;
  imageUrl: string | null;
  referenceImages?: LightboxReferenceImage[];
  isLayered?: boolean;
}

export interface HistoryClientProps {
  initialGenerations: HistoryGeneration[];
  totalCount: number;
  page: number;
  pageSize: number;
  timeZone: string;
  /** 当前搜索关键词(URL query,服务端已过滤)。 */
  searchQuery: string;
  /** 当前状态筛选(completed/failed/pending,空为全部)。 */
  searchStatus: string;
  /** 当前模型筛选(精确匹配,空为全部)。 */
  searchModel: string;
  /** 日期范围(YYYY-MM-DD,空为不限)。 */
  searchFrom: string;
  searchTo: string;
  /** 模型下拉选项(该用户实际用过的模型)。 */
  modelOptions: string[];
}

function statusClasses(status: HistoryGeneration["status"]): string {
  switch (status) {
    case "completed":
      return "bg-foreground/10 text-foreground";
    case "failed":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

const STATUS_LABELS_ZH: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  pending: "处理中",
};

function formatDate(iso: string, locale: string, timeZone: string): string {
  try {
    return formatDateInTimeZone(
      iso,
      locale,
      {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      },
      timeZone
    );
  } catch {
    return iso;
  }
}

function creditSummary(
  item: HistoryGeneration,
  copy: (en: string, zh: string) => string
) {
  const details = item.creditDetails;
  if (!details) return null;
  const parts = [];
  if (details.actualImageCredits !== null) {
    parts.push(
      `${copy("image", "图片")} ${formatCredits(details.actualImageCredits)}`
    );
  }
  if (details.chatCredits !== null && details.chatCredits > 0) {
    parts.push(
      `${copy("conversation", "对话")} ${formatCredits(details.chatCredits)}`
    );
  }
  if (details.billingMultiplier !== 1) {
    parts.push(
      `${copy("multiplier", "倍率")} x${Number(
        details.billingMultiplier.toFixed(4)
      )}`
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

export function HistoryClient({
  initialGenerations,
  totalCount,
  page,
  pageSize,
  timeZone,
  searchQuery,
  searchStatus,
  searchModel,
  searchFrom,
  searchTo,
  modelOptions,
}: HistoryClientProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const statusLabel = (status: string) =>
    isZh ? STATUS_LABELS_ZH[status] || status : status;
  const router = useRouter();
  const [items, setItems] = useState<HistoryGeneration[]>(initialGenerations);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState(String(page));
  const [queryInput, setQueryInput] = useState(searchQuery);
  const [statusInput, setStatusInput] = useState(searchStatus);
  const [modelInput, setModelInput] = useState(searchModel);
  const [fromInput, setFromInput] = useState(searchFrom);
  const [toInput, setToInput] = useState(searchTo);

  // 搜索/筛选变化时同步输入框(如浏览器后退)
  useEffect(() => {
    setQueryInput(searchQuery);
    setStatusInput(searchStatus);
    setModelInput(searchModel);
    setFromInput(searchFrom);
    setToInput(searchTo);
  }, [searchQuery, searchStatus, searchModel, searchFrom, searchTo]);

  // page prop 变化时同步输入框显示值
  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const selected = items.find((i) => i.id === selectedId) ?? null;
  // 分页链接保留全部筛选(搜索提交时回到第 1 页)
  const filterSuffix = (next: {
    q: string;
    status: string;
    model: string;
    from: string;
    to: string;
  }) => {
    const parts: string[] = [];
    if (next.q) parts.push(`q=${encodeURIComponent(next.q)}`);
    if (next.status) parts.push(`status=${next.status}`);
    if (next.model) parts.push(`model=${encodeURIComponent(next.model)}`);
    if (next.from) parts.push(`from=${next.from}`);
    if (next.to) parts.push(`to=${next.to}`);
    return parts.length ? `&${parts.join("&")}` : "";
  };
  const currentFilters = {
    q: searchQuery,
    status: searchStatus,
    model: searchModel,
    from: searchFrom,
    to: searchTo,
  };
  const historyHref = (nextPage: number) =>
    `/${locale}/dashboard/history?page=${nextPage}${filterSuffix(currentFilters)}`;

  // 导航经 startTransition:筛选变更触发的服务端渲染标记为低优先级,
  // 输入框/下拉保持即时响应,不再有"整页刷新"的卡顿体感。
  const [, startFilterTransition] = useTransition();

  /** 提交当前筛选(回到第 1 页)。下拉/日期变更时即时调用,无需点按钮。 */
  const applyFilters = () => {
    const href = `/${locale}/dashboard/history?page=1${filterSuffix({
      q: queryInput.trim(),
      status: statusInput,
      model: modelInput,
      from: fromInput,
      to: toInput,
    })}`;
    startFilterTransition(() => {
      router.push(href);
    });
  };

  /** 回车提交(Enter)仍保留;下拉与日期在 onChange 即时触发。 */
  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    applyFilters();
  };

  const createHref = `/${locale}/dashboard/create`;

  /**
   * 处理页码输入框提交：解析、校验、导航。
   * 用于 onKeyDown(Enter) 和 onBlur，提取为公共函数避免重复。
   */
  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      // 无效输入，重置为当前页
      setPageInput(String(page));
      return;
    }
    const clamped = Math.min(parsed, totalPages);
    if (clamped === page) {
      // 目标页与当前页相同，仅同步显示值
      setPageInput(String(page));
      return;
    }
    setPageInput(String(clamped));
    router.push(historyHref(clamped));
  };

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  /** 搜索栏(关键词 + 状态/模型筛选 + 日期范围,URL query 驱动服务端过滤)。 */
  const hasActiveFilters =
    searchQuery || searchStatus || searchModel || searchFrom || searchTo;
  const searchForm = (
    <form
      onSubmit={handleSearchSubmit}
      className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 md:grid-cols-[minmax(220px,1fr)_140px_160px_140px_140px_auto_auto] md:items-center"
    >
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder={copy("Search prompt or model...", "搜索提示词或模型...")}
          className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <select
        value={statusInput}
        onChange={(event) => {
          const next = event.target.value;
          setStatusInput(next);
          startFilterTransition(() => {
            router.push(
              `/${locale}/dashboard/history?page=1${filterSuffix({
                q: queryInput.trim(),
                status: next,
                model: modelInput,
                from: fromInput,
                to: toInput,
              })}`
            );
          });
        }}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <option value="">{copy("All statuses", "全部状态")}</option>
        <option value="completed">{statusLabel("completed")}</option>
        <option value="failed">{statusLabel("failed")}</option>
        <option value="pending">{statusLabel("pending")}</option>
      </select>
      <select
        value={modelInput}
        onChange={(event) => {
          const next = event.target.value;
          setModelInput(next);
          startFilterTransition(() => {
            router.push(
              `/${locale}/dashboard/history?page=1${filterSuffix({
                q: queryInput.trim(),
                status: statusInput,
                model: next,
                from: fromInput,
                to: toInput,
              })}`
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
              `/${locale}/dashboard/history?page=1${filterSuffix({
                q: queryInput.trim(),
                status: statusInput,
                model: modelInput,
                from: next,
                to: toInput,
              })}`
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
              `/${locale}/dashboard/history?page=1${filterSuffix({
                q: queryInput.trim(),
                status: statusInput,
                model: modelInput,
                from: fromInput,
                to: next,
              })}`
            );
          });
        }}
        title={copy("To date", "结束日期")}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <Button type="submit" variant="outline" className="h-9">
        {copy("Search", "搜索")}
      </Button>
      {hasActiveFilters && (
        <Button
          type="button"
          variant="ghost"
          className="h-9 px-2"
          title={copy("Clear", "清除")}
          onClick={() => {
            setQueryInput("");
            setStatusInput("");
            setModelInput("");
            setFromInput("");
            setToInput("");
            router.push(`/${locale}/dashboard/history?page=1`);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </form>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {searchForm}
        <div className="flex animate-in fade-in flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-6 py-24 text-center duration-400 motion-reduce:animate-none">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <ImagePlus
              className="h-7 w-7 text-muted-foreground"
              strokeWidth={1.2}
            />
          </div>
          <h3 className="mt-5 font-serif text-lg font-medium text-foreground">
            {hasActiveFilters
              ? copy("No matching records", "没有匹配的记录")
              : copy("No history yet", "还没有历史记录")}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {hasActiveFilters
              ? copy(
                  "Try different keywords or clear the filters.",
                  "换个关键词或清除筛选条件试试。"
                )
              : copy(
                  "Your generation history will appear here once you create images.",
                  "创建图片后，生成历史会显示在这里。"
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
      {searchForm}
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="hidden grid-cols-[64px_minmax(0,1fr)_150px_90px_118px_92px_128px] items-center gap-3 border-b border-border bg-muted/30 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground md:grid">
          <div>{copy("Image", "图片")}</div>
          <div>{copy("Prompt", "提示词")}</div>
          <div>{copy("Model", "模型")}</div>
          <div>{copy("Size", "尺寸")}</div>
          <div>{copy("Credits", "积分")}</div>
          <div>{copy("Status", "状态")}</div>
          <div>{copy("Date", "日期")}</div>
        </div>

        <ul className="divide-y divide-border">
          {items.map((item) => {
            const summary = creditSummary(item, copy);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className="grid w-full grid-cols-[56px_minmax(0,1fr)] items-start gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-muted/70 md:grid-cols-[64px_minmax(0,1fr)_150px_90px_118px_92px_128px] md:items-center md:gap-3"
                >
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sm border border-border bg-muted md:h-14 md:w-14">
                    {item.imageUrl && item.status === "completed" ? (
                      <Image
                        // 列表缩略图(56–64px):请求 w=128 的小图,避免下整图(平均 2.4MB)。
                        // 宽度走"路径段"(非 ?w= 查询参数),绕过 Cloudflare 忽略 query 的边缘
                        // 缓存键(否则命中并下回整张原图、挤占连接、饿死导航)。
                        src={
                          buildStorageThumbnailUrl(item.imageUrl, 128) ??
                          item.imageUrl
                        }
                        alt={item.prompt}
                        fill
                        sizes="64px"
                        className="object-contain"
                        unoptimized
                        // 低优先级:把 HTTP/2 连接带宽优先让给导航请求(见 ImageCard 注释)。
                        fetchPriority="low"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <ImageIcon className="h-5 w-5" strokeWidth={1.2} />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="line-clamp-2 break-words text-sm leading-snug text-foreground">
                      {item.prompt}
                    </p>
                    {item.error ? (
                      <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-destructive">
                        {item.error}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground md:hidden">
                      <span className="font-mono">{item.model}</span>
                      <span>·</span>
                      <span>{item.size}</span>
                      <span>·</span>
                      <Badge
                        variant="outline"
                        className={`rounded-full border-transparent px-2 py-0 font-normal text-[10px] uppercase ${statusClasses(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </Badge>
                    </div>
                    {summary && (
                      <p className="mt-1 text-[11px] leading-tight text-muted-foreground md:hidden">
                        {summary}
                      </p>
                    )}
                  </div>

                  <div
                    className="hidden min-w-0 truncate font-mono text-xs text-foreground md:block"
                    title={item.model}
                  >
                    {item.model}
                  </div>
                  <div className="hidden font-mono text-xs text-foreground md:block">
                    {item.size}
                  </div>
                  <div className="hidden text-xs text-foreground md:block">
                    {formatCredits(item.creditsConsumed)}
                    {summary && (
                      <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
                        {summary}
                      </span>
                    )}
                  </div>
                  <div className="hidden md:block">
                    <Badge
                      variant="outline"
                      className={`rounded-full border-transparent font-normal text-[10px] uppercase tracking-wide ${statusClasses(item.status)}`}
                    >
                      {statusLabel(item.status)}
                    </Badge>
                  </div>
                  <div className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
                    <Clock className="h-3 w-3" />
                    <span className="truncate">
                      {formatDate(item.createdAt, locale, timeZone)}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <p className="text-xs text-muted-foreground">
            {copy(
              `Page ${page} of ${totalPages} · ${totalCount} total`,
              `第 ${page} / ${totalPages} 页 · 共 ${totalCount} 条`
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              asChild={page > 1}
              variant="outline"
              size="sm"
              disabled={page <= 1}
            >
              {page > 1 ? (
                <Link href={historyHref(page - 1)}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  {copy("Previous", "上一页")}
                </Link>
              ) : (
                <span>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  {copy("Previous", "上一页")}
                </span>
              )}
            </Button>
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitPageInput();
                }
              }}
              onBlur={commitPageInput}
              aria-label={copy("Page number", "页码")}
              className="h-8 w-16 rounded-sm border border-border bg-background text-center text-sm text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">
              / {totalPages}
            </span>
            <Button
              asChild={page < totalPages}
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
            >
              {page < totalPages ? (
                <Link href={historyHref(page + 1)}>
                  {copy("Next", "下一页")}
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Link>
              ) : (
                <span>
                  {copy("Next", "下一页")}
                  <ChevronRight className="ml-1 h-4 w-4" />
                </span>
              )}
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
          onDelete={handleDelete}
        />
      )}
    </>
  );
}
