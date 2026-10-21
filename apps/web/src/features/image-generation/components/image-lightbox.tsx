"use client";

import { formatCredits } from "@repo/shared/credits/format";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Separator } from "@repo/ui/components/separator";
import {
  Download,
  GripVertical,
  ImageIcon,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { deleteGenerationAction } from "@/features/image-generation/actions";
import type { GenerationCreditDetails } from "@/features/image-generation/credit-calculation-details";
import { ExportPsdDialog } from "@/features/psd-export/components/export-psd-dialog";
import { writePendingReferenceHandoff } from "@/features/image-generation/reference-handoff";
import { generateDownloadFilename } from "@/lib/download-filename";

export interface LightboxReferenceImage {
  id: string;
  imageUrl: string;
  storageBucket?: string | null;
  storageKey?: string | null;
  name?: string | null;
  type?: string | null;
  sizeBytes?: number | null;
  source?: string | null;
  role?: string | null;
  index?: number;
}

export interface LightboxGeneration {
  id: string;
  prompt: string;
  revisedPrompt: string | null;
  promptRepairNotice?: string | null;
  model: string;
  size: string;
  creditsConsumed: number;
  creditDetails?: GenerationCreditDetails | null;
  status: "pending" | "completed" | "failed";
  error?: string | null;
  createdAt: string;
  outputRole?: "final" | "agent_draft" | "upload";
  referenceImages?: LightboxReferenceImage[];
  /** 是否为"生成即分层"产物:为 true 才展示导出分层 PSD 入口。 */
  isLayered?: boolean;
}

export interface ImageLightboxProps {
  generation: LightboxGeneration;
  imageUrl: string | null;
  open: boolean;
  timeZone?: string;
  onClose: () => void;
  onDelete?: (id: string) => void;
}

const STATUS_LABELS_ZH: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  pending: "处理中",
};
const EMPTY_REFERENCE_IMAGES: LightboxReferenceImage[] = [];

function formatDate(iso: string, locale: string, timeZone?: string): string {
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

function formatMultiplier(value: number) {
  return Number(value.toFixed(4)).toString();
}

/**
 * 计费倍率明细行：总倍率 = 分组/成员 × 池API模型 × 质量。
 * 新记录带各分量时逐行拆出（等于 1 的分量跳过，噪音控制）；按模型分档
 * 取代质量表时质量行标注「已并入模型计价」。旧记录无分量只显示总倍率。
 */
function buildMultiplierRows(creditDetails: GenerationCreditDetails) {
  const total = `x${formatMultiplier(creditDetails.billingMultiplier)}`;
  const has = creditDetails.backendBillingMultiplier !== null;
  if (!has) {
    return [{ label: "计费倍率", value: total }];
  }
  const rows: Array<{ label: string; value: string }> = [
    {
      label: "计费倍率（合计）",
      value: total,
    },
  ];
  const push = (label: string, multiplier: number | null) => {
    if (multiplier === null || multiplier === 1) return;
    rows.push({ label, value: `x${formatMultiplier(multiplier)}` });
  };
  push("· 分组/成员倍率", creditDetails.backendBillingMultiplier);
  push("· 模型计价倍率", creditDetails.poolApiModelBillingMultiplier);
  if (creditDetails.poolApiModelBillingReplacesQuality) {
    rows.push({
      label: "· 质量倍率",
      value: "已并入模型计价",
    });
  } else {
    push("· 质量倍率", creditDetails.qualityBillingMultiplier);
  }
  return rows;
}

export function ImageLightbox({
  generation,
  imageUrl,
  open,
  timeZone,
  onClose,
  onDelete,
}: ImageLightboxProps) {
  const locale = useLocale();
  const router = useRouter();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const statusLabel = (status: string) =>
    isZh ? STATUS_LABELS_ZH[status] || status : status;
  const creditDetails = generation.creditDetails ?? null;
  const creditRows = creditDetails
    ? [
        {
          label: copy("Total charged", "实际扣费"),
          value: `${formatCredits(creditDetails.totalCredits)} ${copy(
            "credits",
            "积分"
          )}`,
        },
        creditDetails.actualImageCredits !== null
          ? {
              label: copy("Image subtotal", "图片小计"),
              value: `${formatCredits(creditDetails.actualImageCredits)} ${copy(
                "credits",
                "积分"
              )}`,
            }
          : null,
        creditDetails.requestedTotalCredits !== null &&
        creditDetails.requestedTotalCredits !== creditDetails.actualImageCredits
          ? {
              label: copy("Requested estimate", "请求预估"),
              value: `${formatCredits(
                creditDetails.requestedTotalCredits
              )} ${copy("credits", "积分")}`,
            }
          : null,
        creditDetails.baseCredits !== null
          ? {
              label: copy("Base image (pre-multiplier)", "基础生图（倍率前）"),
              value: `${formatCredits(
                creditDetails.baseCreditsBeforeMultiplier ??
                  creditDetails.baseCredits
              )} ${copy("credits", "积分")}`,
            }
          : null,
        creditDetails.moderationCredits !== null
          ? {
              label: copy("Review add-on (pre-multiplier)", "审核附加（倍率前）"),
              value: `${formatCredits(
                creditDetails.moderationCreditsBeforeMultiplier ??
                  creditDetails.moderationCredits
              )} ${copy("credits", "积分")}`,
            }
          : null,
        creditDetails.chatCredits !== null && creditDetails.chatCredits > 0
          ? {
              label: copy("Chat/Agent rounds", "Chat/Agent 轮次"),
              value: `${formatCredits(creditDetails.chatCredits)} ${copy(
                "credits",
                "积分"
              )}${
                creditDetails.chatRoundCount !== null &&
                creditDetails.chatRoundCredits !== null
                  ? ` · ${creditDetails.chatRoundCount} x ${formatCredits(
                      creditDetails.chatRoundCredits
                    )}`
                  : ""
              }`,
            }
          : null,
        ...buildMultiplierRows(creditDetails),
        creditDetails.billableImageOutputCount !== null
          ? {
              label: copy("Billable images", "计费图片"),
              value:
                creditDetails.upstreamImageOutputCount !== null
                  ? `${creditDetails.billableImageOutputCount} / ${creditDetails.upstreamImageOutputCount}`
                  : String(creditDetails.billableImageOutputCount),
            }
          : null,
        creditDetails.requestedSize || creditDetails.actualSize
          ? {
              label: copy("Size settlement", "尺寸结算"),
              value:
                creditDetails.requestedSize &&
                creditDetails.actualSize &&
                creditDetails.requestedSize !== creditDetails.actualSize
                  ? `${creditDetails.requestedSize} -> ${creditDetails.actualSize}`
                  : creditDetails.actualSize ||
                    creditDetails.requestedSize ||
                    "-",
            }
          : null,
      ].filter((row): row is { label: string; value: string } => row !== null)
    : [];
  const [confirmDelete, setConfirmDelete] = useState(false);
  const referenceImages = generation.referenceImages ?? EMPTY_REFERENCE_IMAGES;
  const visibleReferenceImages = referenceImages.filter(
    (item) => !imageUrl || item.imageUrl !== imageUrl
  );
  const firstReferenceId = visibleReferenceImages[0]?.id;
  const [activePreviewId, setActivePreviewId] = useState<string>("output");
  const activeReference =
    activePreviewId === "output"
      ? null
      : visibleReferenceImages.find((item) => item.id === activePreviewId) ||
        null;
  const previewImageUrl = activeReference?.imageUrl || imageUrl;
  const previewLabel =
    activeReference?.name ||
    (activeReference ? copy("Reference image", "参考图") : generation.prompt);
  const currentImageLabel =
    generation.outputRole === "upload"
      ? copy("Upload", "上传")
      : generation.outputRole === "agent_draft"
        ? copy("Draft", "中间图")
        : copy("Output", "成品");
  const [detailsWidth, setDetailsWidth] = useState(44);
  const dragState = useRef<{
    startX: number;
    startWidth: number;
    containerWidth: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setActivePreviewId(imageUrl ? "output" : firstReferenceId || "output");
    setConfirmDelete(false);
  }, [imageUrl, firstReferenceId]);
  const createReferenceHref = (mode: "image" | "chat", intent: string) => {
    if (!previewImageUrl) return `/${locale}/dashboard/create`;
    const params = new URLSearchParams({
      mode,
      ref: previewImageUrl,
      sourceId: generation.id,
      sourceName: activeReference?.name || `gpt2image-${generation.id}`,
      intent,
      sendRef: intent,
    });
    return `/${locale}/dashboard/create?${params.toString()}`;
  };

  const createReferenceIntent = () => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };

  const handleSendReference = (mode: "image" | "chat") => {
    if (!previewImageUrl) return;
    const intent = createReferenceIntent();
    writePendingReferenceHandoff({
      id: intent,
      mode,
      imageUrl: previewImageUrl,
      sourceId: generation.id,
      sourceName: activeReference?.name || `gpt2image-${generation.id}`,
    });
    router.push(createReferenceHref(mode, intent));
    onClose();
  };

  const { execute: executeDelete, isExecuting: isDeleting } = useAction(
    deleteGenerationAction,
    {
      onSuccess: () => {
        toast.success(copy("Image deleted", "图片已删除"));
        onDelete?.(generation.id);
        setConfirmDelete(false);
        onClose();
      },
      onError: ({ error }) => {
        const message =
          error?.serverError ||
          error?.validationErrors?._errors?.[0] ||
          copy("Failed to delete image", "删除图片失败");
        toast.error(
          typeof message === "string"
            ? message
            : copy("Failed to delete image", "删除图片失败")
        );
      },
    }
  );

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    executeDelete({ generationId: generation.id });
  };

  const handleResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    const container = containerRef.current;
    if (!container) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      startX: event.clientX,
      startWidth: detailsWidth,
      containerWidth: container.getBoundingClientRect().width,
    };
  };

  const handleResizeMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = dragState.current;
    if (!state) return;
    const deltaPercent =
      ((state.startX - event.clientX) / state.containerWidth) * 100;
    const nextWidth = Math.min(
      58,
      Math.max(30, state.startWidth + deltaPercent)
    );
    setDetailsWidth(nextWidth);
  };

  const handleResizeEnd = (event: PointerEvent<HTMLButtonElement>) => {
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setConfirmDelete(false);
          onClose();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[92vh] max-w-6xl gap-0 overflow-y-auto border-border bg-background p-0 duration-250 md:overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {copy("Image details", "图片详情")}
        </DialogTitle>
        <div
          ref={containerRef}
          className="grid grid-cols-1 md:flex md:max-h-[92vh] md:min-h-[560px]"
        >
          <div
            className="relative aspect-square w-full shrink overflow-hidden bg-muted md:aspect-auto"
            style={{
              flexBasis: `calc(${100 - detailsWidth}% - 6px)`,
            }}
          >
            {previewImageUrl ? (
              <Image
                src={previewImageUrl}
                alt={previewLabel}
                fill
                sizes="(max-width: 768px) 100vw, 60vw"
                className="object-contain"
                unoptimized
              />
            ) : (
              <div className="flex h-full min-h-[320px] w-full items-center justify-center text-muted-foreground">
                <ImageIcon className="h-16 w-16" strokeWidth={1} />
              </div>
            )}
          </div>

          <button
            type="button"
            aria-label={copy("Resize details panel", "调整详情面板宽度")}
            className="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center border-x border-border bg-muted/40 transition-colors hover:bg-muted md:flex"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            style={{ touchAction: "none" }}
          >
            <span className="flex h-12 w-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground ring-1 ring-border transition-colors duration-150 group-hover:text-foreground">
              <GripVertical className="h-4 w-4" />
            </span>
          </button>

          <div
            className="flex min-h-0 w-full min-w-0 flex-col md:shrink-0"
            style={{ flexBasis: `calc(${detailsWidth}% - 6px)` }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div className="space-y-5">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Prompt", "提示词")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap font-serif text-base leading-relaxed text-foreground">
                    {generation.prompt}
                  </p>
                </div>

                {generation.revisedPrompt &&
                  generation.revisedPrompt !== generation.prompt && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                        {copy("Revised Prompt", "优化提示词")}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                        {generation.revisedPrompt}
                      </p>
                    </div>
                  )}

                {/* warning 语义 token(--color-warning 已入 @theme,随明暗切换),
                    替代硬编码 amber 色阶 */}
                {generation.promptRepairNotice && (
                  <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-widest text-warning">
                      {copy("Prompt Notice", "提示词说明")}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-warning">
                      {copy(
                        "The original prompt was rejected by safety checks, so the system made additional adjustments before generating this result.",
                        "原提示词因审核被拒，系统已进行更多修改后生成本次结果。"
                      )}
                    </p>
                  </div>
                )}

                {generation.status === "failed" && generation.error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-widest text-destructive">
                      {copy("Error", "错误")}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-destructive">
                      {generation.error}
                    </p>
                  </div>
                )}

                {(imageUrl || visibleReferenceImages.length > 0) && (
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Images", "图片")}
                    </p>
                    <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-5 md:grid-cols-4">
                      {imageUrl && generation.status === "completed" && (
                        <button
                          type="button"
                          onClick={() => setActivePreviewId("output")}
                          className={[
                            "group overflow-hidden rounded-md border bg-muted text-left transition-colors",
                            activePreviewId === "output"
                              ? "border-primary ring-1 ring-primary"
                              : "border-border hover:border-foreground/40",
                          ].join(" ")}
                          title={currentImageLabel}
                        >
                          <span className="relative block aspect-square">
                            {/* 非激活缩略图轻微降透明,hover/激活提亮到 100%,
                                与边框高亮共同标示当前预览项 */}
                            <Image
                              src={imageUrl}
                              alt={currentImageLabel}
                              fill
                              sizes="96px"
                              className={[
                                "object-cover transition-opacity duration-200",
                                activePreviewId === "output"
                                  ? "opacity-100"
                                  : "opacity-85 group-hover:opacity-100",
                              ].join(" ")}
                              unoptimized
                            />
                          </span>
                          <span className="block truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                            {currentImageLabel}
                          </span>
                        </button>
                      )}
                      {visibleReferenceImages.map((item, index) => (
                        <button
                          // id 存在回退到元数据 index 的路径,不保证全局唯一;
                          // 组合 imageUrl 兜底唯一性,避免用数组下标做 key
                          key={`${item.id}-${item.imageUrl}`}
                          type="button"
                          onClick={() => setActivePreviewId(item.id)}
                          className={[
                            "group overflow-hidden rounded-md border bg-muted text-left transition-colors",
                            activePreviewId === item.id
                              ? "border-primary ring-1 ring-primary"
                              : "border-border hover:border-foreground/40",
                          ].join(" ")}
                          title={item.name || copy("Reference image", "参考图")}
                        >
                          <span className="relative block aspect-square">
                            <Image
                              src={item.imageUrl}
                              alt={
                                item.name ||
                                `${copy("Reference", "参考图")} ${index + 1}`
                              }
                              fill
                              sizes="96px"
                              className={[
                                "object-cover transition-opacity duration-200",
                                activePreviewId === item.id
                                  ? "opacity-100"
                                  : "opacity-85 group-hover:opacity-100",
                              ].join(" ")}
                              unoptimized
                            />
                          </span>
                          <span className="block truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                            {item.name ||
                              `${copy("Reference", "参考图")} ${index + 1}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <Separator />

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Model", "模型")}
                    </dt>
                    <dd className="mt-0.5 font-mono text-xs text-foreground">
                      {generation.model}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Size", "尺寸")}
                    </dt>
                    <dd className="mt-0.5 font-mono text-xs text-foreground">
                      {generation.size}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Credits", "积分")}
                    </dt>
                    <dd className="mt-0.5 text-xs text-foreground">
                      {formatCredits(generation.creditsConsumed)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Status", "状态")}
                    </dt>
                    <dd className="mt-0.5">
                      <Badge
                        variant="outline"
                        className="rounded-full border-border font-normal text-[10px] uppercase tracking-wide"
                      >
                        {statusLabel(generation.status)}
                      </Badge>
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Created", "创建时间")}
                    </dt>
                    <dd className="mt-0.5 text-xs text-foreground">
                      {formatDate(generation.createdAt, locale, timeZone)}
                    </dd>
                  </div>
                </dl>

                {creditRows.length > 0 && (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Credit Calculation", "积分计算详情")}
                    </p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      {creditRows.map((row) => (
                        <div key={row.label}>
                          <dt className="text-muted-foreground">{row.label}</dt>
                          <dd className="mt-0.5 font-medium text-foreground">
                            {row.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                      {copy(
                        "Displayed credit components already include the backend group multiplier when applicable.",
                        "上方明细已包含命中后端分组倍率；最终以实际扣费为准。"
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-border bg-background p-6">
              {previewImageUrl && (
                <>
                  <Button
                    type="button"
                    className="w-full justify-center"
                    onClick={() => handleSendReference("image")}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    {copy("Send to image edit", "发送到图生图")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-center"
                    onClick={() => handleSendReference("chat")}
                  >
                    <MessageSquare className="mr-2 h-4 w-4" />
                    {copy("Send to chat", "发送到 Chat")}
                  </Button>
                  <Button
                    asChild
                    variant="outline"
                    className="w-full justify-center"
                  >
                    <a
                      href={previewImageUrl}
                      download={generateDownloadFilename(generation.prompt, generation.createdAt)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {copy("Download", "下载")}
                    </a>
                  </Button>
                  {generation.isLayered && (
                    <ExportPsdDialog
                      generationId={generation.id}
                      prompt={generation.prompt}
                      createdAt={generation.createdAt}
                    />
                  )}
                </>
              )}
              {onDelete && (
                <Button
                  variant={confirmDelete ? "destructive" : "ghost"}
                  className="w-full justify-center"
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  {confirmDelete
                    ? copy("Click again to confirm", "再次点击确认删除")
                    : copy("Delete", "删除")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
