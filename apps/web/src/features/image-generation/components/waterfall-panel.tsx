"use client";

/**
 * 瀑布流面板(独立组件,从 create-page-client 拆出)。
 *
 * 职责:批量瀑布生成(输入区、状态条、卡片列、加载触发器)。面板内订阅
 * activeMode/batchPrompt/附件/批次状态/quality/outputFormat;卡片列的逐帧
 * 订阅已由 WaterfallCardList 承担。切 tab 时 props 稳定,只更新 hidden。
 *
 * 约束:传入的 handler 与渲染回调必须是稳定引用;renderBatchCard 亦然。
 */

import { Button } from "@repo/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Textarea } from "@repo/ui/components/textarea";
import { ChevronDown, ImagePlus, Loader2, Send, Trash2, X } from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import type { ImageOutputFormat, ImageQuality } from "../types";
import type { BatchCard } from "./chat-message-types";
import type { ChatModel, ChatThinkingLevel } from "./create-page-client";
import {
  IMAGE_ACCEPT,
  OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
} from "./panel-shared";
import { WaterfallCardList } from "./waterfall-card-list";

export function WaterfallPanel({
  addBatchAttachments,
  autoSizeLabel,
  batchImageInputRef,
  batchLoadTriggerRef,
  batchPromptRef,
  batchScrollRef,
  batchSingleCreditFormula,
  batchStoppedRef,
  chatCustomEditSize,
  chatImageModel,
  chatMixWebFirstActive,
  chatQualityMultipliers,
  chatSuggestions,
  customApiBillingLabel,
  disableResponsesOnlyControls,
  effectiveWaterfallTier,
  formattedBalance,
  formattedBatchSingleCreditCost,
  formattedWaterfallCreditsConsumed,
  handleBatchSubmit,
  handleBatchSuggestion,
  handleChatPaste,
  handleClearWaterfall,
  handleStopWaterfall,
  hasChatImageAttachments,
  imageModelHelpText,
  maxChatImages,
  promptOptimizationField,
  removeChatAttachment,
  renderBackgroundSelect,
  renderGptModelSelect,
  renderHdRepairToggle,
  renderImageModelSelect,
  renderThinkingSelect,
  renderTransparentMatteToggle,
  responsesOnlyDisabledReason,
  triggerBatchGeneration,
  waterfallStatusText,
  waterfallTierOptions,
  customApiActive,
  outputFormatHelpText,
  outputFormatLabel,
  qualityLabelWithBilling,
  showImageModelControls,
  renderBatchCard,
  isWebOnlyBackend,
  backgroundHelpText,
}: {
  addBatchAttachments: (
    files: FileList | File[] | null
  ) => void | Promise<void>;
  autoSizeLabel: React.ReactNode;
  batchImageInputRef: React.RefObject<HTMLInputElement | null>;
  batchLoadTriggerRef: React.RefObject<HTMLDivElement | null>;
  batchPromptRef: React.MutableRefObject<string>;
  batchScrollRef: React.RefObject<HTMLDivElement | null>;
  batchSingleCreditFormula: React.ReactNode;
  batchStoppedRef: React.MutableRefObject<boolean>;
  chatCustomEditSize: string;
  chatImageModel: string;
  chatMixWebFirstActive: boolean;
  chatQualityMultipliers: Partial<Record<string, number>> | null;
  chatSuggestions: readonly string[];
  customApiBillingLabel: React.ReactNode;
  disableResponsesOnlyControls: boolean;
  effectiveWaterfallTier: number;
  formattedBalance: string;
  formattedBatchSingleCreditCost: string;
  formattedWaterfallCreditsConsumed: string;
  handleBatchSubmit: (event?: React.FormEvent) => void | Promise<void>;
  handleBatchSuggestion: (suggestion: string) => void;
  handleChatPaste: (event: React.ClipboardEvent) => void;
  handleClearWaterfall: () => void;
  handleStopWaterfall: () => void;
  hasChatImageAttachments: boolean;
  imageModelHelpText: string;
  maxChatImages: number;
  promptOptimizationField: (id: string, disabled?: boolean) => React.ReactNode;
  removeChatAttachment: (index: number) => void;
  renderBackgroundSelect: (params: {
    id: string;
    disabled?: boolean;
    compact?: boolean;
  }) => React.ReactNode;
  renderGptModelSelect: (params: {
    id: string;
    value: ChatModel | "default";
    onChange: (value: ChatModel | "default") => void;
    disabled?: boolean;
    compact?: boolean;
    allowDefault?: boolean;
  }) => React.ReactNode;
  renderHdRepairToggle: (params: {
    id: string;
    disabled?: boolean;
  }) => React.ReactNode;
  renderImageModelSelect: (params: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    compact?: boolean;
  }) => React.ReactNode;
  renderThinkingSelect: (params: {
    id: string;
    value: ChatThinkingLevel;
    onChange: (value: ChatThinkingLevel) => void;
    disabled?: boolean;
    compact?: boolean;
  }) => React.ReactNode;
  renderTransparentMatteToggle: (params: {
    id: string;
    disabled?: boolean;
  }) => React.ReactNode;
  responsesOnlyDisabledReason: string | undefined;
  triggerBatchGeneration: (options?: {
    retryCardId?: string;
  }) => void | Promise<void>;
  waterfallStatusText: string;
  waterfallTierOptions: number[];
  customApiActive: boolean;
  outputFormatHelpText: string;
  outputFormatLabel: (format: ImageOutputFormat) => string;
  qualityLabelWithBilling: (
    value: ImageQuality,
    multipliers?: Partial<Record<string, number>> | null
  ) => string;
  showImageModelControls: boolean;
  renderBatchCard: (card: BatchCard) => React.ReactNode;
  isWebOnlyBackend: boolean;
  backgroundHelpText: string;
}) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [activeMode] = useCreateRuntimeState<string>("activeMode", "text");
  const [batchPrompt, setBatchPrompt] = useCreateRuntimeState(
    "batchPrompt",
    ""
  );
  const [chatAttachments] = useCreateRuntimeState<
    Array<{
      id: string;
      kind: "image" | "file";
      file: File;
      previewUrl?: string;
    }>
  >("chatAttachments", []);
  const [isBatchActive] = useCreateRuntimeState("isBatchActive", false);
  const [isBatchLoadingMore] = useCreateRuntimeState(
    "isBatchLoadingMore",
    false
  );
  const [isBatchStopped, setIsBatchStopped] = useCreateRuntimeState(
    "isBatchStopped",
    false
  );
  const [quality, setQuality] = useCreateRuntimeState<ImageQuality>(
    "quality",
    "auto"
  );
  const [outputFormat, setOutputFormat] =
    useCreateRuntimeState<ImageOutputFormat>("outputFormat", "png");
  const [chatModel, setChatModel] = useCreateRuntimeState<
    ChatModel | "default"
  >("chatModel", "default");
  const [, setChatImageModel] = useCreateRuntimeState(
    "chatImageModel",
    "default"
  );
  const [chatThinking, setChatThinking] =
    useCreateRuntimeState<ChatThinkingLevel>("chatThinking", "low");
  const [, setWaterfallTier] = useCreateRuntimeState("waterfallTier", 4);
  const [useAutoSize] = useCreateRuntimeState("useAutoSize", true);
  const [useAutoChatEditSize] = useCreateRuntimeState(
    "useAutoChatEditSize",
    true
  );
  const [size] = useCreateRuntimeState("size", "1024x1024");
  const [, setChatSizeDialogOpen] = useCreateRuntimeState(
    "chatSizeDialogOpen",
    false
  );

  return (
    <div role="tabpanel" hidden={activeMode !== "waterfall"} className="mt-0">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            {renderGptModelSelect({
              id: "batch-gpt-model",
              value: chatModel,
              onChange: (value) => {
                if (value !== "default") setChatModel(value);
              },
              compact: true,
            })}
            {renderThinkingSelect({
              id: "batch-thinking",
              value: chatThinking,
              onChange: setChatThinking,
              compact: true,
            })}
            <Select
              value={`${effectiveWaterfallTier}`}
              onValueChange={(value: string) => setWaterfallTier(Number(value))}
              disabled={Boolean(isBatchActive)}
            >
              <SelectTrigger
                id="waterfall-tier"
                className="h-8 w-auto gap-1"
                title={copy(
                  "Images per batch (concurrency)",
                  "每批生成张数(并发)"
                )}
              >
                <span className="text-xs text-muted-foreground">
                  {copy("Batch", "每批")}
                </span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {waterfallTierOptions.map((value) => (
                  <SelectItem key={String(value)} value={String(value)}>
                    {String(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showImageModelControls && (
              <div
                className={chatMixWebFirstActive ? "opacity-55" : ""}
                title={
                  chatMixWebFirstActive
                    ? responsesOnlyDisabledReason
                    : imageModelHelpText
                }
              >
                {renderImageModelSelect({
                  id: "waterfall-image-model",
                  value: chatImageModel,
                  onChange: setChatImageModel,
                  disabled: isBatchActive || chatMixWebFirstActive,
                  compact: true,
                })}
              </div>
            )}
            {/* 质量：复用 quality 状态(瀑布流请求已发送该参数)，Web-only 后端不支持故隐藏 */}
            {!isWebOnlyBackend && (
              <Select
                value={quality}
                onValueChange={(value) => setQuality(value as ImageQuality)}
                disabled={isBatchActive || disableResponsesOnlyControls}
              >
                <SelectTrigger
                  id="waterfall-quality"
                  className="h-8 w-auto gap-1"
                  title={copy("Image quality", "图像质量")}
                >
                  <span className="text-xs text-muted-foreground">
                    {copy("Quality", "质量")}
                  </span>
                  <SelectValue>
                    {qualityLabelWithBilling(quality, chatQualityMultipliers)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {QUALITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {qualityLabelWithBilling(
                        option.value,
                        chatQualityMultipliers
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* 尺寸：复用既有 chat 尺寸弹窗(与 getBatchFallbackSize 同源)，运行中禁用避免批次中途变更 */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={Boolean(isBatchActive)}
              onClick={() => setChatSizeDialogOpen(true)}
              title={copy("Set image size", "设置图像尺寸")}
            >
              {copy("Size", "尺寸")}：
              {hasChatImageAttachments
                ? useAutoChatEditSize
                  ? autoSizeLabel
                  : chatCustomEditSize
                : useAutoSize
                  ? autoSizeLabel
                  : size}
            </Button>
            {!isWebOnlyBackend && (
              <div
                className={chatMixWebFirstActive ? "opacity-55" : ""}
                title={
                  chatMixWebFirstActive
                    ? responsesOnlyDisabledReason
                    : backgroundHelpText
                }
              >
                {renderBackgroundSelect({
                  id: "batch-background",
                  disabled: isBatchActive || chatMixWebFirstActive,
                  compact: true,
                })}
              </div>
            )}
            {!isWebOnlyBackend &&
              renderTransparentMatteToggle({
                id: "batch-transparent-matte",
                disabled: isBatchActive || chatMixWebFirstActive,
              })}
            {/* 输出格式：与 chat 面板同款补齐入口（共享 outputFormat 状态）。 */}
            {!isWebOnlyBackend && (
              <div
                className={chatMixWebFirstActive ? "opacity-55" : ""}
                title={
                  chatMixWebFirstActive
                    ? responsesOnlyDisabledReason
                    : outputFormatHelpText
                }
              >
                <Select
                  value={outputFormat}
                  onValueChange={(value) =>
                    setOutputFormat(value as ImageOutputFormat)
                  }
                  disabled={isBatchActive || chatMixWebFirstActive}
                >
                  <SelectTrigger
                    id="batch-output-format"
                    className="h-8 w-auto gap-1"
                    title={outputFormatHelpText}
                  >
                    <span className="text-xs text-muted-foreground">
                      {copy("Format", "格式")}
                    </span>
                    <SelectValue>{outputFormatLabel(outputFormat)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {OUTPUT_FORMAT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {outputFormatLabel(option.value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {renderHdRepairToggle({
              id: "batch-hd-repair",
              disabled: isBatchActive,
            })}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {promptOptimizationField(
              "batch-prompt-optimization",
              isBatchActive
            )}
            <div className="text-xs text-muted-foreground">
              {customApiActive ? (
                <span className="font-medium text-foreground">
                  {customApiBillingLabel}
                </span>
              ) : (
                <>
                  {copy("Per image", "单张预计")}{" "}
                  <span className="font-medium text-foreground">
                    {formattedBatchSingleCreditCost}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {batchSingleCreditFormula}
                  </span>
                  {isBatchActive && (
                    <>
                      {" "}
                      <span className="text-muted-foreground">/</span>{" "}
                      {copy("Used", "已用")}{" "}
                      <span className="font-medium text-foreground">
                        {formattedWaterfallCreditsConsumed}
                      </span>
                    </>
                  )}{" "}
                  <span className="text-muted-foreground">/</span>{" "}
                  {copy("Balance", "余额")}{" "}
                  <span className="font-medium text-foreground">
                    {formattedBalance}
                  </span>{" "}
                </>
              )}
            </div>
          </div>
        </div>

        {!isBatchActive ? (
          <div className="mx-auto flex min-h-[560px] max-w-3xl flex-col justify-center px-4 py-10">
            <div className="mb-5 text-center">
              <h2 className="font-serif text-2xl font-semibold tracking-tight">
                {copy(
                  "What world will you flood with art?",
                  "你想让哪个世界充满图像？"
                )}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy(
                  "One prompt, endless creations",
                  "一个提示词，瀑布生成灵感"
                )}
              </p>
            </div>
            <form
              onSubmit={handleBatchSubmit}
              onPaste={handleChatPaste}
              className="space-y-3"
            >
              {hasChatImageAttachments && (
                <div className="flex flex-wrap justify-center gap-2">
                  {chatAttachments
                    .filter((item) => item.kind === "image")
                    .map((item, index) => (
                      <button
                        type="button"
                        key={`${item.file.name}-${item.previewUrl}`}
                        className="relative h-12 w-12 overflow-hidden rounded-md border bg-muted"
                        onClick={() => removeChatAttachment(index)}
                        title={copy("Remove reference image", "移除参考图片")}
                      >
                        <Image
                          src={item.previewUrl || ""}
                          alt={item.file.name}
                          fill
                          sizes="48px"
                          className="object-cover"
                          unoptimized
                        />
                      </button>
                    ))}
                </div>
              )}
              <div className="flex items-end gap-2 rounded-lg border border-border bg-background p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => batchImageInputRef.current?.click()}
                  disabled={chatAttachments.length >= maxChatImages}
                  title={copy("Attach reference image", "添加参考图片")}
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
                <Textarea
                  value={batchPrompt}
                  onChange={(event) => setBatchPrompt(event.target.value)}
                  placeholder={copy(
                    "Describe the images you want to generate...",
                    "描述你想生成的图片..."
                  )}
                  rows={1}
                  className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 py-2 text-base shadow-none focus-visible:ring-0"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!batchPrompt.trim()}
                  title={copy("Start waterfall", "开始瀑布流")}
                >
                  <Send className="h-4 w-4" />
                </Button>
                <input
                  ref={batchImageInputRef}
                  type="file"
                  multiple
                  accept={IMAGE_ACCEPT}
                  className="sr-only"
                  onChange={(event) => {
                    void addBatchAttachments(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>
            </form>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {chatSuggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-w-full"
                  onClick={() => handleBatchSuggestion(suggestion)}
                  title={suggestion}
                >
                  <span className="truncate">
                    {suggestion.length > 40
                      ? `${suggestion.slice(0, 40)}...`
                      : suggestion}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div
            ref={batchScrollRef}
            className="max-h-[760px] overflow-y-auto p-3"
          >
            <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-whisper backdrop-blur">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {batchPromptRef.current || batchPrompt}
                </p>
                <p className="text-muted-foreground">
                  {waterfallStatusText}
                  {isBatchStopped ? ` · ${copy("Stopped", "已停止")}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isBatchStopped ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      batchStoppedRef.current = false;
                      setIsBatchStopped(false);
                      void triggerBatchGeneration();
                    }}
                  >
                    <ChevronDown className="h-4 w-4" />
                    {copy("Continue", "继续生成")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleStopWaterfall}
                  >
                    <X className="h-4 w-4" />
                    {copy("Stop", "停止")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearWaterfall}
                >
                  <Trash2 className="h-4 w-4" />
                  {copy("Clear", "清空")}
                </Button>
              </div>
            </div>
            <WaterfallCardList renderCard={renderBatchCard} />
            <div
              ref={batchLoadTriggerRef}
              className="flex h-20 flex-col items-center justify-center gap-1 text-xs text-muted-foreground"
            >
              {isBatchLoadingMore ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {copy("Generating...", "生成中...")}
                </>
              ) : isBatchStopped ? (
                <>
                  <X className="h-4 w-4" />
                  {copy("Stopped", "已停止")}
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4" />
                  {copy("Scroll to generate more", "继续下拉生成更多")}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
