"use client";

import {
  GPT52_CHAT_MODEL,
  GPT53_CODEX_CHAT_MODEL,
  GPT53_CODEX_SPARK_CHAT_MODEL,
  GPT54_CHAT_MODEL,
  GPT54_MINI_CHAT_MODEL,
  GPT55_CHAT_MODEL,
  type RESPONSES_IMAGE_MODELS,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { formatCredits } from "@repo/shared/credits/format";
import type { PlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import {
  Brush,
  Check,
  CircleHelp,
  Coins,
  Info,
  ChevronDown,
  Download,
  Eraser,
  Eye,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  FileText,
  Loader2,
  Maximize2,
  MessageSquare,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Send,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "next-intl";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  useCreateRuntimeAccessor,
  useCreateRuntimeRef,
  useCreateRuntimeState,
  useResetCreateRuntimeKeys,
} from "@/features/image-generation/create-runtime-store";
import {
  hasSeenWaterfallFirstTimeWarning,
  WaterfallWarningPopup,
  type WaterfallWarningType,
} from "@/features/image-generation/components/waterfall-warning-popup";
import {
  consumePendingReferenceHandoff,
  normalizeReferenceFetchUrl,
  type ReferenceHandoffMode,
} from "@/features/image-generation/reference-handoff";
import type { ImageBackendGroupBackendType } from "@/features/image-backend-pool/types";
import {
  agentEventToImageUrl,
  appendAgentRunEvent,
  buildAgentRoundCards,
  createOptimisticAgentRoundEvents,
  normalizeAgentEvent,
  type AgentTaskCard,
} from "../agent-round-cards";
import {
  AUTO_IMAGE_SIZE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageCreditCost,
  type ImageBaseCreditPricing,
  type ImageQualityLevel,
  type ImageThinkingLevel,
  IMAGE_1K_BASE_EDGE,
  IMAGE_DIMENSION_STEP,
  isFireflyModel,
  MAX_IMAGE_DIMENSION,
  normalizeImageSize,
  normalizeValidImageSize,
  parseImageSize,
  validateImageSize,
} from "../resolution";
import {
  applyBillingPreviewMultiplier,
  predictImageBillingRoute,
  shouldPreferWebImageRoute,
  type ImageBillingPixelRange,
} from "../billing-preview";
import type { VideoPricingInfo } from "../video-operations";
import { ImageLightbox, type LightboxGeneration } from "./image-lightbox";
import { VideoCreatePanel } from "./video-create-panel";

type RecentGeneration = {
  id: string;
  prompt: string;
  revisedPrompt: string | null;
  model: string;
  size: string;
  creditsConsumed: number;
  status: "pending" | "completed" | "failed";
  imageUrl: string | null;
  createdAt: string;
  isLayered?: boolean;
};

type ResultState = {
  generationId: string;
  imageUrl: string;
  prompt: string;
  model: string;
  size: string;
  creditsConsumed?: number;
  revisedPrompt?: string;
  promptRepairNotice?: string;
};

type ImageApiResult = {
  error?: string;
  status?: "pending" | "completed" | "failed";
  prompt?: string;
  generationId?: string;
  imageUrl?: string;
  imageFileId?: string;
  imageOutputs?: Array<{
    generationId?: string;
    imageUrl?: string;
    imageFileId?: string;
    webImageMessageId?: string;
    webImageGroupId?: string;
    size?: string;
    revisedPrompt?: string;
    upstreamRevisedPrompt?: string;
    promptRepairNotice?: string;
    index?: number;
    outputRole?: "final" | "agent_draft" | "choice";
  }>;
  model?: string;
  size?: string;
  revisedPrompt?: string;
  promptRepairNotice?: string;
  responseText?: string;
  responseThinking?: string;
  responseAgent?: string;
  agentEvents?: AgentRunEvent[];
  agentRoundCount?: number;
  layered?: boolean;
  webConversation?: ChatGptWebConversationState;
  backendMember?: StickyBackendMemberState;
  responsesPreviousResponse?: ResponsesPreviousResponseState;
  creditsConsumed?: number;
  createdAt?: string;
  completedAt?: string;
  results?: ImageApiResult[];
};

type GenerationRequestError = Error & {
  creditsConsumed?: number;
};

type AgentRunEvent = {
  id?: string;
  kind:
    | "message"
    | "reasoning"
    | "web_search"
    | "code_interpreter"
    | "image_generation"
    | "image_partial"
    | "tool";
  status?: "started" | "running" | "completed" | "failed";
  title: string;
  detail?: string;
  imageBase64?: string;
  imageUrl?: string;
  index?: number;
  partialImageIndex?: number;
  timestamp?: string;
  toolType?: string;
};

type ImageStreamEvent =
  | {
      type: "partial_image";
      index?: number;
      partial_image_index?: number;
      b64_json?: string;
      url?: string;
      final?: boolean;
    }
  | {
      type: "text_delta";
      index?: number;
      delta: string;
    }
  | {
      type: "thinking_delta";
      index?: number;
      delta: string;
    }
  | {
      type: "agent_delta";
      index?: number;
      delta: string;
    }
  | {
      type: "agent_event";
      index?: number;
      event: AgentRunEvent;
    }
  | ({ type: "completed" } & ImageApiResult)
  | ({ type: "error"; error: string } & ImageApiResult)
  | { type: "done" };

type EditImageFile = {
  file: File;
  previewUrl: string;
  sourceId?: string;
};

type ChatAttachment = EditImageFile & {
  kind: "image" | "file";
};

type ChatAttachmentPreview = {
  id: string;
  name: string;
  previewUrl?: string;
  kind?: "image" | "file";
};

type ChatVariant = {
  generationId?: string;
  imageUrl?: string;
  imageFileId?: string;
  pending?: boolean;
  webImageMessageId?: string;
  webImageGroupId?: string;
  prompt: string;
  model: string;
  size: string;
  revisedPrompt?: string;
  promptRepairNotice?: string;
  responseText?: string;
  responseThinking?: string;
  responseAgent?: string;
  agentEvents?: AgentRunEvent[];
  agentRoundCount?: number;
  webConversation?: ChatGptWebConversationState;
  backendMember?: StickyBackendMemberState;
  responsesPreviousResponse?: ResponsesPreviousResponseState;
  creditsConsumed?: number;
  createdAt?: string;
  outputRole?: "final" | "agent_draft" | "choice";
  // chat(web) 生成的可编辑文件(PPT/PSD)产物:下载链接。与图像 variant 并存于同一消息模型。
  files?: Array<{ label: string; url: string }>;
};

type ChatRecentGeneration = RecentGeneration & {
  canDelete?: boolean;
};

type ChatResultInput = Pick<
  ImageApiResult,
  | "generationId"
  | "imageUrl"
  | "imageFileId"
  | "model"
  | "size"
  | "revisedPrompt"
  | "promptRepairNotice"
  | "responseText"
  | "responseThinking"
  | "responseAgent"
  | "agentEvents"
  | "agentRoundCount"
  | "layered"
  | "webConversation"
  | "backendMember"
  | "responsesPreviousResponse"
  | "creditsConsumed"
> & {
  webImageMessageId?: string;
  webImageGroupId?: string;
  pending?: boolean;
  outputRole?: "final" | "agent_draft" | "choice";
};

type ChatGptWebConversationState = {
  conversationId: string;
  parentMessageId: string;
  accountId?: string;
  apiKeyId?: string;
  selectionMessageId?: string;
  selectedImageMessageId?: string;
};

type StickyBackendMemberState = {
  type: "api" | "account";
  id: string;
  groupId?: string | null;
  accountBackend?: "web" | "responses";
};

type ResponsesPreviousResponseState = {
  responseId: string;
  backendMember: StickyBackendMemberState;
  store: true;
  createdAt?: string;
};

type ConversationMode = "chat" | "agent" | "web";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  mode?: ConversationMode;
  attachments?: ChatAttachmentPreview[];
  variants?: ChatVariant[];
  activeVariant?: number;
  error?: string;
  createdAt: string;
};

type ChatConversation = {
  id: string;
  mode: ConversationMode;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

type ImageReferenceMentionOption = {
  token: string;
  label: string;
  detail: string;
  previewUrl?: string;
};

type MentionState = {
  open: boolean;
  start: number;
  end: number;
  query: string;
};

type ImageSizeDialogValue = {
  auto: boolean;
  width: number;
  height: number;
  mixWebFirst: boolean;
};

type ForceWebPixelRange = ImageBillingPixelRange;

const DEFAULT_FORCE_WEB_PIXEL_RANGE: ForceWebPixelRange = {
  minPixels: 660_000,
  maxPixels: 2_000_000,
};

function normalizeForceWebPixelRange(
  range?: ForceWebPixelRange | null
): ForceWebPixelRange {
  const min =
    typeof range?.minPixels === "number" && Number.isFinite(range.minPixels)
      ? Math.max(0, range.minPixels)
      : DEFAULT_FORCE_WEB_PIXEL_RANGE.minPixels;
  const max =
    typeof range?.maxPixels === "number" && Number.isFinite(range.maxPixels)
      ? Math.max(1, range.maxPixels)
      : DEFAULT_FORCE_WEB_PIXEL_RANGE.maxPixels;
  return {
    minPixels: Math.min(min, max),
    maxPixels: Math.max(min, max),
  };
}

function isMixWebFirstAvailableForSize(
  size?: string | null,
  range?: ForceWebPixelRange | null
) {
  const normalized = normalizeForceWebPixelRange(range);
  return shouldPreferWebImageRoute({
    size,
    webFirst: true,
    pixelRange: normalized,
  });
}

function formatPixelRange(range?: ForceWebPixelRange | null) {
  const normalized = normalizeForceWebPixelRange(range);
  const formatPixels = (pixels: number) =>
    `${(pixels / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}MP`;
  return `${formatPixels(normalized.minPixels)}-${formatPixels(
    normalized.maxPixels
  )}`;
}

function getNearestSupportedSizeForRatio(
  base: ImageSizeBase,
  ratio: { width: number; height: number }
) {
  const baseSpec =
    IMAGE_SIZE_BASES.find((item) => item.value === base) ||
    IMAGE_SIZE_BASES[0]!;
  const longEdge = baseSpec.edge;
  const landscape = ratio.width >= ratio.height;
  const rawWidth = landscape
    ? longEdge
    : (longEdge * ratio.width) / ratio.height;
  const rawHeight = landscape
    ? (longEdge * ratio.height) / ratio.width
    : longEdge;
  return normalizeValidImageSize({ width: rawWidth, height: rawHeight });
}

function parseAspectRatioInput(value: string) {
  const match = value.trim().match(/^(\d{1,3})\s*[:x]\s*(\d{1,3})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function inferImageSizeDialogState(value: ImageSizeDialogValue) {
  if (value.auto) {
    return {
      mode: "auto" as ImageSizeMode,
      base: "1k" as ImageSizeBase,
      ratio: "1:1" as ImageAspectRatio,
      customRatio: "1:1",
      mixWebFirst: value.mixWebFirst,
    };
  }

  const normalized = normalizeImageSize(value.width, value.height);
  for (const base of IMAGE_SIZE_BASES) {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      if (getNearestSupportedSizeForRatio(base.value, ratio) === normalized) {
        return {
          mode: "ratio" as ImageSizeMode,
          base: base.value,
          ratio: ratio.value,
          customRatio: ratio.value,
          mixWebFirst: value.mixWebFirst,
        };
      }
    }
  }

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(value.width, value.height) || 1;
  return {
    mode: "custom" as ImageSizeMode,
    base: "1k" as ImageSizeBase,
    ratio: "1:1" as ImageAspectRatio,
    customRatio: `${Math.round(value.width / divisor)}:${Math.round(
      value.height / divisor
    )}`,
    mixWebFirst: value.mixWebFirst,
  };
}

type ChatStreamState = {
  messageId?: string;
  cardId?: string;
  mode?: "chat" | "agent";
  text: string;
  thinking: string;
  agent: string;
  agentEvents: AgentRunEvent[];
  imageUrl?: string;
  generationId?: string;
  prompt?: string;
  model?: string;
  size?: string;
};

function createInitialChatStreamState(params: {
  messageId?: string;
  cardId?: string;
  mode?: "chat" | "agent";
  agentMode: boolean;
  generationId?: string;
  prompt?: string;
  model?: string;
  size?: string;
}): ChatStreamState {
  return {
    messageId: params.messageId,
    cardId: params.cardId,
    mode: params.mode,
    text: "",
    thinking: "",
    agent: "",
    agentEvents: params.agentMode ? createOptimisticAgentRoundEvents(1) : [],
    generationId: params.generationId,
    prompt: params.prompt,
    model: params.model,
    size: params.size,
  };
}

type ChatModel = (typeof RESPONSES_IMAGE_MODELS)[number];
type ChatThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";
type TextGenerationMode = "single" | "lines";

type BatchCard = {
  id: string;
  state: "loading" | "image" | "text" | "error";
  aspectRatio: string;
  prompt: string;
  size: string;
  streamText?: string;
  streamThinking?: string;
  streamAgent?: string;
  imageUrl?: string;
  generationId?: string;
  text?: string;
  error?: string;
  model?: string;
  creditsConsumed?: number;
  saved?: boolean;
};

type WaterfallStats = {
  sent: number;
  success: number;
  failed: number;
};

type MaskPoint = {
  x: number;
  y: number;
  size: number;
};

type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
type ImageModeration = "auto" | "low";
type ImageOutputFormat = "png" | "jpeg" | "webp";
type ImageBackground = "auto" | "opaque" | "transparent";
type ImageSizeMode = "auto" | "ratio" | "custom";
type ImageSizeBase = "1k" | "2k" | "4k";
type ImageAspectRatio =
  | "1:1"
  | "3:2"
  | "2:3"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "21:9";

type ActiveMode =
  | "text"
  | "image"
  | "chat"
  | "chat-web"
  | "agent"
  | "waterfall"
  | "video";
type ReferenceTargetMode = Extract<ActiveMode, ReferenceHandoffMode>;
type VisualOutputMode = "text-single" | "text-lines" | "image";

type BackendGroupOption = {
  id: string;
  name: string;
  isDefault: boolean;
  backendType: ImageBackendGroupBackendType;
  contentSafetyEnabled: boolean | null;
  billingMultiplier: number;
  childGroupIds: string[];
};

const defaultDimensions = parseImageSize(DEFAULT_IMAGE_SIZE) || {
  width: 1024,
  height: 1024,
};

function SizeRatioIcon({
  ratio,
}: {
  ratio: { width: number; height: number };
}) {
  const landscape = ratio.width >= ratio.height;
  const width = landscape ? 18 : 12;
  const height = landscape ? 10 : 18;
  if (ratio.width === ratio.height) {
    return (
      <span className="h-5 w-5 rounded-[3px] border border-current opacity-60" />
    );
  }
  return (
    <span
      className="rounded-[3px] border border-current opacity-60"
      style={{ width, height }}
    />
  );
}

function ImageSizeDialog({
  open,
  onOpenChange,
  value,
  onConfirm,
  title,
  copy,
  validationMessage,
  showMixRouting,
  mixRoutingPixelRange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ImageSizeDialogValue;
  onConfirm: (value: ImageSizeDialogValue) => void;
  title: string;
  copy: (en: string, zh: string) => string;
  validationMessage: (message?: string) => string | undefined;
  showMixRouting?: boolean;
  mixRoutingPixelRange?: ForceWebPixelRange;
}) {
  const initial = inferImageSizeDialogState(value);
  const [mode, setMode] = useState<ImageSizeMode>(initial.mode);
  const [base, setBase] = useState<ImageSizeBase>(initial.base);
  const [ratio, setRatio] = useState<ImageAspectRatio>(initial.ratio);
  const [customRatio, setCustomRatio] = useState(initial.customRatio);
  const [customRatioOpen, setCustomRatioOpen] = useState(false);
  const [customWidth, setCustomWidth] = useState(value.width);
  const [customHeight, setCustomHeight] = useState(value.height);
  const [mixWebFirst, setMixWebFirst] = useState(value.mixWebFirst);

  useEffect(() => {
    if (!open) return;
    const next = inferImageSizeDialogState(value);
    setMode(next.mode);
    setBase(next.base);
    setRatio(next.ratio);
    setCustomRatio(next.customRatio);
    setCustomRatioOpen(false);
    setCustomWidth(value.width);
    setCustomHeight(value.height);
    setMixWebFirst(value.mixWebFirst);
  }, [open, value.auto, value.width, value.height, value.mixWebFirst]);

  const selectedRatio =
    IMAGE_ASPECT_RATIOS.find((item) => item.value === ratio) ||
    IMAGE_ASPECT_RATIOS[0]!;
  const customRatioValue = parseAspectRatioInput(customRatio);
  const activeRatio =
    mode === "ratio" && customRatioOpen && customRatioValue
      ? customRatioValue
      : selectedRatio;
  const ratioSize =
    mode === "ratio"
      ? getNearestSupportedSizeForRatio(base, activeRatio)
      : getNearestSupportedSizeForRatio(base, selectedRatio);
  const normalizedCustomSize = normalizeValidImageSize({
    width: customWidth,
    height: customHeight,
  });
  const previewSize =
    mode === "auto"
      ? AUTO_IMAGE_SIZE
      : mode === "custom"
        ? normalizedCustomSize
        : ratioSize;
  const previewCheck = validateImageSize(previewSize);
  const mixRoutingAvailable = Boolean(
    showMixRouting &&
      isMixWebFirstAvailableForSize(previewSize, mixRoutingPixelRange)
  );
  const mixRoutingRangeLabel = formatPixelRange(mixRoutingPixelRange);
  const effectiveMixWebFirst = mixRoutingAvailable && mixWebFirst;
  const canConfirm =
    mode === "auto" ||
    (mode === "custom"
      ? previewCheck.valid
      : previewCheck.valid && (!customRatioOpen || Boolean(customRatioValue)));

  const apply = () => {
    if (!canConfirm) return;
    if (mode === "auto") {
      onConfirm({
        auto: true,
        width: value.width,
        height: value.height,
        mixWebFirst: effectiveMixWebFirst,
      });
      onOpenChange(false);
      return;
    }
    const size = mode === "custom" ? normalizedCustomSize : ratioSize;
    const dimensions = parseImageSize(size);
    if (!dimensions) return;
    onConfirm({
      auto: false,
      width: dimensions.width,
      height: dimensions.height,
      mixWebFirst: effectiveMixWebFirst,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-md gap-0 overflow-y-auto rounded-3xl border-border p-0"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="space-y-6 p-6">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {copy("Current", "当前")}：{" "}
              {value.auto
                ? "auto"
                : normalizeImageSize(value.width, value.height)}
            </p>
          </div>

          <div className="grid grid-cols-3 rounded-xl bg-muted p-1">
            {[
              { value: "auto" as ImageSizeMode, label: copy("Auto", "自动") },
              {
                value: "ratio" as ImageSizeMode,
                label: copy("Ratio", "按比例"),
              },
              {
                value: "custom" as ImageSizeMode,
                label: copy("Custom", "自定义宽高"),
              },
            ].map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                className={`h-9 rounded-lg text-sm font-medium transition ${
                  mode === item.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {mode !== "auto" && (
            <>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {copy("Base resolution", "基准分辨率")}
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {IMAGE_SIZE_BASES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setBase(item.value)}
                      className={`h-10 rounded-xl border text-sm font-medium transition ${
                        base === item.value
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </section>

              {mode === "ratio" && (
                <section className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {copy("Aspect ratio", "图像比例")}
                  </h3>
                  <div className="grid grid-cols-4 gap-2">
                    {IMAGE_ASPECT_RATIOS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => {
                          setRatio(item.value);
                          setCustomRatio(item.value);
                          setCustomRatioOpen(false);
                        }}
                        className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs transition ${
                          ratio === item.value
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <SizeRatioIcon ratio={item} />
                        <span>{item.value}</span>
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCustomRatioOpen(true)}
                    className="w-full border-primary text-primary hover:bg-primary/5 hover:text-primary"
                  >
                    {copy("Custom ratio", "自定义比例")}
                  </Button>
                  {customRatioOpen && (
                    <div className="space-y-2 rounded-xl border border-border bg-background p-3">
                      <label
                        htmlFor="create-custom-ratio"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {copy("Custom ratio", "输入自定义比例")}
                      </label>
                      <Input
                        id="create-custom-ratio"
                        value={customRatio}
                        onChange={(event) => setCustomRatio(event.target.value)}
                        placeholder="16:9"
                      />
                      {!customRatioValue && (
                        <p className="text-xs text-destructive">
                          {copy(
                            "Use a ratio like 16:9.",
                            "请使用类似 16:9 的比例。"
                          )}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}

              {mode === "custom" && (
                <section className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {copy("Custom size", "输入自定义宽高")}
                  </h3>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="create-custom-width"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {copy("Width", "宽度")}
                      </label>
                      <Input
                        id="create-custom-width"
                        type="number"
                        min={256}
                        max={MAX_IMAGE_DIMENSION}
                        step={IMAGE_DIMENSION_STEP}
                        value={customWidth}
                        onChange={(event) =>
                          setCustomWidth(Number(event.target.value) || 0)
                        }
                      />
                    </div>
                    <div className="pb-2 text-muted-foreground">x</div>
                    <div className="space-y-1.5">
                      <label
                        htmlFor="create-custom-height"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {copy("Height", "高度")}
                      </label>
                      <Input
                        id="create-custom-height"
                        type="number"
                        min={256}
                        max={MAX_IMAGE_DIMENSION}
                        step={IMAGE_DIMENSION_STEP}
                        value={customHeight}
                        onChange={(event) =>
                          setCustomHeight(Number(event.target.value) || 0)
                        }
                      />
                    </div>
                  </div>
                </section>
              )}
            </>
          )}

          <div className="rounded-2xl bg-muted/30 p-4">
            <p className="text-xs font-medium text-muted-foreground">
              {copy("Will use", "将使用")}
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">
              {previewSize === AUTO_IMAGE_SIZE
                ? "auto"
                : previewSize.replace("x", "×")}
            </p>
            {!previewCheck.valid && (
              <p className="mt-2 text-xs text-destructive">
                {validationMessage(previewCheck.message)}
              </p>
            )}
            {mode === "ratio" && customRatioOpen && !customRatioValue && (
              <p className="mt-2 text-xs text-destructive">
                {copy("Use a ratio like 16:9.", "请使用类似 16:9 的比例。")}
              </p>
            )}
          </div>

          <div className="flex gap-3 rounded-2xl border border-border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              {copy(
                "Due to model constraints, the final output is automatically adjusted to a valid size: width and height are multiples of 16, the maximum edge is 3840px, aspect ratio is no more than 3:1, and total pixels are between 655,360 and 8,294,400.",
                "由于模型限制，最终输出会自动规整到合法尺寸：宽高均为 16 的倍数，最大边长 3840px，宽高比不超过 3:1，总像素限制为 655360-8294400。"
              )}
            </p>
          </div>

          {showMixRouting && (
            <label
              htmlFor="create-mix-web-first"
              className={`flex items-start gap-3 rounded-2xl border border-border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground ${
                mixRoutingAvailable ? "cursor-pointer" : "cursor-not-allowed"
              }`}
            >
              <Checkbox
                id="create-mix-web-first"
                checked={effectiveMixWebFirst}
                onCheckedChange={(checked) => setMixWebFirst(checked === true)}
                disabled={!mixRoutingAvailable}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {copy(
                    "Mixed group Web-first routing",
                    "混合分组优先走 Web"
                  )}
                </span>
                <span className="mt-1 block">
                  {copy(
                    `When the active backend group is mixed and the selected size is within the configured Web-first pixel range (${mixRoutingRangeLabel}), try all available Web accounts first; if they fail or are exhausted, fall back to Codex/Responses accounts. Web does not support exact resolution, image model, quality, output format, or OAI moderation controls, so unrelated controls are disabled while this is enabled.`,
                    `当前后端分组为混合分组且选择尺寸处于后台配置的 Web-first 像素区间（${mixRoutingRangeLabel}）时，会优先遍历所有可用 Web 账号；失败或耗尽后再回退到 Codex/Responses 账号。Web 不支持精确分辨率、图片模型、质量、输出格式、OAI 审核等控制，因此开启后无关选项会置灰。`
                  )}
                </span>
                {!mixRoutingAvailable && (
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {copy(
                      `Available only when the selected size is within ${mixRoutingRangeLabel}.`,
                      `仅在当前尺寸处于 ${mixRoutingRangeLabel} 区间时可用。`
                    )}
                  </span>
                )}
              </span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              className="h-10 rounded-xl"
            >
              {copy("Cancel", "取消")}
            </Button>
            <Button
              type="button"
              onClick={apply}
              disabled={!canConfirm}
              className="h-10 rounded-xl"
            >
              {copy("Confirm", "确定")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const shouldBypassImageOptimization = (imageUrl: string | undefined) =>
  Boolean(imageUrl);

// 列表/缩略图场景:把同源存储图(/api/storage)改走 /w<width>/ 路径段缩略图。
// WHY:这些位置常以很小尺寸展示(最近面板 80px、变体 40px),但原本直接加载全分辨率原图
// (单张可达 1.3MB),一屏多图严重拖卡前端;next/image 优化器对带签名 query 的本地图会 400,
// 故沿用全站既有方案——直连 /w/ 路径段缩略图(CF/磁盘可缓存),非存储图原样返回。
const thumbSrc = (
  imageUrl: string | null | undefined,
  width: number
): string => buildStorageThumbnailUrl(imageUrl, width) || imageUrl || "";

const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_EDIT_REQUEST_BYTES = 75 * 1024 * 1024;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const CHAT_FILE_ACCEPT =
  ".txt,.md,.markdown,.csv,.json,.jsonl,.yaml,.yml,.log,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.java,.go,.rs,.c,.cc,.cpp,.h,.hpp,.sql,.sh,.toml,.ini,.env,.pdf,text/*,application/json,application/xml,application/pdf";
const CHAT_ATTACHMENT_ACCEPT = `${IMAGE_ACCEPT},${CHAT_FILE_ACCEPT}`;
// Adobe Firefly 模型族（按前缀自动路由到 adobe 后端；尺寸由后端按宽高比/分辨率映射）。
// 选中 Firefly 模型时创作页隐藏 gpt 专属选项、改用 Firefly 宽高比预设。
const FIREFLY_MODEL_OPTIONS = [
  { value: "firefly-nano-banana-pro", label: "Firefly · Nano Banana Pro" },
  { value: "firefly-nano-banana", label: "Firefly · Nano Banana" },
  { value: "firefly-nano-banana2", label: "Firefly · Nano Banana 2" },
  { value: "firefly-gpt-image-2", label: "Firefly · GPT Image 2" },
  { value: "firefly-gpt-image-1.5", label: "Firefly · GPT Image 1.5" },
] as const;
const TEXT_MODEL_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { value: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { value: "gpt-image-2", label: "GPT Image 2" },
  { value: "gpt-image-1.5", label: "GPT Image 1.5" },
  { value: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
  ...FIREFLY_MODEL_OPTIONS,
] as const;
// 对话生图/Agent 不提供 firefly:它走 Codex/Responses,与 Adobe 直连不兼容,服务端也会拒收
// (见 /api/images/chat)。故 chat 图像模型下拉用去掉 firefly 的子集。
const CHAT_IMAGE_MODEL_OPTIONS = TEXT_MODEL_OPTIONS.filter(
  (option) => !option.value.startsWith("firefly-")
);
const EDIT_MODEL_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { value: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { value: "gpt-image-2", label: "GPT Image 2" },
  { value: "gpt-image-1.5", label: "GPT Image 1.5" },
  { value: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
  ...FIREFLY_MODEL_OPTIONS,
] as const;

const QUALITY_OPTIONS: Array<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  // gpt-image-2.5 系列（sunburst/flare）新增档位。
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];
const MODERATION_OPTIONS: Array<{ value: ImageModeration; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
];
const OUTPUT_FORMAT_OPTIONS: Array<{
  value: ImageOutputFormat;
  label: string;
}> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];
const BACKGROUND_OPTIONS: Array<{
  value: ImageBackground;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "opaque", label: "Opaque" },
  { value: "transparent", label: "Transparent" },
];
const IMAGE_SIZE_BASES: Array<{
  value: ImageSizeBase;
  label: string;
  edge: number;
}> = [
  { value: "1k", label: "1K", edge: IMAGE_1K_BASE_EDGE },
  { value: "2k", label: "2K", edge: 2048 },
  { value: "4k", label: "4K", edge: 3840 },
];
const IMAGE_ASPECT_RATIOS: Array<{
  value: ImageAspectRatio;
  width: number;
  height: number;
}> = [
  { value: "1:1", width: 1, height: 1 },
  { value: "3:2", width: 3, height: 2 },
  { value: "2:3", width: 2, height: 3 },
  { value: "16:9", width: 16, height: 9 },
  { value: "9:16", width: 9, height: 16 },
  { value: "4:3", width: 4, height: 3 },
  { value: "3:4", width: 3, height: 4 },
  { value: "21:9", width: 21, height: 9 },
];
// 瀑布流每批并发预设(对齐原项目 TIER_PRESETS)：tier 决定每批生成张数。
// 运行时按套餐 imageGenerationConcurrency(单用户并发上限)过滤可选项。
const WATERFALL_TIER_PRESETS = [1, 5, 10, 20] as const;
const DEFAULT_WATERFALL_TIER = 5;
// 单批最大并发 = tier * 该倍数(再与套餐并发上限取 min 兜底)，对齐原项目 maxConcurrent = tier * 3。
const WATERFALL_CONCURRENCY_MULTIPLIER = 3;

// 数字输入 + 鼠标滚轮增减的"数量/并发"控件(issue #16)。
// max = 套餐生图并发 imageGenerationConcurrency(可达 1000+)，下拉框无法承载，故改数字输入。
// 滚轮：用包裹层的非被动监听 preventDefault，仅在悬停于控件上时增减，避免连带滚动页面。
// 取值始终钳制到 [1, max]；越界输入(含空值)归一到 1。
function ConcurrencyNumberInput({
  id,
  value,
  max,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || disabled) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1 : -1;
      onChange(Math.min(max, Math.max(1, Math.floor(value + delta))));
    };
    // 非被动监听，确保可 preventDefault 阻止页面滚动
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [value, max, disabled, onChange]);
  return (
    <div ref={wrapperRef} className="w-full">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            Math.min(max, Math.max(1, Math.floor(Number(event.target.value) || 1)))
          )
        }
        className="w-full"
      />
    </div>
  );
}
const CHAT_MODEL_OPTIONS: Array<{
  value: ChatModel;
  label: string;
  ultraOnly?: boolean;
}> = [
  { value: GPT54_CHAT_MODEL, label: "GPT-5.4" },
  { value: GPT54_MINI_CHAT_MODEL, label: "GPT-5.4 Mini" },
  { value: GPT52_CHAT_MODEL, label: "GPT-5.2" },
  { value: GPT53_CODEX_CHAT_MODEL, label: "GPT-5.3 Codex" },
  { value: GPT53_CODEX_SPARK_CHAT_MODEL, label: "GPT-5.3 Codex Spark" },
  { value: GPT55_CHAT_MODEL, label: "GPT-5.5", ultraOnly: true },
];
const CHAT_THINKING_OPTIONS: Array<{
  value: ChatThinkingLevel;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "xHigh" },
  { value: "none", label: "None" },
];
const WATERFALL_ASPECT_RATIOS = ["1 / 1", "3 / 4", "4 / 3", "2 / 3"] as const;
const CHAT_SUGGESTIONS = [
  "A serene mountain lake at sunset, oil painting",
  "Minimalist logo for a tech startup",
  "Cyberpunk city street in the rain, neon lights",
  "Watercolor portrait of a cat wearing glasses",
] as const;
const CHAT_SUGGESTIONS_ZH = [
  "日落时宁静的山间湖泊，油画风格",
  "科技创业公司的极简标志",
  "雨夜霓虹灯下的赛博朋克城市街道",
  "戴眼镜的猫咪水彩肖像",
] as const;
const CHAT_STORAGE_KEY = "gpt2image_chat_messages_v1";
const CHAT_CONVERSATIONS_STORAGE_KEY = "gpt2image_chat_conversations_v1";
const CHAT_ACTIVE_CONVERSATION_STORAGE_KEY =
  "gpt2image_active_chat_conversation_v1";
const CHAT_ACTIVE_AGENT_CONVERSATION_STORAGE_KEY =
  "gpt2image_active_agent_conversation_v1";
const CREATE_ACTIVE_MODE_STORAGE_KEY = "gpt2image_create_active_mode_v1";
const CHAT_CONTEXT_MESSAGE_LIMIT = 8;
const CHAT_CONVERSATION_LIMIT = 30;
/**
 * 会话持久化去抖窗口(毫秒)。流式生成期 chatMessages 每个增量都变,
 * 若每次都同步 JSON.stringify 全部会话并写 localStorage 会逐 token 阻塞
 * 主线程;取尾沿去抖,回合结束或停顿时才真正落库。
 */
const CHAT_PERSIST_DEBOUNCE_MS = 300;
const PROMPT_IMAGE_REFERENCE_PATTERN = /@(?:第)?\d+轮图\d+|@图\d+/;

function readStoredCreateActiveMode(): ActiveMode {
  if (typeof window === "undefined") return "text";
  try {
    const value = window.localStorage.getItem(CREATE_ACTIVE_MODE_STORAGE_KEY);
    // 白名单须与 ActiveMode 全量同步,漏项会导致该模式刷新后回落 text
    return value === "text" ||
      value === "image" ||
      value === "chat" ||
      value === "chat-web" ||
      value === "agent" ||
      value === "waterfall" ||
      value === "video"
      ? value
      : "text";
  } catch {
    return "text";
  }
}

interface CreatePageClientProps {
  balance: number;
  recentGenerations: RecentGeneration[];
  plan: SubscriptionPlan;
  capabilities: PlanCapabilitySnapshot;
  uploadLimits: {
    maxFileSizeBytes: number;
    maxUploadBytes: number;
  };
  backendGroups: BackendGroupOption[];
  selectedBackendGroupId: string | null;
  customApiActive: boolean;
  moderationEnabled: boolean;
  imageBasePricing: ImageBaseCreditPricing;
  forceWebPixelRange: ForceWebPixelRange;
  timeZone: string;
  videoPricing: VideoPricingInfo;
}

function isImageFile(file: File) {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.type);
}

function isReadableChatFile(file: File) {
  const type = file.type.toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type === "application/pdf") return true;
  if (
    [
      "application/json",
      "application/jsonl",
      "application/ld+json",
      "application/xml",
      "application/x-yaml",
      "application/yaml",
    ].includes(type)
  ) {
    return true;
  }
  return /\.(txt|md|markdown|csv|json|jsonl|ya?ml|log|xml|html?|css|jsx?|tsx?|mjs|cjs|py|java|go|rs|c|cc|cpp|h|hpp|sql|sh|toml|ini|env|pdf)$/i.test(
    file.name
  );
}

function revokePreview(url: string) {
  if (url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function formatMegabytes(bytes: number) {
  return `${Math.ceil(bytes / 1024 / 1024)}MB`;
}

function imageStreamEventToPreviewUrl(event: ImageStreamEvent) {
  if (event.type !== "partial_image") return null;
  if (event.b64_json) return `data:image/png;base64,${event.b64_json}`;
  return event.url || null;
}

function sanitizeAgentEventsForStorage(events: AgentRunEvent[] | undefined) {
  return (events || []).map((event) => {
    const normalized = normalizeAgentEvent(event);
    if (normalized.imageUrl?.startsWith("data:image/")) {
      return { ...normalized, imageUrl: undefined };
    }
    return normalized;
  });
}

function createLocalId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneFile(file: File) {
  return new File([file], file.name, { type: file.type });
}

function hasPromptImageReference(text: string) {
  return PROMPT_IMAGE_REFERENCE_PATTERN.test(text);
}

type PromptTextareaFieldProps = Omit<
  React.ComponentProps<typeof Textarea>,
  "value" | "onChange" | "defaultValue"
> & {
  /** runtime store 里的提示词 key(如 "chatPrompt")。 */
  promptKey: string;
  /** 键入回调(新值, 光标位置),用于 mention 触发检测;不要在此做重活。 */
  onValueChange?: (next: string, selectionStart: number) => void;
  /** 转发给内部 textarea 的 ref(mention 插入后恢复焦点/光标用)。 */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
};

/**
 * 提示词输入框:独立订阅 runtime store 的 promptKey,把"每次击键"的重渲
 * 限制在本小组件内。
 *
 * WHY:CreatePageClient 是近万行单组件,输入框若由它受控,每个字符都会
 * 重建整棵创作页 JSX(实测打字卡的主因之一)。下沉后父组件改用
 * useCreateRuntimeAccessor 非订阅读写,任何一方写 promptKey(键入、发送后
 * 清空、mention 插入)都经同一 store 汇合,不存在双份状态。
 *
 * 同时单点维护两个派生布尔 key(`${promptKey}HasText` / `${promptKey}HasRef`),
 * 供父组件的发送按钮 disabled 与"@ 引用路由提示"订阅——它们只在翻转时
 * 变化(store 的 Object.is 短路),父组件不会因逐字输入而重渲。
 */
function PromptTextareaField({
  promptKey,
  onValueChange,
  textareaRef,
  ...textareaProps
}: PromptTextareaFieldProps) {
  const [value, setValue] = useCreateRuntimeState<string>(promptKey, "");
  const [, setHasText] = useCreateRuntimeAccessor<boolean>(
    `${promptKey}HasText`,
    false
  );
  const [, setHasRef] = useCreateRuntimeAccessor<boolean>(
    `${promptKey}HasRef`,
    false
  );
  // 派生布尔的唯一收口:父组件各处 setter(清空/插入 mention)也会经
  // 本订阅回流到这里,不需要在每个写入点重复同步。
  useEffect(() => {
    setHasText(Boolean(value.trim()));
    setHasRef(hasPromptImageReference(value));
  }, [setHasRef, setHasText, value]);
  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        onValueChange?.(next, event.target.selectionStart ?? next.length);
      }}
      {...textareaProps}
    />
  );
}

function getMentionTrigger(text: string, cursor: number): MentionState | null {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const token = match[0].trimStart();
  return {
    open: true,
    start: cursor - token.length,
    end: cursor,
    query: match[2] || "",
  };
}

function filterMentionOptions(
  options: ImageReferenceMentionOption[],
  query: string
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((option) =>
    `${option.token} ${option.label} ${option.detail}`
      .toLowerCase()
      .includes(normalized)
  );
}

function insertMentionToken(
  text: string,
  mention: MentionState,
  token: string
) {
  return `${text.slice(0, mention.start)}${token} ${text.slice(mention.end)}`;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function getCursorAfterInsertedMention(mention: MentionState, token: string) {
  return mention.start + token.length + 1;
}

function createGenerationId() {
  return nanoid();
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function responseTextSnippet(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 240)}...`;
}

function responseStatusLabel(response: Response) {
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

function nonJsonResponseError(response: Response, text: string) {
  const snippet = responseTextSnippet(text);
  const status = responseStatusLabel(response);
  if (!snippet) {
    return response.ok
      ? "API returned an empty response"
      : `API returned ${status} with an empty response`;
  }
  return response.ok
    ? `API returned a non-JSON response: ${snippet}`
    : `API returned ${status}: ${snippet}`;
}

async function readImageApiJsonResponse(
  response: Response
): Promise<ImageApiResult> {
  const text = await response.text();
  if (!text.trim()) {
    return { error: nonJsonResponseError(response, text) };
  }

  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object") {
      return data as ImageApiResult;
    }
    return { error: `API returned invalid JSON: ${responseTextSnippet(text)}` };
  } catch {
    return { error: nonJsonResponseError(response, text) };
  }
}

function sanitizeChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Partial<ChatMessage>;
    if (item.role !== "user" && item.role !== "assistant") return [];
    if (typeof item.text !== "string") return [];
    const messageText = item.text;
    const variants = Array.isArray(item.variants)
      ? item.variants.flatMap((variant) => {
          if (!variant || typeof variant !== "object") return [];
          const value = variant as Partial<ChatVariant>;
          const webConversation =
            value.webConversation &&
            typeof value.webConversation === "object" &&
            typeof value.webConversation.conversationId === "string" &&
            typeof value.webConversation.parentMessageId === "string"
              ? {
                  conversationId: value.webConversation.conversationId,
                  parentMessageId: value.webConversation.parentMessageId,
                  accountId:
                    typeof value.webConversation.accountId === "string"
                      ? value.webConversation.accountId
                      : undefined,
                  apiKeyId:
                    typeof value.webConversation.apiKeyId === "string"
                      ? value.webConversation.apiKeyId
                      : undefined,
                  selectionMessageId:
                    typeof value.webConversation.selectionMessageId === "string"
                      ? value.webConversation.selectionMessageId
                      : undefined,
                  selectedImageMessageId:
                    typeof value.webConversation.selectedImageMessageId ===
                    "string"
                      ? value.webConversation.selectedImageMessageId
                      : undefined,
                }
              : undefined;
          const backendMember =
            value.backendMember &&
            typeof value.backendMember === "object" &&
            (value.backendMember.type === "api" ||
              value.backendMember.type === "account") &&
            typeof value.backendMember.id === "string"
              ? {
                  type: value.backendMember.type,
                  id: value.backendMember.id,
                  groupId:
                    typeof value.backendMember.groupId === "string"
                      ? value.backendMember.groupId
                      : value.backendMember.groupId === null
                        ? null
                        : undefined,
                  accountBackend:
                    value.backendMember.accountBackend === "web" ||
                    value.backendMember.accountBackend === "responses"
                      ? value.backendMember.accountBackend
                      : undefined,
                }
              : undefined;
          const responsesBackendMember =
            value.responsesPreviousResponse?.backendMember &&
            typeof value.responsesPreviousResponse.backendMember === "object" &&
            (value.responsesPreviousResponse.backendMember.type === "api" ||
              value.responsesPreviousResponse.backendMember.type ===
                "account") &&
            typeof value.responsesPreviousResponse.backendMember.id === "string"
              ? {
                  type: value.responsesPreviousResponse.backendMember.type,
                  id: value.responsesPreviousResponse.backendMember.id,
                  groupId:
                    typeof value.responsesPreviousResponse.backendMember
                      .groupId === "string"
                      ? value.responsesPreviousResponse.backendMember.groupId
                      : value.responsesPreviousResponse.backendMember
                            .groupId === null
                        ? null
                        : undefined,
                  accountBackend:
                    value.responsesPreviousResponse.backendMember
                      .accountBackend === "web" ||
                    value.responsesPreviousResponse.backendMember
                      .accountBackend === "responses"
                      ? value.responsesPreviousResponse.backendMember
                          .accountBackend
                      : undefined,
                }
              : undefined;
          const responsesPreviousResponse =
            value.responsesPreviousResponse &&
            typeof value.responsesPreviousResponse === "object" &&
            typeof value.responsesPreviousResponse.responseId === "string" &&
            responsesBackendMember
              ? {
                  responseId: value.responsesPreviousResponse.responseId,
                  backendMember: responsesBackendMember,
                  store: true as const,
                  createdAt:
                    typeof value.responsesPreviousResponse.createdAt ===
                    "string"
                      ? value.responsesPreviousResponse.createdAt
                      : undefined,
                }
              : undefined;
          return [
            {
              ...value,
              prompt: value.prompt || messageText,
              model: value.model || DEFAULT_IMAGE_MODEL,
              size: value.size || DEFAULT_IMAGE_SIZE,
              pending: value.pending === true,
              agentEvents: Array.isArray(value.agentEvents)
                ? value.agentEvents
                    .filter((event): event is AgentRunEvent =>
                      Boolean(
                        event &&
                          typeof event === "object" &&
                          typeof event.title === "string"
                      )
                    )
                    .map(normalizeAgentEvent)
                : undefined,
              webConversation,
              backendMember,
              responsesPreviousResponse,
              outputRole:
                value.outputRole === "agent_draft" ||
                value.outputRole === "choice" ||
                value.outputRole === "final"
                  ? value.outputRole
                  : undefined,
            },
          ];
        })
      : undefined;
    return [
      {
        id: typeof item.id === "string" ? item.id : createLocalId(),
        role: item.role,
        text: messageText,
        mode:
          item.mode === "agent" ||
          item.mode === "chat" ||
          item.mode === "web"
            ? item.mode
            : undefined,
        attachments: item.attachments,
        variants,
        activeVariant: item.activeVariant,
        error: item.error,
        createdAt:
          typeof item.createdAt === "string"
            ? item.createdAt
            : new Date().toISOString(),
      },
    ];
  });
}

function sanitizePersistedChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-80).map((message) => ({
    ...message,
    attachments: message.attachments?.filter(
      (attachment) => !attachment.previewUrl?.startsWith("blob:")
    ),
    variants: message.variants?.map((variant) => ({
      ...variant,
      agentEvents: sanitizeAgentEventsForStorage(variant.agentEvents),
    })),
  }));
}

function createChatConversation(
  messages: ChatMessage[],
  title: string,
  id = createLocalId(),
  mode: ConversationMode = inferChatConversationMode(messages)
): ChatConversation {
  const now = new Date().toISOString();
  return {
    id,
    mode,
    title,
    messages,
    createdAt: now,
    updatedAt: now,
  };
}

function inferChatConversationMode(messages: ChatMessage[]): ConversationMode {
  if (messages.some((message) => message.mode === "agent")) return "agent";
  if (messages.some((message) => message.mode === "web")) return "web";
  return "chat";
}

function chatActiveConversationStorageKey(mode: ConversationMode) {
  return mode === "agent"
    ? CHAT_ACTIVE_AGENT_CONVERSATION_STORAGE_KEY
    : CHAT_ACTIVE_CONVERSATION_STORAGE_KEY;
}

function activeModeToConversationMode(mode: ActiveMode): ConversationMode {
  return mode === "agent" ? "agent" : mode === "chat-web" ? "web" : "chat";
}

function sanitizeChatConversations(value: unknown): ChatConversation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((conversation) => {
    if (!conversation || typeof conversation !== "object") return [];
    const item = conversation as Partial<ChatConversation>;
    const messages = sanitizeChatMessages(item.messages);
    if (messages.length === 0) return [];
    const now = new Date().toISOString();
    const baseId = typeof item.id === "string" ? item.id : createLocalId();
    const storedMode: ConversationMode | null =
      item.mode === "agent"
        ? "agent"
        : item.mode === "web"
          ? "web"
          : item.mode === "chat"
            ? "chat"
            : null;
    const storedTitle =
      typeof item.title === "string" && item.title.trim()
        ? item.title
        : "Untitled chat";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt : now;
    const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : now;
    const modeBuckets: Array<{
      mode: ConversationMode;
      messages: ChatMessage[];
    }> = [
      {
        mode: "chat",
        messages: messages.filter(
          (message) => message.mode !== "agent" && message.mode !== "web"
        ),
      },
      {
        mode: "agent",
        messages: messages.filter((message) => message.mode === "agent"),
      },
      {
        mode: "web",
        messages: messages.filter((message) => message.mode === "web"),
      },
    ];
    const byMode = modeBuckets.filter((entry) => entry.messages.length > 0);

    const entries: Array<{ mode: ConversationMode; messages: ChatMessage[] }> =
      byMode.length > 1
        ? byMode
        : [
            {
              mode: storedMode || inferChatConversationMode(messages),
              messages,
            },
          ];

    return entries.map((entry) => ({
      id:
        entries.length > 1 && storedMode !== entry.mode
          ? `${baseId}:${entry.mode}`
          : baseId,
      mode: entry.mode,
      title: getChatConversationTitle(entry.messages, storedTitle),
      messages: entry.messages,
      createdAt,
      updatedAt,
    }));
  });
}

function getChatMessageSignature(message: ChatMessage) {
  return `${message.role}\u0000${message.id}\u0000${message.text}`;
}

function isConversationSnapshotOf(
  candidate: ChatConversation,
  target: ChatConversation
) {
  if (candidate.mode !== target.mode) return false;
  if (candidate.id === target.id) return true;
  if (candidate.messages.length > target.messages.length) return false;
  return candidate.messages.every(
    (message, index) =>
      getChatMessageSignature(message) ===
      getChatMessageSignature(target.messages[index] as ChatMessage)
  );
}

function compactChatConversations(conversations: ChatConversation[]) {
  const byCompleteness = [...conversations].sort((a, b) => {
    const messageCountDelta = b.messages.length - a.messages.length;
    if (messageCountDelta !== 0) return messageCountDelta;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const compacted: ChatConversation[] = [];

  for (const conversation of byCompleteness) {
    if (
      compacted.some((existing) =>
        isConversationSnapshotOf(conversation, existing)
      )
    ) {
      continue;
    }
    compacted.push(conversation);
  }

  return compacted.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

function persistChatConversationSnapshot(params: {
  conversations: ChatConversation[];
  conversationId: string;
  mode: ConversationMode;
  messages: ChatMessage[];
  titleFallback: string;
}) {
  if (typeof window === "undefined" || params.messages.length === 0) return;
  try {
    const persistedMessages = sanitizePersistedChatMessages(params.messages);
    const title = getChatConversationTitle(
      persistedMessages.filter((message) =>
        params.mode === "agent"
          ? message.mode === "agent"
          : params.mode === "web"
            ? message.mode === "web"
            : message.mode !== "agent" && message.mode !== "web"
      ),
      params.titleFallback
    );
    const now = new Date().toISOString();
    const existing = params.conversations.find(
      (conversation) => conversation.id === params.conversationId
    );
    const current: ChatConversation = {
      id: params.conversationId,
      mode: existing?.mode || params.mode,
      title,
      messages: persistedMessages,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const nextConversations = compactChatConversations([
      current,
      ...params.conversations.filter(
        (conversation) => conversation.id !== params.conversationId
      ),
    ]).slice(0, CHAT_CONVERSATION_LIMIT);
    window.localStorage.setItem(
      CHAT_CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(nextConversations)
    );
    window.localStorage.setItem(
      chatActiveConversationStorageKey(current.mode),
      params.conversationId
    );
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    /* ignore local storage quota errors */
  }
}

function getChatConversationTitle(messages: ChatMessage[], fallback: string) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const title = firstUserMessage?.text.trim();
  if (!title) return fallback;
  return title.length > 48 ? `${title.slice(0, 48)}...` : title;
}

function getChatVariants(message: ChatMessage) {
  return message.variants || [];
}

function getActiveChatVariant(message: ChatMessage) {
  const variants = getChatVariants(message);
  return variants[message.activeVariant || 0] || variants[0] || null;
}

function mergeChatVariant(
  variant: ChatVariant | undefined,
  patch: Partial<ChatVariant>
): ChatVariant {
  return {
    prompt: variant?.prompt || patch.prompt || "",
    model: variant?.model || patch.model || DEFAULT_IMAGE_MODEL,
    size: variant?.size || patch.size || DEFAULT_IMAGE_SIZE,
    ...variant,
    ...patch,
  };
}

function replaceChatVariantByGenerationId(
  variants: ChatVariant[],
  generationId: string | undefined,
  replacements: ChatVariant[]
) {
  if (!generationId) return variants.length ? variants : replacements;
  const targetIndex = variants.findIndex(
    (variant) => variant.generationId === generationId
  );
  if (targetIndex < 0) return [...variants, ...replacements];
  return [
    ...variants.slice(0, targetIndex),
    ...replacements,
    ...variants.slice(targetIndex + 1),
  ];
}

function getMessageImageUrls(message: ChatMessage) {
  const urls: string[] = [];
  for (const attachment of message.attachments || []) {
    const url = attachment.previewUrl;
    if (
      url &&
      (url.startsWith("data:image/") ||
        url.startsWith("http://") ||
        url.startsWith("https://"))
    ) {
      urls.push(url);
    }
  }
  return urls;
}

function toChatHistory(messages: ChatMessage[]) {
  return messages
    .filter(
      (message) =>
        message.role === "user" ||
        (message.role === "assistant" && message.variants?.length)
    )
    .slice(-CHAT_CONTEXT_MESSAGE_LIMIT)
    .map((message) => ({
      role: message.role,
      text: message.text,
      imageUrls: message.role === "user" ? getMessageImageUrls(message) : [],
      variants: message.variants?.map((variant) => ({
        text:
          variant.responseText ||
          variant.responseAgent ||
          variant.revisedPrompt ||
          (variant.imageUrl
            ? `Generated an image at ${variant.size}: ${variant.imageUrl}`
            : undefined),
        imageUrl: variant.imageUrl,
        imageFileId: variant.imageFileId,
        webImageMessageId: variant.webImageMessageId,
        webImageGroupId: variant.webImageGroupId,
        size: variant.size,
        timestamp: variant.createdAt,
        webConversation: variant.webConversation,
        backendMember: variant.backendMember,
        responsesPreviousResponse: variant.responsesPreviousResponse,
      })),
      activeVariant: message.activeVariant || 0,
      error: message.error,
    }));
}

async function urlToEditImageFile(
  imageUrl: string,
  name: string,
  sourceId?: string
): Promise<EditImageFile> {
  const response = await fetch(normalizeReferenceFetchUrl(imageUrl));
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status}`);
  }

  const blob = await response.blob();
  const type = blob.type.startsWith("image/") ? blob.type : "image/png";
  const extension =
    type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  const file = new File([blob], `${name}.${extension}`, { type });
  return {
    file,
    previewUrl: URL.createObjectURL(file),
    sourceId,
  };
}

/** File → base64 data URL(chat(web) PPT/PSD 参考图需 data URL 传给 /api/editable-file/generate)。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** 读 createJsonKeepAliveResponse 响应:剥掉 keep-alive 填充,解析尾部 JSON。 */
async function readKeepAliveJson(response: Response): Promise<{
  error?: { message?: string };
  result?: { primary_url?: string; zip_url?: string | null };
  credits_charged?: number;
}> {
  const text = await response.text();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("空响应");
  return JSON.parse(text.slice(start));
}


export function CreatePageClient({
  balance: initialBalance,
  recentGenerations: initialRecent,
  capabilities,
  uploadLimits,
  backendGroups,
  selectedBackendGroupId,
  customApiActive,
  moderationEnabled,
  imageBasePricing,
  forceWebPixelRange,
  timeZone,
  videoPricing,
}: CreatePageClientProps) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isZh = locale === "zh";
  const copy = useCallback(
    (en: string, zh: string) => (isZh ? zh : en),
    [isZh]
  );
  const selectedBackendGroup =
    backendGroups.find((group) => group.id === selectedBackendGroupId) ||
    backendGroups.find((group) => group.isDefault) ||
    null;
  const getPricedImageCreditCost = (
    requestedSize?: string | null,
    options: Parameters<typeof getImageCreditCost>[1] = {}
  ) =>
    getImageCreditCost(requestedSize, {
      ...options,
      basePricing: imageBasePricing,
      quality: (options.quality ??
        quality) as ImageQualityLevel | undefined,
      thinking: (options.thinking ??
        chatThinking) as ImageThinkingLevel | undefined,
    });
  const activeBackendType = selectedBackendGroup?.backendType || "mixed";
  const isWebOnlyBackend = activeBackendType === "web";
  const showImageModelControls = !isWebOnlyBackend;
  const showThinkingControls = true;
  const showAgentProcessHint = !isWebOnlyBackend;
  const isConversationMode = (mode: ActiveMode) =>
    mode === "chat" ||
    mode === "agent" ||
    mode === "waterfall" ||
    mode === "chat-web";
  const getConversationMode = (mode: ActiveMode): ConversationMode =>
    activeModeToConversationMode(mode);
  // 会话消息归属:agent/web 各自独立;chat 桶收非 agent 非 web(含历史无 mode)。
  // WHY:chat-web 有独立会话历史(mode="web"),不能与 chat(codex) 串桶。
  const isMessageInConversationMode = (
    message: ChatMessage,
    mode: ConversationMode
  ) =>
    mode === "agent"
      ? message.mode === "agent"
      : mode === "web"
        ? message.mode === "web"
        : message.mode !== "agent" && message.mode !== "web";
  const batchCostSuffix = (count: number) =>
    count > 1
      ? copy(` for ${count}`, `，共 ${count} 张`)
      : copy("/image", "/张");
  const editModelLabel = (label: string) =>
    label === "Default" ? copy("Default", "默认") : label;
  const textModelLabel = (label: string) =>
    label === "Default" ? copy("Default", "默认") : label;
  const chatImageModelLabel = (label: string) =>
    label === "Default" ? copy("Default", "默认") : label;
  const qualityLabel = (qualityValue: ImageQuality) =>
    copy(
      QUALITY_OPTIONS.find((option) => option.value === qualityValue)?.label ||
        qualityValue,
      {
        auto: "自动",
        high: "高",
        low: "低",
        medium: "中",
        xhigh: "超高",
        max: "极致",
      }[qualityValue]
    );
  const moderationLabel = (moderationValue: ImageModeration) =>
    copy(
      MODERATION_OPTIONS.find((option) => option.value === moderationValue)
        ?.label || moderationValue,
      {
        auto: "自动",
        low: "低",
      }[moderationValue]
    );
  const outputFormatLabel = (format: ImageOutputFormat) =>
    OUTPUT_FORMAT_OPTIONS.find((option) => option.value === format)?.label ||
    format.toUpperCase();
  const backgroundLabel = (backgroundValue: ImageBackground) =>
    copy(
      BACKGROUND_OPTIONS.find((option) => option.value === backgroundValue)
        ?.label || backgroundValue,
      {
        auto: "自动",
        opaque: "不透明",
        transparent: "透明",
      }[backgroundValue]
    );
  const outputFormatHelpText = copy(
    "Controls the requested output file format for Codex/Responses and compatible API backends. Web backends may ignore it; stored files are still labeled by the actual detected format.",
    "指定 Codex/Responses 和兼容 API 后端的输出文件格式。Web 后端可能忽略；本站保存时仍会按实际识别到的格式标记。"
  );
  const backgroundHelpText = copy(
    "Requests transparent, opaque, or automatic background handling for Codex/Responses and compatible image APIs. Transparent output is only reliable with PNG/WebP and may be ignored by Web backends.",
    "为 Codex/Responses 和兼容 image API 请求透明、不透明或自动背景。透明输出仅在 PNG/WebP 下更可靠，Web 后端可能忽略。"
  );
  const outputCompressionHelpText = copy(
    "Only applies to JPEG/WebP. 0 is smallest file, 100 is highest quality.",
    "仅对 JPEG/WebP 生效。0 体积最小，100 质量最高。"
  );
  const thinkingLabel = (value: ChatThinkingLevel) =>
    copy(
      CHAT_THINKING_OPTIONS.find((option) => option.value === value)?.label ||
        value,
      {
        high: "高",
        low: "低",
        medium: "中",
        none: "无",
        xhigh: "极高",
      }[value]
    );
  const helpMarker = (label: string, title: string) => (
    <span
      aria-label={title}
      className="inline-flex cursor-help items-center text-muted-foreground"
      role="img"
      title={title}
    >
      <CircleHelp className="h-3.5 w-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
  const labelWithHelp = (label: string, title: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      {helpMarker(label, title)}
    </span>
  );
  const gptModelHelpText = copy(
    "Web backend: main ChatGPT conversation model. Codex/Responses backend: top-level Responses model. External image API may ignore this field.",
    "Web 后端：主 ChatGPT 对话模型；Codex/Responses 后端：顶层 Responses 模型；外接 image API 可能忽略此字段。"
  );
  const imageModelHelpText = copy(
    "Image model for generations/edits. Web backend does not have a separate image model field and ignores this control; Codex/Responses uses it as the image_generation tool model; external image API receives it as the image model.",
    "生图/编辑图片模型。Web 后端没有独立图片模型字段，会忽略该控制；Codex/Responses 会作为 image_generation 工具模型；外接 image API 会作为图片模型传递。"
  );
  const thinkingHelpText = copy(
    "Web backend uses this as paragen thinking level. If prompt optimization is off, Web thinking is forced to instant. Codex/Responses receives the selected effort when supported.",
    "Web 后端会作为 paragen 思考强度；关闭提示词优化时，Web 思考强度会强制为 instant；Codex/Responses 在支持时接收所选强度。"
  );
  const promptOptimizationHelpText = copy(
    "Turning this off is best effort: the platform sends the original prompt and uses instant on Web, but an upstream backend may still internally revise or interpret the prompt.",
    "关闭后是尽量少改动：平台会发送原始提示词，并让 Web 使用 instant；但上游后端仍可能在内部改写或理解提示词。"
  );
  const resolutionHelpText = copy(
    "Auto lets the backend decide the output size. Reference images can use their original pixels for preview and masks. The requested output size must still be valid, so non-step reference sizes are rounded to the nearest supported size. Web backend treats resolution as best-effort aspect-ratio guidance and cannot guarantee exact pixels or native 4K. After generation, the actual output size is recorded and credits are settled against the actual size.",
    "Auto 会让后端决定输出尺寸。参考图预览和蒙版仍使用原始像素。请求的输出尺寸必须合法，所以非步进参考图尺寸会贴近到支持的尺寸。Web 后端只能把分辨率作为尽量遵循的画幅提示，不能保证精确像素或原生 4K。生成完成后会记录实际输出尺寸，并按实际尺寸修正计费。"
  );
  const validationMessage = (message?: string) => {
    if (!message || !isZh) return message;
    if (message === "Use WIDTHxHEIGHT format.") {
      return "请使用 宽x高 格式。";
    }
    if (message.startsWith("Width and height must be between")) {
      return `宽和高必须在 256 到 ${MAX_IMAGE_DIMENSION}px 之间，并且能被 ${IMAGE_DIMENSION_STEP} 整除。`;
    }
    if (message.startsWith("Total pixels must be no more than")) {
      return "总像素不能超过 8,294,400。";
    }
    if (message.startsWith("Total pixels must be at least")) {
      return "总像素不能低于 655,360。";
    }
    if (message.startsWith("Aspect ratio must be no more than")) {
      return "宽高比不能超过 3:1。";
    }
    return message;
  };
  const chatAllowed = capabilities.features["imageGeneration.chat"];
  const agentAllowed =
    capabilities.features["imageGeneration.agent"] ?? chatAllowed;
  const waterfallAllowed =
    capabilities.features["imageGeneration.waterfall"] ?? chatAllowed;
  const gpt55ChatAllowed = capabilities.features["models.gpt55"];
  const promptOptimizationAllowed =
    capabilities.features["promptOptimization.control"];
  const maxEditImages = capabilities.limits.maxEditImages;
  const maxChatImages = capabilities.limits.maxChatImages;
  // 单次生成张数上限由 maxBatchCount 控制；并发由 imageGenerationConcurrency 单独控制。
  const batchCountMax = Math.max(1, capabilities.limits.maxBatchCount);
  const maxImageBytes =
    uploadLimits.maxFileSizeBytes || DEFAULT_MAX_IMAGE_BYTES;
  const maxEditRequestBytes =
    uploadLimits.maxUploadBytes || DEFAULT_MAX_EDIT_REQUEST_BYTES;
  // WHY 初始恒为 "text":SSR 读不到 localStorage,若首渲染就用存储值,
  // 服务端(text)与客户端首帧不一致会触发 hydration mismatch。
  // 持久化模式的恢复后置到挂载 effect(见 effectiveAgentAllowed 定义后),
  // 并按套餐能力校正,避免恢复到锁定/不可用模式。
  const [activeMode, setActiveMode] = useCreateRuntimeState<ActiveMode>(
    "activeMode",
    "text"
  );
  // 三个高频提示词输入已下沉到 PromptTextareaField(独立订阅,击键只重渲
  // 小组件)。父组件改用非订阅访问器:getXxx() 在事件处理器里读最新值,
  // setXxx 各调用点(发送后清空、mention 插入等)签名不变。render 路径
  // 依赖的"非空/含 @ 引用"改订阅派生布尔(仅翻转时重渲本组件)。
  const [getPrompt] = useCreateRuntimeAccessor("prompt", "");
  const [promptHasText] = useCreateRuntimeState(
    "promptHasText",
    () => Boolean(getPrompt().trim())
  );
  const [textMode, setTextMode] = useCreateRuntimeState<TextGenerationMode>(
    "textMode",
    "single"
  );
  const [linePrompts, setLinePrompts] = useCreateRuntimeState(
    "linePrompts",
    ""
  );
  const [getEditPrompt, setEditPrompt] = useCreateRuntimeAccessor(
    "editPrompt",
    ""
  );
  const [editPromptHasText] = useCreateRuntimeState(
    "editPromptHasText",
    () => Boolean(getEditPrompt().trim())
  );
  const [editHasImageReference] = useCreateRuntimeState(
    "editPromptHasRef",
    () => hasPromptImageReference(getEditPrompt())
  );
  const [promptOptimization, setPromptOptimization] = useCreateRuntimeState(
    "promptOptimization",
    true
  );
  const [getChatPrompt, setChatPrompt] = useCreateRuntimeAccessor(
    "chatPrompt",
    ""
  );
  const [chatPromptHasText] = useCreateRuntimeState(
    "chatPromptHasText",
    () => Boolean(getChatPrompt().trim())
  );
  const [chatHasImageReference] = useCreateRuntimeState(
    "chatPromptHasRef",
    () => hasPromptImageReference(getChatPrompt())
  );
  // chat(web) 这一轮生成什么:image=对话式图像(走 chat 图像管线);ppt/psd=可编辑文件
  // (走 /api/editable-file/generate)。仅 chat-web tab 展示选择器。
  const [chatWebGenKind, setChatWebGenKind] = useCreateRuntimeState<
    "image" | "ppt" | "psd"
  >("chatWebGenKind", "image");
  const [editMention, setEditMention] =
    useCreateRuntimeState<MentionState | null>("editMention", null);
  const [chatMention, setChatMention] =
    useCreateRuntimeState<MentionState | null>("chatMention", null);
  const [chatConversationId, setChatConversationId] = useCreateRuntimeState(
    "chatConversationId",
    () => createLocalId()
  );
  const [chatConversations, setChatConversations] = useCreateRuntimeState<
    ChatConversation[]
  >("chatConversations", []);
  const [chatMessages, setChatMessages] = useCreateRuntimeState<ChatMessage[]>(
    "chatMessages",
    []
  );
  const [chatAttachments, setChatAttachments] = useCreateRuntimeState<
    ChatAttachment[]
  >("chatAttachments", []);
  const [chatStream, setChatStream] =
    useCreateRuntimeState<ChatStreamState | null>("chatStream", null);
  const [retryingChatMessageId, setRetryingChatMessageId] =
    useCreateRuntimeState<string | null>("retryingChatMessageId", null);
  const [batchCards, setBatchCards] = useCreateRuntimeState<BatchCard[]>(
    "batchCards",
    []
  );
  const [batchPrompt, setBatchPrompt] = useCreateRuntimeState(
    "batchPrompt",
    ""
  );
  const [isBatchActive, setIsBatchActive] = useCreateRuntimeState(
    "isBatchActive",
    false
  );
  const [isBatchLoadingMore, setIsBatchLoadingMore] = useCreateRuntimeState(
    "isBatchLoadingMore",
    false
  );
  const [isBatchStopped, setIsBatchStopped] = useCreateRuntimeState(
    "isBatchStopped",
    false
  );
  const [waterfallCreditsConsumed, setWaterfallCreditsConsumed] =
    useCreateRuntimeState("waterfallCreditsConsumed", 0);
  const [waterfallStats, setWaterfallStats] =
    useCreateRuntimeState<WaterfallStats>("waterfallStats", {
      sent: 0,
      success: 0,
      failed: 0,
    });
  // 瀑布流“每批并发张数”(tier)：对齐原项目 TIER。瀑布流每张卡片是独立 count=1 请求，
  // 故真正的并发硬上限是套餐 imageGenerationConcurrency(队列 userConcurrency 实际钳制的值)，
  // 与“单次请求张数上限 maxBatchCount”无关，因此 tier 仅受 imageGenerationConcurrency 约束。
  const [waterfallTier, setWaterfallTier] = useCreateRuntimeState(
    "waterfallTier",
    DEFAULT_WATERFALL_TIER
  );
  // 瀑布流警告弹窗状态：null 表示无弹窗；承载 type/tier/count。
  const [waterfallWarning, setWaterfallWarning] = useCreateRuntimeState<{
    type: WaterfallWarningType;
    tier: number;
    count: number;
  } | null>("waterfallWarning", null);
  // tier 允许上限 = 套餐单用户并发上限(至少 1)
  const waterfallTierLimit = Math.max(
    1,
    capabilities.limits.imageGenerationConcurrency
  );
  // 可选 tier：预设中不超过套餐上限者；若全部超限则保底 [1]
  const waterfallTierOptions = (() => {
    const filtered = WATERFALL_TIER_PRESETS.filter(
      (value) => value <= waterfallTierLimit
    );
    return filtered.length > 0 ? filtered : [1];
  })();
  // 实际生效 tier：钳制到允许上限
  const effectiveWaterfallTier = Math.max(
    1,
    Math.min(waterfallTier, waterfallTierLimit)
  );
  // 每批载入张数 = tier；单批最大并发 = tier * 倍数，再与套餐并发上限取 min 兜底
  const waterfallLoadSize = effectiveWaterfallTier;
  const waterfallMaxConcurrent = Math.max(
    1,
    Math.min(
      effectiveWaterfallTier * WATERFALL_CONCURRENCY_MULTIPLIER,
      waterfallTierLimit
    )
  );
  const [chatModel, setChatModel] = useCreateRuntimeState<ChatModel>(
    "chatModel",
    GPT54_CHAT_MODEL
  );
  const [chatThinking, setChatThinking] =
    useCreateRuntimeState<ChatThinkingLevel>("chatThinking", "low");
  const [agentForceRounds, setAgentForceRounds] = useCreateRuntimeState(
    "agentForceRounds",
    false
  );
  const [agentMaxRounds, setAgentMaxRounds] = useCreateRuntimeState(
    "agentMaxRounds",
    3
  );
  // 分层生成("生成即分层"):agent 先出整图、再逐层生成。仅 agent 模式有效。
  const [layeredGeneration, setLayeredGeneration] = useCreateRuntimeState(
    "layeredGeneration",
    false
  );
  const [imageGptModel, setImageGptModel] = useCreateRuntimeState<
    ChatModel | "default"
  >("imageGptModel", "default");
  const [imageThinking, setImageThinking] =
    useCreateRuntimeState<ChatThinkingLevel>("imageThinking", "low");
  const [chatFirstImageSize, setChatFirstImageSize] = useCreateRuntimeState<{
    width: number;
    height: number;
  } | null>("chatFirstImageSize", null);
  const [isChatGenerating, setIsChatGenerating] = useCreateRuntimeState(
    "isChatGenerating",
    false
  );
  const [useAutoSize, setUseAutoSize] = useCreateRuntimeState(
    "useAutoSize",
    false
  );
  const [width, setWidth] = useCreateRuntimeState(
    "width",
    defaultDimensions.width
  );
  const [height, setHeight] = useCreateRuntimeState(
    "height",
    defaultDimensions.height
  );
  const [textMixWebFirst, setTextMixWebFirst] = useCreateRuntimeState(
    "textMixWebFirst",
    true
  );
  const [editMixWebFirst, setEditMixWebFirst] = useCreateRuntimeState(
    "editMixWebFirst",
    true
  );
  const [chatMixWebFirst, setChatMixWebFirst] = useCreateRuntimeState(
    "chatMixWebFirst",
    true
  );
  const [quality, setQuality] = useCreateRuntimeState<ImageQuality>(
    "quality",
    "auto"
  );
  const [moderation, setModeration] = useCreateRuntimeState<ImageModeration>(
    "moderation",
    "auto"
  );
  const [outputFormat, setOutputFormat] =
    useCreateRuntimeState<ImageOutputFormat>("outputFormat", "png");
  const [background, setBackground] = useCreateRuntimeState<ImageBackground>(
    "background",
    "auto"
  );
  // 透明背景抠图回退显式开关(issue #27):仅 background=transparent 时有意义。开启后若后端
  // 不支持透明,则不透明重生成 + 服务端 ISNet 抠图;不开则透明直接透传、不支持即返回真实错误。
  // 仅文生图/图生图/chat/瀑布流可用,agent 模式不提供(UI 隐藏 + 后端忽略)。
  const [transparentMatte, setTransparentMatte] = useCreateRuntimeState(
    "transparentMatte",
    false
  );
  // 高清修复:默认关闭(用轻量 general-x4v3,快且安全);勾选才用 SwinIR 复原(文字/结构最佳,
  // 但 CPU 极慢、吃满多核,仅供受控测试)。仅在超分主开关开且上游图偏小触发超分时生效。
  const [hdRepair, setHdRepair] = useCreateRuntimeState("hdRepair", false);
  const [outputCompression, setOutputCompression] = useCreateRuntimeState(
    "outputCompression",
    100
  );
  const [batchCount, setBatchCount] = useCreateRuntimeState("batchCount", 1);
  const [lineBatchRepeatCount, setLineBatchRepeatCount] = useCreateRuntimeState(
    "lineBatchRepeatCount",
    1
  );
  const [editBatchCount, setEditBatchCount] = useCreateRuntimeState(
    "editBatchCount",
    1
  );

  // 路由切换时重置创作页面的表单输入状态,防止从其他页面切换回来时
  // 仍显示上一次的内容。仅清理输入类状态,保留用户偏好(模型/尺寸/质量等)。
  const resetKeys = useResetCreateRuntimeKeys();
  useEffect(() => {
    // 如果 URL 携带 sendRef 参数,说明是从图库/历史发送参考图过来,
    // 不应清理状态(reference-handoff 会填充正确的值)。
    const params = new URLSearchParams(window.location.search);
    if (params.has("sendRef")) return;

    resetKeys([
      "prompt",
      "promptHasText",
      "promptHasRef",
      "editPrompt",
      "editPromptHasText",
      "editPromptHasRef",
      "chatPrompt",
      "chatPromptHasText",
      "chatPromptHasRef",
      "batchPrompt",
      "linePrompts",
      "chatAttachments",
    ]);
  }, [resetKeys]);

  useEffect(() => {
    setBatchCount((value) => Math.min(value, batchCountMax));
    setLineBatchRepeatCount((value) => Math.min(value, batchCountMax));
    setEditBatchCount((value) => Math.min(value, batchCountMax));
    // 瀑布流 tier 也钳制到当前套餐允许上限(套餐切换/管理员调整并发时收紧)
    setWaterfallTier((value) => Math.max(1, Math.min(value, waterfallTierLimit)));
  }, [batchCountMax, waterfallTierLimit]);

  useEffect(() => {
    const parseReferenceMode = (
      value: string | null | undefined
    ): ReferenceTargetMode =>
      value === "agent" || value === "waterfall" || value === "chat"
        ? value
        : "image";
    const clearReferenceParams = () => {
      const nextParams = new URLSearchParams(searchParams.toString());
      for (const key of [
        "mode",
        "ref",
        "sourceId",
        "sourceName",
        "intent",
        "sendRef",
      ]) {
        nextParams.delete(key);
      }
      const nextQuery = nextParams.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
        scroll: false,
      });
    };

    const referenceUrl = searchParams.get("ref");
    const sendRef = searchParams.get("sendRef");
    if (referenceUrl && sendRef) {
      consumePendingReferenceHandoff(sendRef);
    }
    const pendingReference = referenceUrl
      ? null
      : consumePendingReferenceHandoff(sendRef);
    const reference = referenceUrl
      ? {
          mode: parseReferenceMode(searchParams.get("mode")),
          imageUrl: referenceUrl,
          sourceId: searchParams.get("sourceId") || referenceUrl,
          sourceName: searchParams.get("sourceName") || "reference",
          intentId: searchParams.get("intent") || sendRef || "",
          fromUrl: true,
        }
      : pendingReference
        ? {
            mode: parseReferenceMode(pendingReference.mode),
            imageUrl: pendingReference.imageUrl,
            sourceId: pendingReference.sourceId || pendingReference.imageUrl,
            sourceName: pendingReference.sourceName || "reference",
            intentId: pendingReference.id,
            fromUrl: false,
          }
        : null;
    if (!reference) return;

    const referenceKey = [
      reference.mode,
      reference.sourceId,
      reference.imageUrl,
      reference.intentId,
    ].join("|");
    if (appliedReferenceParamKeyRef.current === referenceKey) return;
    appliedReferenceParamKeyRef.current = referenceKey;
    let cancelled = false;

    const attachReference = async () => {
      try {
        const item = await urlToEditImageFile(
          reference.imageUrl,
          reference.sourceName,
          reference.sourceId
        );
        if (cancelled) {
          revokePreview(item.previewUrl);
          return;
        }

        if (
          reference.mode === "chat" ||
          reference.mode === "agent" ||
          reference.mode === "waterfall"
        ) {
          const modeAllowed =
            reference.mode === "agent"
              ? agentAllowed
              : reference.mode === "waterfall"
                ? waterfallAllowed
                : chatAllowed;
          if (!modeAllowed) {
            revokePreview(item.previewUrl);
            setActiveMode("image");
            toast.error(
              copy(
                "This mode is not enabled for your plan.",
                "当前套餐未开启该模式。"
              )
            );
            return;
          }

          setChatAttachments((prev) => {
            if (
              prev.some(
                (attachment) => attachment.sourceId === reference.sourceId
              )
            ) {
              revokePreview(item.previewUrl);
              return prev;
            }
            if (prev.length >= maxChatImages) {
              revokePreview(item.previewUrl);
              toast.error(
                copy(
                  `Attach up to ${maxChatImages} reference images`,
                  `最多可添加 ${maxChatImages} 张参考图片`
                )
              );
              return prev;
            }
            return [...prev, { ...item, kind: "image" }];
          });
          setActiveMode(reference.mode);
          toast.success(copy("Reference image attached", "参考图片已添加"));
          if (reference.fromUrl && !cancelled) clearReferenceParams();
          return;
        }

        setEditImages((prev) => {
          if (prev.some((image) => image.sourceId === reference.sourceId)) {
            revokePreview(item.previewUrl);
            return prev;
          }
          if (prev.length >= maxEditImages) {
            revokePreview(item.previewUrl);
            toast.error(
              copy(
                `Upload up to ${maxEditImages} source images`,
                `最多可上传 ${maxEditImages} 张源图片`
              )
            );
            return prev;
          }
          return [...prev, item];
        });
        setActiveMode("image");
        toast.success(copy("Reference image selected", "参考图片已选择"));
        if (reference.fromUrl && !cancelled) clearReferenceParams();
      } catch (error) {
        toast.error(
          copy("Failed to load reference image", "参考图片加载失败"),
          {
            description:
              error instanceof Error
                ? error.message
                : copy("Could not load image.", "无法加载图片。"),
          }
        );
        if (appliedReferenceParamKeyRef.current === referenceKey) {
          appliedReferenceParamKeyRef.current = null;
        }
        if (reference.fromUrl && !cancelled) clearReferenceParams();
      }
    };

    void attachReference();

    return () => {
      cancelled = true;
    };
  }, [
    agentAllowed,
    chatAllowed,
    copy,
    maxChatImages,
    maxEditImages,
    pathname,
    router,
    searchParams,
    waterfallAllowed,
  ]);

  const [textModel, setTextModel] = useCreateRuntimeState(
    "textModel",
    "default"
  );
  const [editModel, setEditModel] = useCreateRuntimeState(
    "editModel",
    "default"
  );
  const [chatImageModel, setChatImageModel] = useCreateRuntimeState(
    "chatImageModel",
    "default"
  );
  const [useEditFirstImageSize, setUseEditFirstImageSize] =
    useCreateRuntimeState("useEditFirstImageSize", true);
  const [useAutoEditSize, setUseAutoEditSize] = useCreateRuntimeState(
    "useAutoEditSize",
    false
  );
  const [useAutoChatEditSize, setUseAutoChatEditSize] = useCreateRuntimeState(
    "useAutoChatEditSize",
    false
  );
  const [textSizeDialogOpen, setTextSizeDialogOpen] = useState(false);
  const [editSizeDialogOpen, setEditSizeDialogOpen] = useState(false);
  const [chatSizeDialogOpen, setChatSizeDialogOpen] = useState(false);
  const [editWidth, setEditWidth] = useCreateRuntimeState(
    "editWidth",
    defaultDimensions.width
  );
  const [editHeight, setEditHeight] = useCreateRuntimeState(
    "editHeight",
    defaultDimensions.height
  );
  const [chatEditWidth, setChatEditWidth] = useCreateRuntimeState(
    "chatEditWidth",
    defaultDimensions.width
  );
  const [chatEditHeight, setChatEditHeight] = useCreateRuntimeState(
    "chatEditHeight",
    defaultDimensions.height
  );
  const [editImages, setEditImages] = useCreateRuntimeState<EditImageFile[]>(
    "editImages",
    []
  );
  const [maskFile, setMaskFile] = useCreateRuntimeState<EditImageFile | null>(
    "maskFile",
    null
  );
  const [maskEditorOpen, setMaskEditorOpen] = useCreateRuntimeState(
    "maskEditorOpen",
    false
  );
  const [maskPoints, setMaskPoints] = useCreateRuntimeState<MaskPoint[]>(
    "maskPoints",
    []
  );
  const [maskBrushSize, setMaskBrushSize] = useCreateRuntimeState(
    "maskBrushSize",
    32
  );
  const [firstImageSize, setFirstImageSize] = useCreateRuntimeState<{
    width: number;
    height: number;
  } | null>("firstImageSize", null);
  const [isEditing, setIsEditing] = useCreateRuntimeState("isEditing", false);
  const [isTextSingleGenerating, setIsTextSingleGenerating] =
    useCreateRuntimeState("isTextSingleGenerating", false);
  const [isTextLinesGenerating, setIsTextLinesGenerating] =
    useCreateRuntimeState("isTextLinesGenerating", false);
  const [, setStreamingPreviewUrl] = useCreateRuntimeState<string | null>(
    "streamingPreviewUrl",
    null
  );
  const [visualPreviewUrls, setVisualPreviewUrls] = useCreateRuntimeState<
    Partial<Record<VisualOutputMode, string | null>>
  >("visualPreviewUrls", {});
  const [visualLoading, setVisualLoading] = useCreateRuntimeState<
    Partial<Record<VisualOutputMode, { size: string } | null>>
  >("visualLoading", {});
  const [balance, setBalance] = useCreateRuntimeState(
    "balance",
    initialBalance
  );
  const [result, setResult] = useCreateRuntimeState<ResultState | null>(
    "result",
    null
  );
  const [visualResults, setVisualResults] = useCreateRuntimeState<
    Partial<Record<VisualOutputMode, ResultState | null>>
  >("visualResults", {});
  const [recent, setRecent] = useCreateRuntimeState<ChatRecentGeneration[]>(
    "recent",
    initialRecent
  );
  const [selectedRecentId, setSelectedRecentId] = useCreateRuntimeState<
    string | null
  >("selectedRecentId", null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const chatImageInputRef = useRef<HTMLInputElement | null>(null);
  const batchImageInputRef = useRef<HTMLInputElement | null>(null);
  const editPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const chatPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);
  const chatConversationsRef = useCreateRuntimeRef<ChatConversation[]>(
    "chatConversationsRef",
    []
  );
  const didLoadChatRef = useCreateRuntimeRef("didLoadChatRef", false);
  const chatMessagesConversationIdRef = useCreateRuntimeRef<string | null>(
    "chatMessagesConversationIdRef",
    null
  );
  const chatMessagesModeRef = useCreateRuntimeRef<ConversationMode | null>(
    "chatMessagesModeRef",
    null
  );
  // 会话持久化去抖窗口内待执行的落库闭包;仅供关页/卸载时冲刷,防丢尾巴。
  const pendingChatPersistRef = useRef<(() => void) | null>(null);
  const isCreatePageMountedRef = useRef(false);
  const appliedReferenceParamKeyRef = useRef<string | null>(null);
  const activeChatRequestGenerationIdsRef = useCreateRuntimeRef<Set<string>>(
    "activeChatRequestGenerationIdsRef",
    () => new Set()
  );
  const batchLoadTriggerRef = useRef<HTMLDivElement | null>(null);
  const batchScrollRef = useRef<HTMLDivElement | null>(null);
  const batchActiveRequestsRef = useCreateRuntimeRef(
    "batchActiveRequestsRef",
    0
  );
  const batchPromptRef = useCreateRuntimeRef("batchPromptRef", "");
  const batchSizeRef = useCreateRuntimeRef("batchSizeRef", DEFAULT_IMAGE_SIZE);
  const batchLoadingMoreRef = useCreateRuntimeRef("batchLoadingMoreRef", false);
  const batchStoppedRef = useCreateRuntimeRef("batchStoppedRef", false);
  const batchAbortControllersRef = useCreateRuntimeRef<
    Map<string, AbortController>
  >("batchAbortControllersRef", () => new Map());
  // 里程碑警告期间阻塞自动续批；用户确认后解除并恢复生成
  const warningBlockRef = useCreateRuntimeRef("waterfallWarningBlockRef", false);
  // 本会话累计“已发起”的瀑布流张数，用于跨越里程碑阈值判断
  const sessionCountRef = useCreateRuntimeRef("waterfallSessionCountRef", 0);
  // 已展示过的里程碑阈值集合，避免同一阈值重复弹窗
  const milestoneShownRef = useCreateRuntimeRef<Set<number>>(
    "waterfallMilestoneShownRef",
    () => new Set<number>()
  );
  // 跟踪最新的单批最大并发(供 IntersectionObserver 闭包读取最新值，避免依赖数组过期)
  const waterfallMaxConcurrentRef = useCreateRuntimeRef(
    "waterfallMaxConcurrentRef",
    waterfallMaxConcurrent
  );
  waterfallMaxConcurrentRef.current = waterfallMaxConcurrent;
  const triggerBatchGenerationRef = useRef<
    ((options?: { retryCardId?: string }) => Promise<void>) | null
  >(null);
  const maskInputRef = useRef<HTMLInputElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastMaskPointRef = useRef<{ x: number; y: number } | null>(null);
  const chatImageAttachmentCount = chatAttachments.filter(
    (item) => item.kind === "image"
  ).length;

  useEffect(() => {
    isCreatePageMountedRef.current = true;
    return () => {
      isCreatePageMountedRef.current = false;
    };
  }, []);
  // 首次进入瀑布流模式且从未看过提示时，弹出 first-time 额度消耗警告。
  // 用 activeMode 作触发条件(瀑布流是 Tab 之一而非独立页面)，避免打扰其它模式用户。
  // 已弹窗(waterfallWarning 非空)或已看过(localStorage)时早退，不会重复弹。
  useEffect(() => {
    if (activeMode !== "waterfall") {
      return;
    }
    if (waterfallWarning) {
      return;
    }
    if (hasSeenWaterfallFirstTimeWarning()) {
      return;
    }
    setWaterfallWarning({
      type: "first-time",
      tier: effectiveWaterfallTier,
      count: 0,
    });
  }, [activeMode, waterfallWarning, effectiveWaterfallTier]);
  const hasChatImageAttachments = chatImageAttachmentCount > 0;
  const textSizeDialogValue = useMemo(
    () => ({
      auto: useAutoSize,
      width,
      height,
      mixWebFirst: textMixWebFirst,
    }),
    [height, textMixWebFirst, useAutoSize, width]
  );
  const editSizeDialogValue = useMemo(
    () => ({
      auto: useAutoEditSize,
      width: editWidth,
      height: editHeight,
      mixWebFirst: editMixWebFirst,
    }),
    [editHeight, editMixWebFirst, editWidth, useAutoEditSize]
  );
  const chatSizeDialogValue = useMemo(
    () =>
      hasChatImageAttachments
        ? {
            auto: useAutoChatEditSize,
            width: chatEditWidth,
            height: chatEditHeight,
            mixWebFirst: chatMixWebFirst,
          }
        : {
            auto: useAutoSize,
            width,
            height,
            mixWebFirst: chatMixWebFirst,
          },
    [
      chatEditHeight,
      chatEditWidth,
      chatMixWebFirst,
      hasChatImageAttachments,
      height,
      useAutoChatEditSize,
      useAutoSize,
      width,
    ]
  );

  const effectiveContentSafetyEnabled =
    moderationEnabled &&
    capabilities.features["moderation.blocking"] &&
    selectedBackendGroup?.contentSafetyEnabled !== false;
  const moderationCostOptions = useMemo(
    () => ({
      textModerationCount: effectiveContentSafetyEnabled ? undefined : 0,
    }),
    [effectiveContentSafetyEnabled]
  );
  const getModerationCostOptions = (imageCount: number) => ({
    ...moderationCostOptions,
    imageModerationCount: effectiveContentSafetyEnabled ? imageCount : 0,
  });
  const manualSize = useMemo(
    () => normalizeImageSize(width, height),
    [width, height]
  );
  const size = useAutoSize ? AUTO_IMAGE_SIZE : manualSize;
  const linePromptItems = useMemo(
    () =>
      linePrompts
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    [linePrompts]
  );
  const lineBatchTotalCount = linePromptItems.length * lineBatchRepeatCount;
  const manualEditSize = useMemo(
    () => normalizeImageSize(editWidth, editHeight),
    [editWidth, editHeight]
  );
  const customEditSize = useAutoEditSize ? AUTO_IMAGE_SIZE : manualEditSize;
  const manualChatCustomEditSize = useMemo(
    () => normalizeImageSize(chatEditWidth, chatEditHeight),
    [chatEditWidth, chatEditHeight]
  );
  const chatCustomEditSize = useAutoChatEditSize
    ? AUTO_IMAGE_SIZE
    : manualChatCustomEditSize;
  const canUseMixWebFirstRouting =
    activeBackendType === "mixed" && !customApiActive;
  const firstImageOriginalSize = useMemo(
    () =>
      firstImageSize
        ? normalizeImageSize(firstImageSize.width, firstImageSize.height)
        : null,
    [firstImageSize]
  );
  const firstImageOutputSize = useMemo(
    () => (firstImageSize ? normalizeValidImageSize(firstImageSize) : null),
    [firstImageSize]
  );
  const chatFirstImageOriginalSize = useMemo(
    () =>
      chatFirstImageSize
        ? normalizeImageSize(
            chatFirstImageSize.width,
            chatFirstImageSize.height
          )
        : null,
    [chatFirstImageSize]
  );
  const effectiveEditSize = useMemo(() => {
    if (useEditFirstImageSize) {
      return firstImageOutputSize;
    }
    return customEditSize;
  }, [customEditSize, firstImageOutputSize, useEditFirstImageSize]);
  const batchFallbackSize = hasChatImageAttachments ? chatCustomEditSize : size;
  // 选 Firefly 模型时,gpt/codex 专属参数(质量/审核/输出格式/思考)对 adobe 无效,统一置灰禁用。
  const textFireflyActive = isFireflyModel(textModel);
  const editFireflyActive = isFireflyModel(editModel);
  const textMixWebFirstActive =
    canUseMixWebFirstRouting &&
    !textFireflyActive &&
    shouldPreferWebImageRoute({
      size,
      webFirst: textMixWebFirst,
      pixelRange: forceWebPixelRange,
    });
  const editMixWebFirstActive =
    canUseMixWebFirstRouting &&
    !editFireflyActive &&
    Boolean(effectiveEditSize) &&
    shouldPreferWebImageRoute({
      size: effectiveEditSize,
      webFirst: editMixWebFirst,
      requiresResponsesBackend: editHasImageReference,
      pixelRange: forceWebPixelRange,
    });
  const chatRequiresResponsesBackend =
    activeMode === "agent" ||
    (activeMode !== "chat-web" && chatHasImageReference);
  const chatMixWebFirstActive =
    canUseMixWebFirstRouting &&
    shouldPreferWebImageRoute({
      size: batchFallbackSize,
      webFirst: activeMode === "chat-web" ? true : chatMixWebFirst,
      requiresResponsesBackend: chatRequiresResponsesBackend,
      pixelRange: forceWebPixelRange,
    });
  // mixed 父组的页面报价不能直接使用父组倍率；先按服务端相同的 Web-first
  // 判定预测实际车道，再选择对应子组并合成父子倍率。
  const textBillingRoute = predictImageBillingRoute({
    selectedGroup: selectedBackendGroup,
    groups: backendGroups,
    preferredBackendType: textFireflyActive
      ? undefined
      : textMixWebFirstActive
        ? "web"
        : "responses",
  });
  const editBillingRoute = predictImageBillingRoute({
    selectedGroup: selectedBackendGroup,
    groups: backendGroups,
    preferredBackendType: editFireflyActive
      ? undefined
      : editMixWebFirstActive
        ? "web"
        : "responses",
  });
  const chatBillingRoute = predictImageBillingRoute({
    selectedGroup: selectedBackendGroup,
    groups: backendGroups,
    preferredBackendType: chatMixWebFirstActive ? "web" : "responses",
  });
  const agentBillingRoute = predictImageBillingRoute({
    selectedGroup: selectedBackendGroup,
    groups: backendGroups,
    preferredBackendType: "responses",
  });
  const textImageCreditCost = useMemo(
    () =>
      applyBillingPreviewMultiplier(
        getPricedImageCreditCost(size, moderationCostOptions),
        textBillingRoute.billingMultiplier
      ),
    [
      chatThinking,
      imageBasePricing,
      moderationCostOptions,
      quality,
      size,
      textBillingRoute.billingMultiplier,
    ]
  );
  const textBatchCreditCost = textImageCreditCost * batchCount;
  const lineBatchCreditCost = textImageCreditCost * lineBatchTotalCount;
  const editImageCreditCost = effectiveEditSize
    ? applyBillingPreviewMultiplier(
        getPricedImageCreditCost(
          effectiveEditSize,
          getModerationCostOptions(editImages.length)
        ),
        editBillingRoute.billingMultiplier
      )
    : applyBillingPreviewMultiplier(
        getPricedImageCreditCost(undefined, moderationCostOptions),
        editBillingRoute.billingMultiplier
      );
  const editBatchCreditCost = editImageCreditCost * editBatchCount;
  const chatRoundCreditCost = applyBillingPreviewMultiplier(
    capabilities.billing.chatRoundCredits,
    chatBillingRoute.billingMultiplier
  );
  const agentRoundCreditCost = applyBillingPreviewMultiplier(
    capabilities.billing.agentRoundCredits,
    agentBillingRoute.billingMultiplier
  );
  const chatSingleCreditCost =
    activeMode === "agent" ? agentRoundCreditCost : chatRoundCreditCost;
  // chat(web) 选了 PPT/PSD:走可编辑文件生成(固定 gpt-5-5-thinking + 代码解释器),
  // 图像那套控件(模型/思考/背景/透明/高清修复/尺寸/提示词优化)全不适用,隐藏。
  const chatWebFileMode =
    activeMode === "chat-web" && chatWebGenKind !== "image";
  const agentBackendUnavailableReason = isWebOnlyBackend
    ? copy(
        "Agent mode requires Codex/Responses backend. Web backend keeps the original ChatGPT Web route and does not expose Agent tools.",
        "Agent 模式需要 Codex/Responses 后端。Web 后端保持原 ChatGPT Web 路线，不提供 Agent 工具。"
      )
    : undefined;
  const effectiveAgentAllowed = agentAllowed && !agentBackendUnavailableReason;
  // 挂载后恢复上次使用的创作模式(hydration 安全,见 activeMode 初始化注释):
  // - 仅恢复一次;URL 带参考图跳转参数(mode/ref/sendRef)时让位于 handoff 流程
  // - 按套餐能力与后端可用性校正,绝不恢复到锁定/不可用的模式
  const didRestoreStoredModeRef = useRef(false);
  useEffect(() => {
    if (didRestoreStoredModeRef.current) return;
    didRestoreStoredModeRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.has("mode") || params.has("ref") || params.has("sendRef")) {
      return;
    }
    const stored = readStoredCreateActiveMode();
    const storedModeAllowed =
      stored === "chat"
        ? chatAllowed
        : stored === "agent"
          ? effectiveAgentAllowed
          : stored === "waterfall"
            ? waterfallAllowed
            : true;
    if (storedModeAllowed) {
      setActiveMode(stored);
    }
  }, [chatAllowed, effectiveAgentAllowed, waterfallAllowed, setActiveMode]);
  const currentModeMixWebFirstActive =
    activeMode === "image"
      ? editMixWebFirstActive
      : activeMode === "agent"
        ? false
        : isConversationMode(activeMode)
          ? chatMixWebFirstActive
          : textMixWebFirstActive;
  const disableResponsesOnlyControls =
    isWebOnlyBackend || currentModeMixWebFirstActive;
  const responsesOnlyDisabledReason = currentModeMixWebFirstActive
    ? copy(
        "Disabled while mixed routing tries Web first. These controls apply after fallback to Codex/Responses.",
        "混合路由优先走 Web 时置灰；这些控制仅在回退到 Codex/Responses 后生效。"
      )
    : undefined;
  const batchSingleCreditCost = applyBillingPreviewMultiplier(
    getPricedImageCreditCost(
      batchFallbackSize,
      getModerationCostOptions(chatImageAttachmentCount)
    ),
    activeMode === "agent"
      ? agentBillingRoute.billingMultiplier
      : chatBillingRoute.billingMultiplier
  );
  const formattedBalance = formatCredits(balance);
  const formattedTextBatchCreditCost = formatCredits(textBatchCreditCost);
  const formattedLineBatchCreditCost = formatCredits(lineBatchCreditCost);
  const formattedEditBatchCreditCost = formatCredits(editBatchCreditCost);
  const formattedChatSingleCreditCost = formatCredits(chatSingleCreditCost);
  const formattedBatchSingleCreditCost = formatCredits(batchSingleCreditCost);
  const formattedWaterfallCreditsConsumed = formatCredits(
    waterfallCreditsConsumed
  );
  const waterfallInFlight = Math.max(
    0,
    waterfallStats.sent - waterfallStats.success - waterfallStats.failed
  );
  const waterfallStatusText = copy(
    `Sent ${waterfallStats.sent} · Success ${waterfallStats.success} · Failed ${waterfallStats.failed} · Running ${waterfallInFlight}`,
    `已发送 ${waterfallStats.sent} · 成功 ${waterfallStats.success} · 失败 ${waterfallStats.failed} · 进行中 ${waterfallInFlight}`
  );
  const activeConversationMode = getConversationMode(activeMode);
  const currentModeConversations = useMemo(
    () =>
      chatConversations.filter(
        (conversation) => conversation.mode === activeConversationMode
      ),
    [activeConversationMode, chatConversations]
  );
  const activeConversationExists = useMemo(
    () =>
      currentModeConversations.some(
        (conversation) => conversation.id === chatConversationId
      ),
    [chatConversationId, currentModeConversations]
  );
  // WHY useMemo:本组件重渲极频繁(输入/轮询/流式都会触发),这里若每次
  // render 重建数组,不仅自身 O(消息数),还会因引用变化把下游
  // chatReferenceOptions 的 useMemo 一并击穿,形成"每次击键全量遍历会话"。
  const visibleChatMessages = useMemo(
    () =>
      chatMessages.filter((message) =>
        isMessageInConversationMode(message, activeConversationMode)
      ),
    [activeConversationMode, chatMessages]
  );
  const canUseEditReferenceMentions =
    activeBackendType === "responses" || activeBackendType === "mixed";
  const canUseChatReferenceMentions =
    (activeBackendType === "responses" || activeBackendType === "mixed") &&
    activeMode !== "waterfall";
  const editReferenceOptions = useMemo<ImageReferenceMentionOption[]>(
    () =>
      editImages.map((item, index) => ({
        token: `@图${index + 1}`,
        label: copy(`Source image ${index + 1}`, `源图片 ${index + 1}`),
        detail: item.file.name || copy("Uploaded image", "已上传图片"),
        previewUrl: item.previewUrl,
      })),
    [copy, editImages]
  );
  const chatReferenceOptions = useMemo<ImageReferenceMentionOption[]>(() => {
    const options: ImageReferenceMentionOption[] = chatAttachments
      .filter((item) => item.kind === "image")
      .map((item, index) => ({
        token: `@图${index + 1}`,
        label: copy(`Current attachment ${index + 1}`, `当前附件 ${index + 1}`),
        detail: item.file.name || copy("Uploaded image", "已上传图片"),
        previewUrl: item.previewUrl,
      }));
    let roundIndex = 0;
    for (const message of visibleChatMessages) {
      if (message.role !== "assistant" || message.error) continue;
      const imageVariants = getChatVariants(message).filter(
        (variant) => variant.imageUrl || variant.imageFileId
      );
      if (!imageVariants.length) continue;
      roundIndex += 1;
      imageVariants.forEach((variant, imageIndex) => {
        options.push({
          token: `@第${roundIndex}轮图${imageIndex + 1}`,
          label: copy(
            `Round ${roundIndex} image ${imageIndex + 1}`,
            `第 ${roundIndex} 轮图 ${imageIndex + 1}`
          ),
          detail:
            variant.prompt || variant.size || copy("History image", "历史图片"),
          previewUrl: variant.imageUrl,
        });
      });
    }
    return options;
  }, [chatAttachments, copy, visibleChatMessages]);
  const filteredEditReferenceOptions = useMemo(
    () => filterMentionOptions(editReferenceOptions, editMention?.query || ""),
    [editMention?.query, editReferenceOptions]
  );
  const filteredChatReferenceOptions = useMemo(
    () => filterMentionOptions(chatReferenceOptions, chatMention?.query || ""),
    [chatMention?.query, chatReferenceOptions]
  );
  const editReferenceMentionStatusText = !canUseEditReferenceMentions
    ? copy(
        "Exact @ image references are available only with Codex/Responses or Mixed backend groups. Web-only routes do not expose this exact reference mechanism.",
        "精确 @ 图片引用仅支持 Codex/Responses 或 Mixed 后端分组；纯 Web 路线暂不提供这种精确引用机制。"
      )
    : editHasImageReference
      ? copy(
          "This request contains @ references and will use Codex/Responses, even if custom API or Mixed Web-first routing is enabled.",
          "本次请求包含 @ 引用，将走 Codex/Responses；即使自填 API 或 Mixed Web-first 已开启也不会走这些路线。"
        )
      : copy(
          "Type @ to choose a source image. Using @ references routes this request to Codex/Responses so the backend can attach the selected image as real input.",
          "输入 @ 可选择源图片。使用 @ 引用时，本次请求会走 Codex/Responses，以便后端把选中的图片作为真实图片输入。"
        );
  const chatReferenceMentionStatusText = !canUseChatReferenceMentions
    ? copy(
        "Exact @ image references are hidden while Web-only routing is active. Switch to Codex/Responses or Mixed to reference a specific image.",
        "当前纯 Web 路线下隐藏精确 @ 图片引用。切换到 Codex/Responses 或 Mixed 后，可明确引用指定图片。"
      )
    : chatHasImageReference
      ? copy(
          "This message contains @ references and will use Codex/Responses, bypassing custom API and Web-first routing. Agent normally carries image context, but @ pins the exact attachment or draft.",
          "本条消息包含 @ 引用，将走 Codex/Responses，并绕过自填 API 和 Web-first。Agent 通常会带图片上下文，但 @ 会明确钉住指定附件或草稿。"
        )
      : copy(
          "Type @ to choose current attachments or generated history images. In Mixed groups, @ references bypass Web-first routing and use Codex/Responses. Agent already carries image context, but @ is useful when you need one exact draft or round.",
          "输入 @ 可选择当前附件或历史生成图。Mixed 分组中，使用 @ 引用会跳过 Web-first 并走 Codex/Responses。Agent 默认会带图片上下文，但 @ 适合在多图、多轮草稿中明确指定某一张。"
        );
  const customApiBillingLabel = copy(
    "Custom API active, no site credits",
    "自填 API 已启用，不消耗本站积分"
  );
  const sizeCheck = useMemo(() => validateImageSize(size), [size]);
  const customEditSizeCheck = useMemo(
    () => validateImageSize(customEditSize),
    [customEditSize]
  );
  const chatCustomEditSizeCheck = useMemo(
    () => validateImageSize(chatCustomEditSize),
    [chatCustomEditSize]
  );
  const visualModeBusy = (mode: VisualOutputMode) =>
    mode === "image"
      ? isEditing
      : mode === "text-single"
        ? isTextSingleGenerating
        : isTextLinesGenerating;
  const hasActiveRuntimeTask =
    isEditing ||
    isTextSingleGenerating ||
    isTextLinesGenerating ||
    isChatGenerating ||
    isBatchActive;
  const setVisualModeLoading = (
    mode: VisualOutputMode,
    value: { size: string } | null
  ) => {
    setVisualLoading((prev) => ({ ...prev, [mode]: value }));
  };
  useEffect(() => {
    if (hasActiveRuntimeTask) return;
    setBalance(initialBalance);
    setRecent(initialRecent);
  }, [hasActiveRuntimeTask, initialBalance, initialRecent]);
  useEffect(() => {
    if (activeMode !== "agent" || effectiveAgentAllowed) return;
    setActiveMode("chat");
    toast.error(copy("Agent is unavailable", "Agent 当前不可用"), {
      description: agentBackendUnavailableReason,
    });
  }, [activeMode, agentBackendUnavailableReason, copy, effectiveAgentAllowed]);
  const firstPreviewUrl = editImages[0]?.previewUrl || null;
  const chatFirstPreviewUrl =
    chatAttachments.find((item) => item.kind === "image")?.previewUrl || null;
  const autoSizeLabel = copy("Auto", "自动");
  const editDisplaySize =
    effectiveEditSize === AUTO_IMAGE_SIZE
      ? autoSizeLabel
      : effectiveEditSize || copy("Reference image", "参考图片");
  const editReferenceSizeNote =
    useEditFirstImageSize && firstImageOriginalSize && effectiveEditSize
      ? firstImageOriginalSize === effectiveEditSize
        ? copy(
            `Reference image: ${firstImageOriginalSize}`,
            `参考图：${firstImageOriginalSize}`
          )
        : copy(
            `Reference image: ${firstImageOriginalSize}; output adjusted to ${effectiveEditSize}.`,
            `参考图：${firstImageOriginalSize}；输出已贴近为 ${effectiveEditSize}。`
          )
      : null;
  const isVisualModeLoading = (mode: VisualOutputMode) =>
    Boolean(visualLoading[mode]) && visualModeBusy(mode);
  const getVisualLoadingDimensions = (mode: VisualOutputMode) => {
    const fallbackSize =
      mode === "image" ? effectiveEditSize || customEditSize : size;
    return (
      parseImageSize(visualLoading[mode]?.size || fallbackSize) ||
      defaultDimensions
    );
  };
  const chatSuggestions = isZh ? CHAT_SUGGESTIONS_ZH : CHAT_SUGGESTIONS;
  const promptOptimizationField = (id: string, disabled = false) => (
    <label
      htmlFor={id}
      className={`flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm ${
        promptOptimizationAllowed
          ? "cursor-pointer text-foreground"
          : "cursor-not-allowed text-muted-foreground"
      }`}
    >
      <Checkbox
        id={id}
        checked={promptOptimizationAllowed ? promptOptimization : true}
        onCheckedChange={(checked) => setPromptOptimization(checked === true)}
        disabled={disabled || !promptOptimizationAllowed}
        className="mt-0.5"
      />
      <span>
        {labelWithHelp(
          copy("Prompt optimization", "提示词优化"),
          promptOptimizationHelpText
        )}
        <span className="mt-1 block text-xs font-normal text-muted-foreground">
          {promptOptimizationAllowed
            ? copy(
                "Turn this off to minimize prompt changes. Some backends may still interpret or revise the prompt internally.",
                "关闭后将尽量减少对提示词的改动，但部分后端仍可能在内部理解或优化提示词。"
              )
            : copy(
                "Pro plan or higher can reduce prompt changes.",
                "专业版或更高套餐可尽量减少提示词改动。"
              )}
        </span>
      </span>
    </label>
  );

  const renderGptModelSelect = (params: {
    id: string;
    value: ChatModel | "default";
    onChange: (value: ChatModel | "default") => void;
    disabled?: boolean;
    compact?: boolean;
    allowDefault?: boolean;
  }) => {
    const control = (
      <Select
        value={params.value}
        onValueChange={(value) =>
          params.onChange(value as ChatModel | "default")
        }
        disabled={params.disabled}
      >
        <SelectTrigger
          id={params.id}
          className={params.compact ? "h-8 w-[136px]" : "w-full"}
          title={gptModelHelpText}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {params.allowDefault && (
            <SelectItem value="default">
              {copy("Backend default", "后端默认")}
            </SelectItem>
          )}
          {CHAT_MODEL_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.ultraOnly && !gpt55ChatAllowed}
            >
              {option.label}
              {option.ultraOnly && !gpt55ChatAllowed
                ? ` · ${copy("Ultra", "Ultra")}`
                : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );

    return control;
  };

  const renderImageModelSelect = (params: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    compact?: boolean;
  }) => (
    <Select
      value={params.value}
      onValueChange={params.onChange}
      disabled={params.disabled}
    >
      <SelectTrigger
        id={params.id}
        className={params.compact ? "h-8 w-[146px]" : "w-full"}
        title={imageModelHelpText}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHAT_IMAGE_MODEL_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {chatImageModelLabel(option.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const renderThinkingSelect = (params: {
    id: string;
    value: ChatThinkingLevel;
    onChange: (value: ChatThinkingLevel) => void;
    disabled?: boolean;
    compact?: boolean;
  }) => {
    const control = (
      <Select
        value={params.value}
        onValueChange={(value) => params.onChange(value as ChatThinkingLevel)}
        disabled={params.disabled}
      >
        <SelectTrigger
          id={params.id}
          className={params.compact ? "h-8 w-[138px]" : "w-full"}
          title={thinkingHelpText}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHAT_THINKING_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {copy("Thinking", "思考")} {thinkingLabel(option.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );

    return control;
  };

  const renderBackgroundSelect = (params: {
    id: string;
    disabled?: boolean;
    compact?: boolean;
  }) => (
    <Select
      value={background}
      onValueChange={(value) => setBackground(value as ImageBackground)}
      disabled={params.disabled}
    >
      <SelectTrigger
        id={params.id}
        className={params.compact ? "h-8 w-[126px]" : "w-full"}
        title={backgroundHelpText}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {BACKGROUND_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {params.compact
              ? `${copy("BG", "背景")} ${backgroundLabel(option.value)}`
              : backgroundLabel(option.value)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // 透明抠图回退开关:仅当背景选为 transparent 时出现。开启后会经服务端 ISNet 抠图链路
  // (issue #27)。agent 模式不调用此处(不渲染)。
  const renderTransparentMatteToggle = (params: {
    id: string;
    disabled?: boolean;
  }) => {
    if (background !== "transparent") return null;
    return (
      <label
        htmlFor={params.id}
        className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          transparentMatte
            ? "border-primary bg-primary/10 text-primary"
            : "border-primary/40 bg-primary/5 text-foreground"
        }`}
        title={copy(
          "Transparent matte fallback: if the backend does not support transparent output, regenerate opaque then matte it server-side (ISNet) to deliver a transparent PNG. When off, transparent is passed through and an unsupported backend returns a real error.",
          "透明抠图回退:若后端不支持透明输出,则不透明重生成后用服务端 ISNet 抠图得到透明 PNG。关闭时透明直接透传,后端不支持即返回真实错误。"
        )}
      >
        <Checkbox
          id={params.id}
          checked={transparentMatte}
          onCheckedChange={(checked) => setTransparentMatte(checked === true)}
          disabled={params.disabled}
        />
        {copy("Matte fallback", "透明抠图回退")}
      </label>
    );
  };

  // 高清修复开关:总是可见。开启用 SwinIR 复原(文字/结构最佳,较慢),关闭用 general-x4v3(快)。
  // 仅在管理端超分主开关开、且上游图较长边不足目标 2/3 触发超分时才实际生效。
  const renderHdRepairToggle = (params: { id: string; disabled?: boolean }) => (
    <label
      htmlFor={params.id}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
        hdRepair
          ? "border-primary bg-primary/10 text-primary"
          : "border-primary/40 bg-primary/5 text-foreground"
      }`}
      title={copy(
        "HD repair (SCUNet): off by default. When on, the final image is restored with SCUNet (denoise / de-blocking / detail enhancement, no size change) — independent of upscaling. It is CPU-heavy (about 11s at 512, 35s at 1024) and runs one-at-a-time server-side, so results take longer. Enable only when you want a cleaner, restored result. Requires the server-side restoration switch to be on.",
        "高清修复(SCUNet):默认关闭。勾选后,最终图会用 SCUNet 做盲复原(去噪/去压缩块/增强质感,不改分辨率),与放大(超分)相互独立。CPU 推理较重(512 约 11 秒、1024 约 35 秒)、服务端串行排队,出图会更慢。想要更干净、修复过的结果时再开。需管理端开启「高清修复」主开关。"
      )}
    >
      <Checkbox
        id={params.id}
        checked={hdRepair}
        onCheckedChange={(checked) => setHdRepair(checked === true)}
        disabled={params.disabled}
      />
      {copy("HD repair", "高清修复")}
    </label>
  );

  const renderReferenceMentionMenu = (params: {
    open: boolean;
    options: ImageReferenceMentionOption[];
    onSelect: (option: ImageReferenceMentionOption) => void;
    emptyText: string;
  }) => {
    if (!params.open) return null;
    const visibleOptions = params.options.slice(0, 8);
    return (
      <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
        {visibleOptions.length > 0 ? (
          <div className="max-h-64 overflow-y-auto py-1">
            {visibleOptions.map((option) => (
              <button
                key={option.token}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                onMouseDown={(event) => {
                  event.preventDefault();
                  params.onSelect(option);
                }}
              >
                {option.previewUrl ? (
                  <span className="relative h-9 w-9 shrink-0 overflow-hidden rounded border bg-muted">
                    <Image
                      src={option.previewUrl}
                      alt={option.label}
                      fill
                      sizes="36px"
                      className="object-contain"
                      unoptimized={shouldBypassImageOptimization(
                        option.previewUrl
                      )}
                    />
                  </span>
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border bg-muted text-xs font-medium text-muted-foreground">
                    @
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">
                    {option.token} · {option.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.detail}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {params.emptyText}
          </div>
        )}
      </div>
    );
  };

  // 值写入由 PromptTextareaField 完成,这里只做 mention 触发检测。
  // mention 常态为 null→null,store 的 Object.is 短路使其不触发重渲。
  const handleEditPromptChange = (next: string, selectionStart: number) => {
    setEditMention(
      canUseEditReferenceMentions
        ? getMentionTrigger(next, selectionStart)
        : null
    );
  };

  const handleChatPromptChange = (next: string, selectionStart: number) => {
    setChatMention(
      canUseChatReferenceMentions
        ? getMentionTrigger(next, selectionStart)
        : null
    );
  };

  const selectEditMention = (option: ImageReferenceMentionOption) => {
    if (!editMention) return;
    const nextPrompt = insertMentionToken(
      getEditPrompt(),
      editMention,
      option.token
    );
    const nextCursor = getCursorAfterInsertedMention(editMention, option.token);
    setEditPrompt(nextPrompt);
    setEditMention(null);
    requestAnimationFrame(() => {
      editPromptRef.current?.focus();
      editPromptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const selectChatMention = (option: ImageReferenceMentionOption) => {
    if (!chatMention) return;
    const nextPrompt = insertMentionToken(
      getChatPrompt(),
      chatMention,
      option.token
    );
    const nextCursor = getCursorAfterInsertedMention(chatMention, option.token);
    setChatPrompt(nextPrompt);
    setChatMention(null);
    requestAnimationFrame(() => {
      chatPromptRef.current?.focus();
      chatPromptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const clearStreamingPreview = () => {
    setStreamingPreviewUrl(null);
  };

  const activateChatConversation = (
    conversation: ChatConversation | null | undefined,
    fallbackMode: ConversationMode = activeConversationMode
  ) => {
    const nextId = conversation?.id || createLocalId();
    const nextMode = conversation?.mode || fallbackMode;
    chatMessagesConversationIdRef.current = nextId;
    chatMessagesModeRef.current = nextMode;
    setChatConversationId(nextId);
    setChatMessages(conversation?.messages || []);
    window.localStorage.setItem(
      chatActiveConversationStorageKey(nextMode),
      nextId
    );
  };

  const setVisualStreamingPreview = (
    mode: VisualOutputMode,
    imageUrl: string | null
  ) => {
    setVisualPreviewUrls((prev) => ({ ...prev, [mode]: imageUrl }));
  };

  const clearVisualStreamingPreview = (mode: VisualOutputMode) => {
    setVisualStreamingPreview(mode, null);
  };

  const resetChatConversation = () => {
    chatMessagesConversationIdRef.current = chatConversationId;
    chatMessagesModeRef.current = activeConversationMode;
    setChatMessages([]);
    setChatStream(null);
    setRetryingChatMessageId(null);
    clearStreamingPreview();
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  };

  const handleNewChat = () => {
    if (isChatGenerating) return;
    resetChatConversation();
    const nextId = createLocalId();
    chatMessagesConversationIdRef.current = nextId;
    chatMessagesModeRef.current = activeConversationMode;
    setChatConversationId(nextId);
    window.localStorage.setItem(
      chatActiveConversationStorageKey(activeConversationMode),
      nextId
    );
    setChatPrompt("");
    clearChatAttachments();
    toast.success(copy("New chat started", "已新建对话"));
  };

  const handleClearChatHistory = () => {
    if (isChatGenerating) return;
    const nextConversations = chatConversations.filter(
      (conversation) => conversation.id !== chatConversationId
    );
    chatConversationsRef.current = nextConversations;
    setChatConversations(nextConversations);
    window.localStorage.setItem(
      CHAT_CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(nextConversations)
    );
    resetChatConversation();
    const nextId = createLocalId();
    chatMessagesConversationIdRef.current = nextId;
    chatMessagesModeRef.current = activeConversationMode;
    setChatConversationId(nextId);
    window.localStorage.setItem(
      chatActiveConversationStorageKey(activeConversationMode),
      nextId
    );
    setChatPrompt("");
    toast.success(copy("Chat history cleared", "对话记录已清理"));
  };

  const handleOpenChatConversation = (conversation: ChatConversation) => {
    if (isChatGenerating) return;
    activateChatConversation(conversation, conversation.mode);
    setChatStream(null);
    setRetryingChatMessageId(null);
    clearStreamingPreview();
    setChatPrompt("");
    clearChatAttachments();
    scrollChatToBottom();
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(CREATE_ACTIVE_MODE_STORAGE_KEY, activeMode);
    } catch {
      /* ignore local storage quota errors */
    }

    if (!didLoadChatRef.current || !isConversationMode(activeMode)) return;
    if (isChatGenerating || chatStream?.generationId) return;
    if (
      activeConversationExists &&
      chatMessagesModeRef.current === activeConversationMode
    ) {
      return;
    }

    const storedId = window.localStorage.getItem(
      chatActiveConversationStorageKey(activeConversationMode)
    );
    const conversation = currentModeConversations.find(
      (item) => item.id === storedId
    );
    if (conversation) {
      activateChatConversation(conversation, activeConversationMode);
    } else if (storedId) {
      chatMessagesConversationIdRef.current = storedId;
      chatMessagesModeRef.current = activeConversationMode;
      setChatConversationId(storedId);
      setChatMessages([]);
    } else {
      const fallbackConversation = currentModeConversations[0];
      if (fallbackConversation) {
        activateChatConversation(fallbackConversation, activeConversationMode);
        setChatStream(null);
        setRetryingChatMessageId(null);
        clearStreamingPreview();
        return;
      }
      const nextId = createLocalId();
      chatMessagesConversationIdRef.current = nextId;
      chatMessagesModeRef.current = activeConversationMode;
      setChatConversationId(nextId);
      setChatMessages([]);
      window.localStorage.setItem(
        chatActiveConversationStorageKey(activeConversationMode),
        nextId
      );
    }
    setChatStream(null);
    setRetryingChatMessageId(null);
    clearStreamingPreview();
  }, [
    activeConversationExists,
    activeConversationMode,
    activeMode,
    chatStream?.generationId,
    currentModeConversations,
    isChatGenerating,
  ]);

  const scrollChatToBottom = () => {
    requestAnimationFrame(() => {
      const element = chatMessagesRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  };

  const readImageStreamResponse = async (
    response: Response,
    options?: { previewMode?: VisualOutputMode }
  ) => {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      return readImageApiJsonResponse(response);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { error: "API returned an empty stream" };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const completed: ImageApiResult[] = [];
    let failed: ImageApiResult | null = null;

    const processBlock = (block: string) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (!data || data === "[DONE]") return;

      let event: ImageStreamEvent;
      try {
        event = JSON.parse(data) as ImageStreamEvent;
      } catch {
        return;
      }

      if (event.type === "partial_image") {
        const previewUrl = imageStreamEventToPreviewUrl(event);
        if (previewUrl) {
          if (options?.previewMode) {
            setVisualStreamingPreview(options.previewMode, previewUrl);
          } else {
            setStreamingPreviewUrl(previewUrl);
          }
        }
        return;
      }

      if (
        event.type === "text_delta" ||
        event.type === "thinking_delta" ||
        event.type === "agent_delta"
      ) {
        return;
      }

      if (event.type === "completed") {
        completed.push(event);
        return;
      }

      if (event.type === "error") {
        failed = event;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        processBlock(block);
      }
      if (done) break;
    }

    if (buffer.trim()) {
      processBlock(buffer);
    }

    if (completed.length === 1) {
      return completed[0] as ImageApiResult;
    }

    if (completed.length > 1) {
      return { results: completed };
    }

    if (failed) return failed;
    return { error: "API returned no image data" };
  };

  const runChatRequest = async ({
    prompt,
    attachments = [],
    fallbackSize,
    historyMessages,
    generationId,
    streamMessageId,
    streamCardId,
    agentMode,
    signal,
  }: {
    prompt: string;
    attachments?: ChatAttachment[];
    fallbackSize: string;
    historyMessages: ChatMessage[];
    generationId?: string;
    streamMessageId?: string;
    streamCardId?: string;
    agentMode: boolean;
    signal?: AbortSignal;
  }) => {
    if (generationId) {
      activeChatRequestGenerationIdsRef.current.add(generationId);
    }
    const executeChatRequest = async (): Promise<ImageApiResult> => {
      const streamMode: "chat" | "agent" | undefined =
        streamCardId && !streamMessageId
          ? undefined
          : agentMode
            ? "agent"
            : "chat";
      const updateChatStream = (next: Omit<ChatStreamState, "mode">) => {
        if (streamCardId && !streamMessageId) return;
        setChatStream({ ...next, mode: streamMode });
      };
      const hasImageAttachment = attachments.some(
        (item) => item.kind === "image"
      );
      const requestSize = hasImageAttachment
        ? chatCustomEditSize
        : validateImageSize(fallbackSize).valid
          ? fallbackSize
          : size;
      const formData = new FormData();
      formData.append("prompt", prompt);
      if (generationId) formData.append("generation_id", generationId);
      formData.append(
        "history",
        JSON.stringify(toChatHistory(historyMessages))
      );
      formData.append("quality", quality);
      formData.append("moderation", moderation);
      formData.append("output_format", outputFormat);
      formData.append("background", background);
      // 透明抠图回退仅 chat/瀑布流可用,agent 不传(issue #27)。
      if (!agentMode && background === "transparent" && transparentMatte) {
        formData.append("transparent_matte", "true");
      }
      // 高清修复:关闭时显式传 false 走轻量 general-x4v3;默认(true)由后端选 SwinIR。
      formData.append("hd_repair", String(hdRepair));
      if (outputFormat !== "png") {
        formData.append("output_compression", String(outputCompression));
      }
      formData.append("model", chatModel);
      if (showImageModelControls && chatImageModel !== "default") {
        formData.append("image_model", chatImageModel);
      }
      if (showThinkingControls) {
        formData.append("thinking", chatThinking);
      }
      formData.append("size", requestSize);
      formData.append("count", "1");
      formData.append("stream", "true");
      formData.append(
        "conversation_mode",
        agentMode ? "agent" : streamCardId ? "waterfall" : "chat"
      );
      formData.append("agent_mode", String(agentMode));
      if (agentMode) {
        formData.append("agent_max_rounds", String(agentMaxRounds));
        formData.append("agent_force_max_rounds", String(agentForceRounds));
        formData.append("layered_generation", String(layeredGeneration));
      }
      formData.append("waterfall_mode", String(Boolean(streamCardId)));
      if (promptOptimizationAllowed) {
        formData.append("prompt_optimization", String(promptOptimization));
      }
      if (activeMode === "chat-web") {
        // chat(web):强制优先 web 后端(ChatGPT 网页会话);web 也能处理图引用/编辑,
        // 故不走 requires_responses_backend(那会强制 codex/responses)。
        formData.append("mix_web_first", "true");
        // 网页对话("对话"kind):走 text-capable 路径(回文字、按需出图),而非强制出图。
        formData.append("web_chat", "true");
      } else if (agentMode || hasPromptImageReference(prompt)) {
        formData.append("requires_responses_backend", "true");
      } else {
        // 与页面报价共用原始开关；尺寸范围由前后端同一纯函数继续判定。
        formData.append("mix_web_first", String(chatMixWebFirst));
      }
      const imageAttachments = attachments.filter(
        (item) => item.kind === "image"
      );
      const fileAttachments = attachments.filter(
        (item) => item.kind === "file"
      );
      imageAttachments.forEach(({ file }) => {
        formData.append(
          imageAttachments.length === 1 ? "image" : "image[]",
          file
        );
      });
      fileAttachments.forEach(({ file }) => {
        formData.append(fileAttachments.length === 1 ? "file" : "file[]", file);
      });

      const response = await fetch("/api/images/chat", {
        method: "POST",
        signal,
        headers: {
          Accept: "text/event-stream",
        },
        body: formData,
      });

      const createRequestError = (
        message: string,
        creditsConsumed?: number
      ) => {
        const error = new Error(message) as GenerationRequestError;
        if (creditsConsumed !== undefined) {
          error.creditsConsumed = creditsConsumed;
        }
        return error;
      };

      const buildStreamState = (next?: {
        text?: string;
        thinking?: string;
        agent?: string;
        agentEvents?: AgentRunEvent[];
        imageUrl?: string;
      }): Omit<ChatStreamState, "mode"> => ({
        messageId: streamMessageId,
        cardId: streamCardId,
        generationId,
        prompt,
        model: chatImageModel !== "default" ? chatImageModel : chatModel,
        size: requestSize,
        text: next?.text ?? "",
        thinking: next?.thinking ?? "",
        agent: next?.agent ?? "",
        agentEvents: next?.agentEvents ?? [],
        imageUrl: next?.imageUrl,
      });

      const syncAssistantStreamVariant = (
        state: Omit<ChatStreamState, "mode">
      ) => {
        if (!streamMessageId || streamCardId) return;
        setChatMessages((prev) =>
          prev.map((message) => {
            if (message.id !== streamMessageId) return message;
            const variants = getChatVariants(message);
            const currentVariant =
              variants.find(
                (variant) => variant.generationId === generationId
              ) || getActiveChatVariant(message);
            const nextVariant = mergeChatVariant(currentVariant || undefined, {
              generationId,
              imageUrl: state.imageUrl,
              prompt,
              model: chatImageModel !== "default" ? chatImageModel : chatModel,
              size: requestSize,
              responseText: state.text || undefined,
              responseThinking: state.thinking || undefined,
              responseAgent: state.agent || undefined,
              agentEvents: state.agentEvents.length
                ? state.agentEvents
                : undefined,
              pending: true,
            });
            return {
              ...message,
              text:
                state.text ||
                (state.imageUrl
                  ? copy("Generating image...", "正在生成图片...")
                  : message.text),
              variants: replaceChatVariantByGenerationId(
                variants.length ? variants : [nextVariant],
                generationId,
                [nextVariant]
              ),
              activeVariant: Math.max(
                0,
                variants.findIndex(
                  (variant) => variant.generationId === generationId
                )
              ),
            };
          })
        );
      };

      const publishStreamState = async (next?: {
        text?: string;
        thinking?: string;
        agent?: string;
        agentEvents?: AgentRunEvent[];
        imageUrl?: string;
      }) => {
        const state = buildStreamState(next);
        updateChatStream(state);
        syncAssistantStreamVariant(state);
        await yieldToBrowser();
      };

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const data = await readImageApiJsonResponse(response);
        if (!response.ok || data.error) {
          throw createRequestError(
            data.error || `API error: ${response.status}`,
            data.creditsConsumed
          );
        }
        return data;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("API returned an empty stream");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let failed: ImageApiResult | null = null;
      let completed: ImageApiResult | undefined;
      let text = "";
      let thinking = "";
      let agent = "";
      let agentEvents: AgentRunEvent[] = agentMode
        ? createOptimisticAgentRoundEvents(1)
        : [];
      let previewUrl: string | undefined;
      // 分层生成:第 1 轮整图出来后把它钉为主预览,后续逐层(背景/元素)只进事件列表缩略图,
      // 不再覆盖主预览——否则用户看到的"整图"会被后面的单层图替换掉。非分层不受影响。
      let layeredCompositePinned = false;
      const allowMainPreviewUpdate = () =>
        !(layeredGeneration && layeredCompositePinned);

      const processBlock = async (block: string) => {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();

        if (!data || data === "[DONE]") return;

        let event: ImageStreamEvent;
        try {
          event = JSON.parse(data) as ImageStreamEvent;
        } catch {
          return;
        }

        if (event.type === "text_delta") {
          text += event.delta;
          await publishStreamState({
            text,
            thinking,
            agent,
            agentEvents,
            imageUrl: previewUrl,
          });
          if (streamCardId) {
            setBatchCards((prev) =>
              prev.map((card) =>
                card.id === streamCardId &&
                (card.state === "loading" || card.state === "text")
                  ? { ...card, state: "text", streamText: text }
                  : card
              )
            );
          }
          return;
        }

        if (event.type === "thinking_delta") {
          thinking += event.delta;
          await publishStreamState({
            text,
            thinking,
            agent,
            agentEvents,
            imageUrl: previewUrl,
          });
          if (streamCardId) {
            setBatchCards((prev) =>
              prev.map((card) =>
                card.id === streamCardId &&
                (card.state === "loading" || card.state === "text")
                  ? { ...card, streamThinking: thinking }
                  : card
              )
            );
          }
          return;
        }

        if (event.type === "agent_delta") {
          agent += event.delta;
          await publishStreamState({
            text,
            thinking,
            agent,
            agentEvents,
            imageUrl: previewUrl,
          });
          if (streamCardId) {
            setBatchCards((prev) =>
              prev.map((card) =>
                card.id === streamCardId &&
                (card.state === "loading" || card.state === "text")
                  ? { ...card, streamAgent: agent }
                  : card
              )
            );
          }
          return;
        }

        if (event.type === "agent_event") {
          agentEvents = appendAgentRunEvent(agentEvents, event.event);
          const eventImageUrl = agentEventToImageUrl(event.event);
          if (eventImageUrl && allowMainPreviewUpdate()) {
            previewUrl = eventImageUrl;
            setStreamingPreviewUrl(eventImageUrl);
          }
          await publishStreamState({
            text,
            thinking,
            agent,
            agentEvents,
            imageUrl: previewUrl,
          });
          return;
        }

        if (event.type === "partial_image") {
          const nextPreviewUrl = imageStreamEventToPreviewUrl(event);
          if (nextPreviewUrl) {
            const updateMain = allowMainPreviewUpdate();
            if (updateMain) {
              previewUrl = nextPreviewUrl;
              setStreamingPreviewUrl(nextPreviewUrl);
            }
            if (!event.final) {
              agentEvents = appendAgentRunEvent(agentEvents, {
                kind: "image_partial",
                status: "completed",
                title: copy("Streaming preview generated", "流式预览已生成"),
                imageUrl: nextPreviewUrl,
                index: event.index,
                partialImageIndex: event.partial_image_index,
                timestamp: new Date().toISOString(),
              });
            }
            // 分层:首张整图(final)出现后钉住主预览,后续逐层图只进事件列表、不覆盖主图。
            if (layeredGeneration && event.final) {
              layeredCompositePinned = true;
            }
            await publishStreamState({
              text,
              thinking,
              agent,
              agentEvents,
              imageUrl: previewUrl,
            });
            if (streamCardId && updateMain) {
              setBatchCards((prev) =>
                prev.map((card) =>
                  card.id === streamCardId && card.state === "loading"
                    ? { ...card, imageUrl: nextPreviewUrl }
                    : card
                )
              );
            }
          }
          return;
        }

        if (event.type === "completed") {
          completed = event;
          return;
        }

        if (event.type === "error") {
          failed = event;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          await processBlock(block);
        }
        if (done) break;
      }

      if (buffer.trim()) await processBlock(buffer);

      const failedResult = failed as ImageApiResult | null;
      if (!response.ok || failedResult) {
        throw createRequestError(
          failedResult?.error || `API error: ${response.status}`,
          failedResult?.creditsConsumed
        );
      }

      if (!completed) {
        throw new Error("API returned no image data");
      }

      return {
        ...completed,
        responseText: completed.responseText || text || undefined,
        responseThinking: completed.responseThinking || thinking || undefined,
        responseAgent: agent || completed.responseAgent || undefined,
        agentEvents: completed.agentEvents || agentEvents,
        agentRoundCount: completed.agentRoundCount,
        webConversation: completed.webConversation,
        responsesPreviousResponse: completed.responsesPreviousResponse,
      };
    };

    try {
      return await executeChatRequest();
    } finally {
      if (generationId) {
        activeChatRequestGenerationIdsRef.current.delete(generationId);
      }
    }
  };

  useEffect(() => {
    if (didLoadChatRef.current) return;
    try {
      if (chatMessages.length > 0 || chatConversations.length > 0) {
        chatConversationsRef.current = chatConversations;
        chatMessagesConversationIdRef.current = chatConversationId;
        chatMessagesModeRef.current = chatMessages.length
          ? inferChatConversationMode(chatMessages)
          : null;
        return;
      }

      const conversationRaw = window.localStorage.getItem(
        CHAT_CONVERSATIONS_STORAGE_KEY
      );
      const conversations = compactChatConversations(
        sanitizeChatConversations(
          conversationRaw ? JSON.parse(conversationRaw) : []
        )
      );

      const legacyRaw = window.localStorage.getItem(CHAT_STORAGE_KEY);
      const legacyMessages = sanitizeChatMessages(
        legacyRaw ? JSON.parse(legacyRaw) : []
      );
      const hasLegacyConversation =
        legacyMessages.length > 0 &&
        !conversations.some(
          (conversation) =>
            JSON.stringify(conversation.messages) ===
            JSON.stringify(legacyMessages)
        );
      const nextConversations = compactChatConversations(
        hasLegacyConversation
          ? [
              createChatConversation(
                legacyMessages,
                getChatConversationTitle(
                  legacyMessages,
                  isZh ? "历史对话" : "Previous chat"
                )
              ),
              ...conversations,
            ]
          : conversations
      );

      if (nextConversations.length > 0) {
        const sortedConversations = nextConversations
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )
          .slice(0, CHAT_CONVERSATION_LIMIT);
        const storedConversationMode = activeModeToConversationMode(
          readStoredCreateActiveMode()
        );
        const activeConversationId = window.localStorage.getItem(
          chatActiveConversationStorageKey(storedConversationMode)
        );
        const activeConversation =
          sortedConversations.find(
            (conversation) =>
              conversation.mode === storedConversationMode &&
              conversation.id === activeConversationId
          ) ||
          sortedConversations.find(
            (conversation) => conversation.mode === storedConversationMode
          ) ||
          sortedConversations[0];
        chatConversationsRef.current = sortedConversations;
        setChatConversations(sortedConversations);
        chatMessagesConversationIdRef.current = activeConversation?.id || null;
        chatMessagesModeRef.current = activeConversation?.mode || null;
        setChatConversationId(activeConversation?.id || createLocalId());
        setChatMessages(activeConversation?.messages || []);
        if (activeConversation) {
          window.localStorage.setItem(
            chatActiveConversationStorageKey(activeConversation.mode),
            activeConversation.id
          );
        }
      }
      window.localStorage.setItem(
        CHAT_CONVERSATIONS_STORAGE_KEY,
        JSON.stringify(
          compactChatConversations(nextConversations).slice(
            0,
            CHAT_CONVERSATION_LIMIT
          )
        )
      );
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
      window.localStorage.removeItem(CHAT_CONVERSATIONS_STORAGE_KEY);
      window.localStorage.removeItem(CHAT_ACTIVE_CONVERSATION_STORAGE_KEY);
      window.localStorage.removeItem(
        CHAT_ACTIVE_AGENT_CONVERSATION_STORAGE_KEY
      );
    } finally {
      didLoadChatRef.current = true;
    }
  }, []);

  // WHY 去抖:本 effect 每次 chatMessages 变化都要 sanitize + 推导标题 +
  // JSON.stringify 全部会话并同步写 localStorage,成本随会话历史线性增长。
  // 流式生成期 chatMessages 逐增量更新,同步执行等于每个 token 阻塞一次
  // 主线程(实测是"生成时卡/越用越卡"的主因之一)。改为尾沿去抖后,流式
  // 期间定时器持续被重置,回合结束或停顿 CHAT_PERSIST_DEBOUNCE_MS 后才
  // 真正落库;关页/卸载时经 pendingChatPersistRef 冲刷,不丢最后一轮。
  useEffect(() => {
    if (!didLoadChatRef.current) return;
    const persist = () => {
      pendingChatPersistRef.current = null;
      try {
        if (
          chatMessages.length > 0 &&
          chatMessagesConversationIdRef.current &&
          (chatMessagesConversationIdRef.current !== chatConversationId ||
            (chatMessagesModeRef.current &&
              chatMessagesModeRef.current !==
                inferChatConversationMode(chatMessages)))
        ) {
          return;
        }
        if (chatMessages.length === 0) {
          window.localStorage.removeItem(CHAT_STORAGE_KEY);
          return;
        }
        const persistedMessages = sanitizePersistedChatMessages(chatMessages);
        const conversationMode = inferChatConversationMode(persistedMessages);
        chatMessagesConversationIdRef.current = chatConversationId;
        chatMessagesModeRef.current = conversationMode;
        const title = getChatConversationTitle(
          persistedMessages.filter((message) =>
            isMessageInConversationMode(message, conversationMode)
          ),
          isZh ? "未命名对话" : "Untitled chat"
        );
        const now = new Date().toISOString();
        const previousConversations = chatConversationsRef.current;
        const existing = previousConversations.find(
          (conversation) => conversation.id === chatConversationId
        );
        const current: ChatConversation = {
          id: chatConversationId,
          mode: existing?.mode || conversationMode,
          title,
          messages: persistedMessages,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        const nextConversations = compactChatConversations([
          current,
          ...previousConversations.filter(
            (conversation) => conversation.id !== chatConversationId
          ),
        ]).slice(0, CHAT_CONVERSATION_LIMIT);
        chatConversationsRef.current = nextConversations;
        setChatConversations(nextConversations);
        window.localStorage.setItem(
          CHAT_CONVERSATIONS_STORAGE_KEY,
          JSON.stringify(nextConversations)
        );
        window.localStorage.setItem(
          chatActiveConversationStorageKey(current.mode),
          chatConversationId
        );
        window.localStorage.removeItem(CHAT_STORAGE_KEY);
      } catch {
        /* ignore local storage quota errors */
      }
    };
    pendingChatPersistRef.current = persist;
    const timer = window.setTimeout(persist, CHAT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [chatConversationId, chatMessages, isZh]);

  // 关页/组件卸载时冲刷去抖窗口内尚未落库的会话变更。
  useEffect(() => {
    const flushPendingChatPersist = () => {
      pendingChatPersistRef.current?.();
    };
    window.addEventListener("beforeunload", flushPendingChatPersist);
    return () => {
      window.removeEventListener("beforeunload", flushPendingChatPersist);
      flushPendingChatPersist();
    };
  }, []);

  useEffect(() => {
    if (!gpt55ChatAllowed && chatModel === GPT55_CHAT_MODEL) {
      setChatModel(GPT54_CHAT_MODEL);
    }
    if (!gpt55ChatAllowed && imageGptModel === GPT55_CHAT_MODEL) {
      setImageGptModel("default");
    }
  }, [chatModel, gpt55ChatAllowed, imageGptModel]);

  useEffect(() => {
    if (!firstPreviewUrl) {
      setFirstImageSize(null);
      setMaskEditorOpen(false);
      setMaskPoints([]);
      setMaskFile((prev) => {
        if (prev) revokePreview(prev.previewUrl);
        return null;
      });
      return;
    }

    const img = new window.Image();
    img.onload = () => {
      const nextImageSize = {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      };
      setFirstImageSize(nextImageSize);
      setMaskPoints([]);
      setMaskFile((prev) => {
        if (prev) revokePreview(prev.previewUrl);
        return null;
      });
    };
    img.onerror = () => {
      setFirstImageSize(null);
      setMaskEditorOpen(false);
    };
    img.src = firstPreviewUrl;
  }, [firstPreviewUrl]);

  useEffect(() => {
    if (!chatFirstPreviewUrl) {
      setChatFirstImageSize(null);
      return;
    }

    const img = new window.Image();
    img.onload = () => {
      setChatFirstImageSize({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => {
      setChatFirstImageSize(null);
    };
    img.src = chatFirstPreviewUrl;
  }, [chatFirstPreviewUrl]);

  useEffect(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas || !firstImageSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(220, 38, 38, 0.46)";
    for (const point of maskPoints) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [maskPoints, firstImageSize]);

  const addSuccessfulResult = (
    data: ChatResultInput,
    resultPrompt: string,
    fallbackSize = size,
    options?: {
      syncCredits?: boolean;
      addRecent?: boolean;
      previewMode?: VisualOutputMode | null;
    }
  ): ChatVariant | null => {
    const syncCredits = options?.syncCredits ?? true;
    const addRecent = options?.addRecent ?? true;
    const previewMode = options?.previewMode;
    const model = data.model || DEFAULT_IMAGE_MODEL;
    const resultSize = data.size || fallbackSize;
    if (!data.imageUrl && !data.responseText) return null;

    const isAgentDraft = data.outputRole === "agent_draft";
    if (
      previewMode !== null &&
      data.imageUrl &&
      data.generationId &&
      !isAgentDraft
    ) {
      const nextResult: ResultState = {
        generationId: data.generationId,
        imageUrl: data.imageUrl,
        prompt: resultPrompt,
        model,
        size: resultSize,
        creditsConsumed: data.creditsConsumed,
      };
      if (data.revisedPrompt) nextResult.revisedPrompt = data.revisedPrompt;
      if (data.promptRepairNotice) {
        nextResult.promptRepairNotice = data.promptRepairNotice;
      }
      setResult(nextResult);
      if (previewMode) {
        setVisualResults((prev) => ({ ...prev, [previewMode]: nextResult }));
      }
    }
    if (syncCredits) {
      setBalance(
        (b) =>
          Math.round(Math.max(0, b - (data.creditsConsumed || 0)) * 100) / 100
      );
    }
    if (addRecent && data.imageUrl && data.generationId && !isAgentDraft) {
      const generationId = data.generationId;
      setRecent((prev) => [
        {
          id: generationId,
          prompt: resultPrompt,
          revisedPrompt: data.revisedPrompt || null,
          model,
          size: resultSize,
          creditsConsumed: data.creditsConsumed || 0,
          status: "completed",
          imageUrl: data.imageUrl || null,
          createdAt: new Date().toISOString(),
          canDelete: true,
          isLayered: data.layered,
        },
        ...prev.slice(0, 5),
      ]);
    }

    return {
      generationId: data.generationId,
      imageUrl: data.imageUrl,
      imageFileId: data.imageFileId,
      webImageMessageId: data.webImageMessageId,
      webImageGroupId: data.webImageGroupId,
      prompt: resultPrompt,
      model,
      size: resultSize,
      revisedPrompt: data.revisedPrompt,
      promptRepairNotice: data.promptRepairNotice,
      responseText: data.responseText,
      responseThinking: data.responseThinking,
      responseAgent: data.responseAgent,
      agentEvents: data.agentEvents,
      agentRoundCount: data.agentRoundCount,
      webConversation: data.webConversation,
      backendMember: data.backendMember,
      responsesPreviousResponse: data.responsesPreviousResponse,
      creditsConsumed: data.creditsConsumed,
      createdAt: new Date().toISOString(),
      outputRole: data.outputRole,
    };
  };

  const expandChatImageOutputs = (data: ImageApiResult): ChatResultInput[] => {
    const outputs = (data.imageOutputs || [])
      .filter((item) => item.imageUrl && item.generationId)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (outputs.length === 0) return [data];

    const outputUrlByIndex = new Map<number, string>();
    for (const [index, output] of outputs.entries()) {
      if (output.imageUrl)
        outputUrlByIndex.set(output.index ?? index, output.imageUrl);
    }

    return outputs.map((output, index) => {
      const isLast = index === outputs.length - 1;
      const isChoice = output.outputRole === "choice";
      const choiceConversation =
        isChoice && data.webConversation
          ? {
              ...data.webConversation,
              selectedImageMessageId:
                output.webImageMessageId ||
                data.webConversation.selectedImageMessageId,
            }
          : undefined;
      const outputAgentEvents = isLast
        ? (data.agentEvents || []).map((event) => {
            if (
              event.kind === "image_generation" &&
              event.status === "completed" &&
              event.imageUrl === undefined
            ) {
              const imageUrl = outputUrlByIndex.get(event.index ?? -1);
              return imageUrl ? { ...event, imageUrl } : event;
            }
            return event;
          })
        : undefined;
      return {
        generationId: output.generationId,
        imageUrl: output.imageUrl,
        imageFileId: output.imageFileId,
        webImageMessageId: output.webImageMessageId,
        webImageGroupId: output.webImageGroupId,
        model: data.model,
        size: output.size || data.size,
        revisedPrompt:
          output.revisedPrompt ||
          output.upstreamRevisedPrompt ||
          data.revisedPrompt,
        promptRepairNotice:
          output.promptRepairNotice || data.promptRepairNotice,
        responseText: isChoice || isLast ? data.responseText : undefined,
        responseThinking: isLast ? data.responseThinking : undefined,
        responseAgent: isLast ? data.responseAgent : undefined,
        agentEvents: outputAgentEvents,
        agentRoundCount: isLast ? data.agentRoundCount : undefined,
        webConversation:
          choiceConversation || (isLast ? data.webConversation : undefined),
        backendMember: data.backendMember,
        responsesPreviousResponse: isLast
          ? data.responsesPreviousResponse
          : undefined,
        creditsConsumed: isLast ? data.creditsConsumed : 0,
        outputRole: output.outputRole || (isLast ? "final" : "agent_draft"),
      };
    });
  };

  const addSuccessfulChatResults = (
    data: ImageApiResult,
    resultPrompt: string,
    fallbackSize = size,
    options?: { syncCredits?: boolean }
  ) => {
    const shouldSyncCredits = options?.syncCredits ?? true;
    const expanded = expandChatImageOutputs(data);
    const variants: ChatVariant[] = [];
    for (const [index, item] of expanded.entries()) {
      const variant = addSuccessfulResult(item, resultPrompt, fallbackSize, {
        syncCredits: shouldSyncCredits && index === expanded.length - 1,
        addRecent: false,
        previewMode: null,
      });
      if (variant) variants.push(variant);
    }
    if (variants.length > 0) {
      const activeChoiceIndex = variants.findIndex(
        (variant) =>
          variant.outputRole === "choice" &&
          variant.webConversation?.selectedImageMessageId &&
          variant.webImageMessageId ===
            variant.webConversation.selectedImageMessageId
      );
      if (activeChoiceIndex >= 0 && activeChoiceIndex < variants.length - 1) {
        const [selected] = variants.splice(activeChoiceIndex, 1);
        variants.push(selected!);
      }
      const nextRecent = variants
        .filter((variant) => variant.imageUrl && variant.generationId)
        .toReversed()
        .map((variant, index) => ({
          id: variant.generationId!,
          prompt: resultPrompt,
          revisedPrompt: variant.revisedPrompt || null,
          model: variant.model,
          size: variant.size,
          creditsConsumed: index === 0 ? data.creditsConsumed || 0 : 0,
          status: "completed" as const,
          imageUrl: variant.imageUrl || null,
          createdAt: new Date().toISOString(),
          canDelete: index === 0,
          isLayered: data.layered,
        }));
      if (nextRecent.length > 0) {
        setRecent((prev) => {
          const known = new Set(prev.map((item) => item.id));
          const uniqueNext = nextRecent.filter((item) => !known.has(item.id));
          return [...uniqueNext, ...prev].slice(0, 6);
        });
      }
    }
    return variants;
  };

  const addSuccessfulResults = (
    data: ImageApiResult,
    resultPrompt: string,
    fallbackSize = size,
    options?: { syncCredits?: boolean; previewMode?: VisualOutputMode }
  ) => {
    const successfulResults =
      data.results?.filter((item) => item.imageUrl && item.generationId) ||
      (data.imageUrl && data.generationId ? [data] : []);

    if (successfulResults.length === 0) return [];

    const variants: ChatVariant[] = [];
    for (const item of successfulResults.toReversed()) {
      const variant = addSuccessfulResult(item, resultPrompt, fallbackSize, {
        syncCredits: options?.syncCredits ?? true,
        previewMode: options?.previewMode,
      });
      if (variant) {
        variants.unshift(variant);
      }
    }

    return variants;
  };

  const syncChargedCredits = (creditsConsumed?: number) => {
    if (!creditsConsumed || creditsConsumed <= 0) return;
    setBalance((b) => Math.round(Math.max(0, b - creditsConsumed) * 100) / 100);
  };

  const syncWaterfallCredits = (creditsConsumed?: number) => {
    if (!creditsConsumed || creditsConsumed <= 0) return;
    setWaterfallCreditsConsumed(
      (value) => Math.round((value + creditsConsumed) * 100) / 100
    );
  };

  const showGenerationError = (
    message: string,
    options?: { creditsConsumed?: number }
  ) => {
    syncChargedCredits(options?.creditsConsumed);

    if (message.toLowerCase().includes("insufficient credits")) {
      toast.error(copy("Insufficient credits", "积分不足"), {
        description: copy(
          "You don't have enough credits to generate an image.",
          "当前积分不足，无法生成图片。"
        ),
        action: {
          label: copy("Top up", "去充值"),
          onClick: () => {
            window.location.href = `/${locale}/dashboard/credits/buy`;
          },
        },
      });
      return;
    }

    toast.error(copy("Generation failed", "生成失败"), {
      description: message,
    });
  };

  const addChatAttachments = async (files: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (!uploadFiles.length) return;

    const accepted: ChatAttachment[] = [];
    for (const file of uploadFiles) {
      const isImage = isImageFile(file);
      if (!isImage && !isReadableChatFile(file)) {
        toast.error(copy("Unsupported file type", "不支持的文件类型"), {
          description: copy(
            "Use PNG/JPEG/WebP images, PDF, or text/code files.",
            "请使用 PNG/JPEG/WebP 图片、PDF，或文本/代码文件。"
          ),
        });
        continue;
      }
      if (file.size > maxImageBytes) {
        toast.error(copy("File too large", "文件过大"), {
          description: copy(
            `${file.name} exceeds ${formatMegabytes(maxImageBytes)}.`,
            `${file.name} 超过 ${formatMegabytes(maxImageBytes)}。`
          ),
        });
        continue;
      }
      try {
        accepted.push({
          file,
          kind: isImage ? "image" : "file",
          previewUrl: isImage ? await readFileAsDataUrl(file) : "",
        });
      } catch {
        toast.error(copy("Failed to load attachment", "附件加载失败"), {
          description:
            file.name ||
            copy("Could not read the selected file.", "无法读取所选文件。"),
        });
      }
    }

    if (!accepted.length) return;

    setChatAttachments((prev) => {
      const slots = maxChatImages - prev.length;
      if (slots <= 0) {
        for (const item of accepted) {
          revokePreview(item.previewUrl || "");
        }
        toast.error(
          copy(
            `Attach up to ${maxChatImages} files`,
            `最多可添加 ${maxChatImages} 个附件`
          )
        );
        return prev;
      }

      const next = accepted.slice(0, slots);
      for (const item of accepted.slice(slots)) {
        revokePreview(item.previewUrl || "");
      }
      if (accepted.length > slots) {
        toast.error(
          copy(
            `Only ${slots} more attachment(s) can be added`,
            `还可以再添加 ${slots} 个附件`
          )
        );
      }
      return [...prev, ...next];
    });
  };

  const removeChatAttachment = (index: number) => {
    setChatAttachments((prev) => {
      const target = prev[index];
      if (target) revokePreview(target.previewUrl || "");
      const next = prev.filter((_, itemIndex) => itemIndex !== index);
      return next;
    });
  };

  const clearChatAttachments = () => {
    setChatAttachments((prev) => {
      for (const item of prev) {
        revokePreview(item.previewUrl || "");
      }
      return [];
    });
  };

  const attachImageUrlToChat = async (
    imageUrl: string,
    name: string,
    sourceId?: string
  ) => {
    if (chatAttachments.some((item) => item.sourceId === sourceId)) {
      toast.success(
        copy("Reference image is already attached", "参考图片已添加")
      );
      return;
    }
    if (chatAttachments.length >= maxChatImages) {
      toast.error(
        copy(
          `Attach up to ${maxChatImages} reference images`,
          `最多可添加 ${maxChatImages} 张参考图片`
        )
      );
      return;
    }

    try {
      const item = await urlToEditImageFile(imageUrl, name, sourceId);
      setChatAttachments((prev) => [...prev, { ...item, kind: "image" }]);
      if (!isConversationMode(activeMode)) {
        setActiveMode("chat");
      }
      toast.success(copy("Reference image attached", "参考图片已添加"));
    } catch (error) {
      toast.error(copy("Failed to attach image", "添加图片失败"), {
        description:
          error instanceof Error
            ? error.message
            : copy("Could not load image.", "无法加载图片。"),
      });
    }
  };

  const attachResultToChat = async (variant?: ChatVariant) => {
    const imageUrl = variant?.imageUrl || result?.imageUrl;
    const id = variant?.generationId || result?.generationId;
    if (!imageUrl || !id) return;
    await attachImageUrlToChat(imageUrl, `gpt2image-${id}`, id);
  };

  const findPrecedingUserMessage = (assistantIndex: number) => {
    const assistantMessage = chatMessages[assistantIndex];
    const targetMode =
      assistantMessage?.mode === "agent" ? "agent" : ("chat" as const);
    for (let index = assistantIndex - 1; index >= 0; index--) {
      const message = chatMessages[index];
      if (
        message?.role === "user" &&
        isMessageInConversationMode(message, targetMode)
      ) {
        return message;
      }
    }
    return null;
  };

  const syncWebImageSelection = async (variant?: ChatVariant | null) => {
    if (
      variant?.outputRole !== "choice" ||
      !variant.generationId ||
      !variant.webImageMessageId ||
      !variant.webConversation?.selectionMessageId
    ) {
      return;
    }

    try {
      const response = await fetch("/api/images/chat/web-select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: variant.generationId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error || "Failed to sync Web selection");
      }
    } catch (error) {
      toast.error(
        copy("Failed to sync Web image choice", "同步 Web 图片选择失败"),
        {
          description:
            error instanceof Error
              ? error.message
              : copy(
                  "The local selection is still preserved.",
                  "本地选择仍会保留。"
                ),
        }
      );
    }
  };

  const handleChatVariantSelect = (messageId: string, nextIndex: number) => {
    let selectedVariant: ChatVariant | null = null;
    setChatMessages((prev) =>
      prev.map((message) => {
        if (message.id !== messageId) return message;
        const variants = getChatVariants(message);
        const next = Math.max(
          0,
          Math.min(variants.length - 1, Math.floor(nextIndex))
        );
        selectedVariant = variants[next] || null;
        return {
          ...message,
          activeVariant: next,
        };
      })
    );
    void syncWebImageSelection(selectedVariant);
  };

  const handleChatVariantChange = (messageId: string, direction: -1 | 1) => {
    const message = chatMessages.find((item) => item.id === messageId);
    const current = message?.activeVariant || 0;
    handleChatVariantSelect(messageId, current + direction);
  };

  const handleChatRetry = async (assistantId: string) => {
    if (isChatGenerating) return;

    const assistantIndex = chatMessages.findIndex(
      (message) => message.id === assistantId
    );
    if (assistantIndex < 0) return;
    const userMessage = findPrecedingUserMessage(assistantIndex);
    if (!userMessage?.text) return;

    const assistantMessage = chatMessages[assistantIndex];
    if (!assistantMessage) return;
    const activeVariant = getActiveChatVariant(assistantMessage);
    const retrySize = activeVariant?.size || size;
    const generationId = createGenerationId();
    const userIndex = chatMessages.findIndex(
      (message) => message.id === userMessage.id
    );
    const conversationMode =
      assistantMessage.mode === "agent" ? "agent" : ("chat" as const);
    const historyMessages = (
      userIndex >= 0
        ? chatMessages.slice(0, userIndex)
        : chatMessages.slice(0, assistantIndex)
    ).filter((message) =>
      isMessageInConversationMode(message, conversationMode)
    );
    const pendingVariant = mergeChatVariant(undefined, {
      generationId,
      prompt: userMessage.text,
      model: chatImageModel !== "default" ? chatImageModel : chatModel,
      size: retrySize,
      agentEvents:
        assistantMessage.mode === "agent" || userMessage.mode === "agent"
          ? createOptimisticAgentRoundEvents(1)
          : undefined,
      pending: true,
    });
    const pendingMessages = chatMessages.map((message) => {
      if (message.id !== assistantId) return message;
      const variants = getChatVariants(message);
      return {
        ...message,
        error: undefined,
        variants: [...variants, pendingVariant],
        activeVariant: variants.length,
      };
    });

    setRetryingChatMessageId(assistantId);
    setIsChatGenerating(true);
    setChatStream(
      createInitialChatStreamState({
        messageId: assistantId,
        mode: conversationMode,
        agentMode:
          assistantMessage.mode === "agent" || userMessage.mode === "agent",
        generationId,
        prompt: userMessage.text,
        model: chatImageModel !== "default" ? chatImageModel : chatModel,
        size: retrySize,
      })
    );
    setChatMessages(pendingMessages);
    persistChatConversationSnapshot({
      conversations: chatConversationsRef.current,
      conversationId: chatConversationId,
      mode: conversationMode,
      messages: pendingMessages,
      titleFallback: isZh ? "未命名对话" : "Untitled chat",
    });

    try {
      const data = await runChatRequest({
        prompt: userMessage.text,
        fallbackSize: retrySize,
        historyMessages,
        generationId,
        streamMessageId: assistantId,
        agentMode:
          assistantMessage.mode === "agent" || userMessage.mode === "agent",
      });
      const newVariants = addSuccessfulChatResults(
        data,
        userMessage.text,
        retrySize
      );
      const variant = newVariants[newVariants.length - 1];
      if (!variant || newVariants.length === 0) {
        throw new Error(
          copy("API returned no image data", "接口未返回图片数据")
        );
      }

      setChatMessages((prev) =>
        prev.map((message) => {
          if (message.id !== assistantId) return message;
          const existingVariants = getChatVariants(message);
          const replacedIndex = existingVariants.findIndex(
            (item) => item.generationId === generationId
          );
          const variants = replaceChatVariantByGenerationId(
            existingVariants,
            generationId,
            newVariants
          );
          const activeVariantIndex =
            replacedIndex >= 0
              ? replacedIndex + newVariants.length - 1
              : variants.length - 1;
          return {
            ...message,
            error: undefined,
            text:
              variant.responseText ||
              (variant.imageUrl
                ? copy("Image generated", "图片已生成")
                : copy("Response generated", "回复已生成")),
            variants: variants.map((item) => ({
              ...item,
              pending: false,
            })),
            activeVariant: activeVariantIndex,
          };
        })
      );
      if (isCreatePageMountedRef.current) {
        toast.success(copy("Variant generated", "新版本已生成"));
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy("Retry failed.", "重试失败。");
      const creditsConsumed =
        error instanceof Error
          ? (error as GenerationRequestError).creditsConsumed
          : undefined;
      syncChargedCredits(creditsConsumed);
      setChatMessages((prev) =>
        prev.map((item) =>
          item.id === assistantId
            ? {
                ...item,
                variants: getChatVariants(item).map((variant) => ({
                  ...variant,
                  pending: false,
                })),
              }
            : item
        )
      );
      if (isCreatePageMountedRef.current) {
        toast.error(copy("Retry failed", "重试失败"), { description: message });
      }
    } finally {
      setRetryingChatMessageId(null);
      setIsChatGenerating(false);
      setChatStream(null);
      clearStreamingPreview();
      if (isCreatePageMountedRef.current) {
        scrollChatToBottom();
      }
    }
  };

  const saveBatchCardToRecent = (card: BatchCard) => {
    if (!card.imageUrl || !card.generationId) return;

    setRecent((prev) => {
      if (prev.some((item) => item.id === card.generationId)) return prev;
      return [
        {
          id: card.generationId || createLocalId(),
          prompt: card.prompt,
          revisedPrompt: null,
          model: card.model || DEFAULT_IMAGE_MODEL,
          size: card.size,
          creditsConsumed: 0,
          status: "completed",
          imageUrl: card.imageUrl || null,
          createdAt: new Date().toISOString(),
          canDelete: false,
        },
        ...prev.slice(0, 5),
      ];
    });
    setBatchCards((prev) =>
      prev.map((item) =>
        item.id === card.id ? { ...item, saved: true } : item
      )
    );
    toast.success(copy("Saved to recent", "已保存到最近生成"));
  };

  const handleBatchSuggestion = (suggestion: string) => {
    setBatchPrompt(suggestion);
  };

  const renderThinkingBlock = (thinking?: string, open = false) => {
    if (!thinking) return null;
    return (
      <details
        className="mb-3 rounded-md border border-border bg-muted/30 p-2"
        open={open}
      >
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {copy("Thinking", "思考过程")}
        </summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {thinking}
        </p>
      </details>
    );
  };

  const renderAgentBlock = (agent?: string, open = false) => {
    if (!agent || !showAgentProcessHint) return null;
    return (
      <details
        className="mb-3 rounded-md border border-border bg-muted/30 p-2"
        open={open}
      >
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {copy("Agent run", "运行过程")}
        </summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {agent}
        </p>
      </details>
    );
  };

  const agentEventLabel = (event: AgentRunEvent) => {
    if (event.kind === "web_search") return copy("Search", "联网");
    if (event.kind === "code_interpreter") return copy("Code", "代码");
    if (event.kind === "image_generation") return copy("Image", "生图");
    if (event.kind === "image_partial") return copy("Stream", "流式");
    if (event.kind === "reasoning") return copy("Thinking", "思考");
    if (event.kind === "message") return copy("Message", "消息");
    if (event.toolType === "agent_decision") return copy("Decision", "决策");
    return copy("Tool", "工具");
  };

  const agentEventStatusLabel = (event: AgentRunEvent) => {
    if (event.status === "completed") return copy("done", "完成");
    if (event.status === "failed") return copy("failed", "失败");
    if (event.status === "running") return copy("running", "运行中");
    return copy("started", "开始");
  };

  const agentTaskStatusLabel = (status?: AgentRunEvent["status"]) => {
    if (status === "completed") return copy("Done", "完成");
    if (status === "failed") return copy("Failed", "失败");
    if (status === "running") return copy("Running", "运行中");
    return copy("Started", "开始");
  };

  const agentTaskIcon = (kind: AgentRunEvent["kind"]) => {
    if (kind === "web_search") return <Search className="h-3.5 w-3.5" />;
    if (kind === "code_interpreter")
      return <FileText className="h-3.5 w-3.5" />;
    if (kind === "image_generation" || kind === "image_partial") {
      return <ImagePlus className="h-3.5 w-3.5" />;
    }
    if (kind === "reasoning") return <CircleHelp className="h-3.5 w-3.5" />;
    return <Wand2 className="h-3.5 w-3.5" />;
  };

  const agentTaskBorderClass = (status?: AgentRunEvent["status"]) => {
    if (status === "completed") return "border-success/35";
    if (status === "failed") return "border-destructive/50";
    if (status === "running") return "border-primary/40";
    return "border-border";
  };

  const agentTaskStatusClass = (status?: AgentRunEvent["status"]) => {
    if (status === "completed") {
      return "border-success/30 bg-success/10 text-success";
    }
    if (status === "failed") {
      return "border-destructive/30 bg-destructive/10 text-destructive";
    }
    if (status === "running") {
      return "border-primary/30 bg-primary/10 text-primary";
    }
    return "border-border bg-muted text-muted-foreground";
  };

  const renderAgentTaskCard = (task: AgentTaskCard) => (
    <div
      key={task.key}
      className={`rounded-md border bg-background p-2.5 ${agentTaskBorderClass(
        task.status
      )}`}
    >
      {(() => {
        const firstEvent = task.events[0] || {
          kind: task.kind,
          title: task.title,
          status: task.status,
          toolType: task.toolType,
        };
        return (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                  {agentTaskIcon(task.kind)}
                </span>
                <span className="text-xs font-semibold text-foreground">
                  {agentEventLabel({ ...firstEvent, kind: task.kind })}
                </span>
                {task.toolType && (
                  <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {task.toolType}
                  </span>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-xs font-medium leading-relaxed text-foreground">
                {task.title}
              </p>
              {task.detail && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                  {task.detail}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${agentTaskStatusClass(
                task.status
              )}`}
            >
              {agentTaskStatusLabel(task.status)}
            </span>
          </div>
        );
      })()}
      {task.imageUrl && (
        <div className="mt-2 max-w-[240px] overflow-hidden rounded-md border bg-muted">
          <Image
            src={thumbSrc(task.imageUrl, 480)}
            alt={task.title}
            width={240}
            height={240}
            className="h-auto w-full object-contain"
            unoptimized={shouldBypassImageOptimization(task.imageUrl)}
          />
        </div>
      )}
      {task.events.length > 1 && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {task.events.slice(-3).map((event, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 事件为追加型日志、仅取末3条且不重排,index 与状态组合作 key 安全
              key={`${task.key}-event-${event.status || ""}-${index}`}
              className="flex items-center gap-2 text-[11px] text-muted-foreground"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45" />
              <span>{agentEventStatusLabel(event)}</span>
              {event.detail && (
                <span className="min-w-0 truncate">{event.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderAgentRoundCards = (
    events?: AgentRunEvent[],
    fallbackAgent?: string,
    open = false
  ) => {
    if (!showAgentProcessHint) return null;
    const rounds = buildAgentRoundCards(events);
    if (rounds.length === 0) return renderAgentBlock(fallbackAgent, open);

    return (
      <details
        className="mb-3 rounded-md border border-border bg-muted/30 p-2"
        open={open}
      >
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {copy("Agent tasks", "Agent 任务")}
        </summary>
        <div className="mt-3 space-y-3">
          {rounds.map((round, index) => (
            <section
              key={round.key}
              className="rounded-md border border-border bg-muted/20 p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    {round.title ||
                      copy(`Round ${index + 1}`, `第 ${index + 1} 轮`)}
                  </p>
                  {round.detail && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {round.detail}
                    </p>
                  )}
                </div>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${agentTaskStatusClass(
                    round.status
                  )}`}
                >
                  {agentTaskStatusLabel(round.status)}
                </span>
              </div>
              {round.tasks.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {round.tasks.map(renderAgentTaskCard)}
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy("No tool task in this round.", "本轮暂无工具任务。")}
                </p>
              )}
              {round.notes.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-border pt-2">
                  {round.notes.map((note, noteIndex) => (
                    <p
                      // biome-ignore lint/suspicious/noArrayIndexKey: round notes 为追加型、不重排,noteIndex 作 key 安全
                      key={`${round.key}-note-${noteIndex}`}
                      className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground"
                    >
                      {note.title}
                      {note.detail ? ` - ${note.detail}` : ""}
                    </p>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
        {fallbackAgent && (
          <details className="mt-3 border-t border-border pt-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              {copy("Raw log", "原始日志")}
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {fallbackAgent}
            </p>
          </details>
        )}
      </details>
    );
  };

  const renderChatStreamBubble = (messageId?: string) => {
    if (!chatStream || chatStream.messageId !== messageId) return null;
    const isAgentStream = chatStream.mode === "agent";
    const hasVisibleAgentProgress =
      isAgentStream && chatStream.agentEvents.length > 0;
    return (
      <div className="rounded-lg rounded-bl-[5px] border border-border bg-background px-3 py-3 text-sm text-foreground">
        {renderThinkingBlock(chatStream.thinking, true)}
        {hasVisibleAgentProgress
          ? renderAgentRoundCards(
              chatStream.agentEvents,
              chatStream.agent,
              true
            )
          : null}
        {chatStream.text && (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {chatStream.text}
          </p>
        )}
        {chatStream.imageUrl && (
          <div className="relative mt-3 max-w-sm overflow-hidden rounded-md border bg-muted">
            <Image
              src={chatStream.imageUrl}
              alt={copy("Streaming preview", "流式预览")}
              width={320}
              height={320}
              className="h-auto w-full object-contain"
              unoptimized={shouldBypassImageOptimization(chatStream.imageUrl)}
            />
          </div>
        )}
        {!chatStream.text &&
          !chatStream.imageUrl &&
          !hasVisibleAgentProgress && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {copy("Generating...", "生成中...")}
            </div>
          )}
      </div>
    );
  };

  const renderChatInput = () => {
    const isEditChat = hasChatImageAttachments;
    const activeChatSize = isEditChat ? chatCustomEditSize : size;

    return (
      <form
        onSubmit={handleChatSubmit}
        onPaste={handleChatPaste}
        className="border-t border-border p-3"
      >
        {chatAttachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {chatAttachments.map((item, index) => (
              <button
                type="button"
                key={`${item.file.name}-${item.previewUrl || item.file.size}`}
                className="group relative h-12 w-12 overflow-hidden rounded-md border bg-muted"
                onClick={() => removeChatAttachment(index)}
                disabled={isChatGenerating}
                title={copy("Remove attachment", "移除附件")}
              >
                {item.kind === "image" && item.previewUrl ? (
                  <Image
                    src={item.previewUrl}
                    alt={
                      item.file.name ||
                      copy(`Reference ${index + 1}`, `参考图片 ${index + 1}`)
                    }
                    fill
                    sizes="48px"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center px-1">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  </span>
                )}
                <span className="absolute inset-0 hidden items-center justify-center bg-background/70 group-hover:flex">
                  <X className="h-3.5 w-3.5 text-foreground" />
                </span>
              </button>
            ))}
          </div>
        )}

        {!chatWebFileMode && (
          <>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {renderGptModelSelect({
            id: "chat-gpt-model",
            value: chatModel,
            onChange: (value) => {
              if (value !== "default") setChatModel(value);
            },
            disabled: isChatGenerating,
            compact: true,
          })}
          {showImageModelControls && (
            <div
              className={chatMixWebFirstActive ? "opacity-55" : ""}
              title={
                chatMixWebFirstActive ? responsesOnlyDisabledReason : undefined
              }
            >
              {renderImageModelSelect({
                id: "chat-image-model",
                value: chatImageModel,
                onChange: setChatImageModel,
                disabled: isChatGenerating || chatMixWebFirstActive,
                compact: true,
              })}
            </div>
          )}
          {showThinkingControls &&
            renderThinkingSelect({
              id: "chat-thinking",
              value: chatThinking,
              onChange: setChatThinking,
              disabled: isChatGenerating,
              compact: true,
            })}
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
                id: "chat-background",
                disabled: isChatGenerating || chatMixWebFirstActive,
                compact: true,
              })}
            </div>
          )}
          {!isWebOnlyBackend &&
            activeMode !== "agent" &&
            renderTransparentMatteToggle({
              id: "chat-transparent-matte",
              disabled: isChatGenerating || chatMixWebFirstActive,
            })}
          {renderHdRepairToggle({
            id: "chat-hd-repair",
            disabled: isChatGenerating,
          })}
          <Button
            type="button"
            variant="outline"
            onClick={() => setChatSizeDialogOpen(true)}
            disabled={isChatGenerating}
            className="h-8 rounded-full px-3 text-xs"
            title={resolutionHelpText}
          >
            {copy("Size", "尺寸")} ·{" "}
            {activeChatSize === AUTO_IMAGE_SIZE
              ? autoSizeLabel
              : activeChatSize}
          </Button>
          {activeMode === "agent" && (
            <div className="flex items-center gap-2 rounded-full border border-border bg-background px-2 py-1">
              <label
                htmlFor="agent-force-rounds"
                className="flex items-center gap-1.5 text-xs text-foreground"
                title={copy(
                  "When enabled, Agent runs all selected rounds instead of stopping when the model does not request continue_generation.",
                  "开启后，Agent 会跑满所选轮数，而不是在模型未请求 continue_generation 时提前停止。"
                )}
              >
                <Checkbox
                  id="agent-force-rounds"
                  checked={agentForceRounds}
                  onCheckedChange={(checked) =>
                    setAgentForceRounds(checked === true)
                  }
                  disabled={isChatGenerating}
                />
                {copy("Force", "强制")}
              </label>
              <label
                htmlFor="layered-generation"
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  layeredGeneration
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-primary/40 bg-primary/5 text-foreground"
                }`}
                title={copy(
                  "Split into PSD layers: the agent first creates the full image, then decomposes it into editable layers (background + each element) for PSD export.",
                  "打散元素生成 PSD:先出整图,再把整图打散成可编辑图层(背景 + 每个元素各一层),完成后可导出分层 PSD。"
                )}
              >
                <Checkbox
                  id="layered-generation"
                  checked={layeredGeneration}
                  onCheckedChange={(checked) =>
                    setLayeredGeneration(checked === true)
                  }
                  disabled={isChatGenerating}
                />
                {copy("Split into PSD layers", "打散元素生成 PSD")}
              </label>
              <Select
                value={String(agentMaxRounds)}
                onValueChange={(value) =>
                  setAgentMaxRounds(Math.min(8, Math.max(1, Number(value))))
                }
                disabled={isChatGenerating}
              >
                <SelectTrigger className="h-7 w-[86px] border-0 px-2 text-xs shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((round) => (
                    <SelectItem key={round} value={String(round)}>
                      {copy(`${round} rounds`, `${round} 轮`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {helpMarker(copy("Resolution", "分辨率"), resolutionHelpText)}
          {isEditChat && chatFirstImageOriginalSize && (
            <span className="text-xs text-muted-foreground">
              {copy("Reference", "参考图")} {chatFirstImageOriginalSize}
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {customApiActive && !chatHasImageReference ? (
              <span className="font-medium text-foreground">
                {customApiBillingLabel}
              </span>
            ) : (
              <>
                {copy("Cost", "费用")}{" "}
                <span className="font-medium text-foreground">
                  {formattedChatSingleCreditCost}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="mb-2">
          {promptOptimizationField(
            "chat-prompt-optimization",
            isChatGenerating
          )}
        </div>
          </>
        )}

        {activeMode === "chat-web" && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {copy("Mode", "模式")}:
            </span>
            {(
              [
                { value: "image", en: "Chat", zh: "对话" },
                { value: "ppt", en: "PPT", zh: "PPT" },
                { value: "psd", en: "PSD", zh: "PSD" },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.value}
                type="button"
                size="sm"
                variant={chatWebGenKind === opt.value ? "default" : "outline"}
                disabled={isChatGenerating}
                onClick={() => setChatWebGenKind(opt.value)}
              >
                {copy(opt.en, opt.zh)}
              </Button>
            ))}
            {chatWebGenKind === "psd" && (
              <span className="text-xs text-muted-foreground">
                {copy("(reference image required)", "(需参考图)")}
              </span>
            )}
          </div>
        )}

        <div className="relative flex items-end gap-2 rounded-lg border border-border bg-background p-2">
          {renderReferenceMentionMenu({
            open: Boolean(chatMention?.open) && canUseChatReferenceMentions,
            options: filteredChatReferenceOptions,
            onSelect: selectChatMention,
            emptyText: copy(
              "No reference images available.",
              "暂无可引用图片。"
            ),
          })}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => chatImageInputRef.current?.click()}
            disabled={
              isChatGenerating || chatAttachments.length >= maxChatImages
            }
            title={copy("Attach image or file", "添加图片或文件")}
          >
            <Upload className="h-4 w-4" />
          </Button>
          <PromptTextareaField
            promptKey="chatPrompt"
            textareaRef={chatPromptRef}
            onValueChange={handleChatPromptChange}
            placeholder={copy("Continue creating...", "继续描述你的创作...")}
            rows={1}
            disabled={isChatGenerating}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 py-2 text-base shadow-none focus-visible:ring-0"
            onBlur={() => setTimeout(() => setChatMention(null), 120)}
            onClick={(event) => {
              const target = event.currentTarget;
              setChatMention(
                canUseChatReferenceMentions
                  ? getMentionTrigger(
                      target.value,
                      target.selectionStart ?? target.value.length
                    )
                  : null
              );
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                chatMention?.open &&
                filteredChatReferenceOptions[0]
              ) {
                event.preventDefault();
                selectChatMention(filteredChatReferenceOptions[0]);
                return;
              }
              if (event.key === "Escape" && chatMention?.open) {
                event.preventDefault();
                setChatMention(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            type="submit"
            size="icon-sm"
            disabled={isChatGenerating || !chatPromptHasText}
            title={copy("Send", "发送")}
          >
            {isChatGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
          <input
            ref={chatImageInputRef}
            type="file"
            multiple
            accept={CHAT_ATTACHMENT_ACCEPT}
            className="sr-only"
            onChange={(event) => {
              void addChatAttachments(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <p className="mt-2 text-xs leading-snug text-muted-foreground">
          {chatReferenceMentionStatusText}
        </p>
      </form>
    );
  };

  const addBatchAttachments = async (files: FileList | File[] | null) => {
    const imageFiles = Array.from(files || []).filter(isImageFile);
    await addChatAttachments(imageFiles);
  };

  const getBatchFallbackSize = () => {
    return hasChatImageAttachments ? chatCustomEditSize : size;
  };

  const validateChatAttachments = (attachments: ChatAttachment[]) => {
    if (attachments.length === 0) return true;
    const totalUploadSize = attachments.reduce(
      (total, item) => total + item.file.size,
      0
    );
    if (totalUploadSize > maxEditRequestBytes) {
      toast.error(copy("Upload is too large", "上传内容过大"), {
        description: copy(
          `Attachments total ${formatMegabytes(totalUploadSize)}. Keep the total under ${formatMegabytes(maxEditRequestBytes)}.`,
          `附件总大小为 ${formatMegabytes(totalUploadSize)}，请控制在 ${formatMegabytes(maxEditRequestBytes)} 以内。`
        ),
      });
      return false;
    }
    return true;
  };

  const triggerBatchGeneration = async (options?: { retryCardId?: string }) => {
    if (batchStoppedRef.current && !options?.retryCardId) return;
    // 里程碑警告期间阻塞自动续批(单卡 retry 不受影响)，待用户确认后解除
    if (warningBlockRef.current && !options?.retryCardId) return;
    const currentPrompt = (batchPromptRef.current || batchPrompt).trim();
    if (!currentPrompt) return;
    if (hasPromptImageReference(currentPrompt)) {
      toast.error(
        copy(
          "@ references are not available in waterfall",
          "瀑布流暂不支持 @ 精确引用"
        ),
        {
          description: copy(
            "Use Chat or Agent with Codex/Responses to reference a specific image.",
            "请在 Chat 或 Agent 中使用 Codex/Responses 精确引用指定图片。"
          ),
        }
      );
      return;
    }

    const fallbackSize = batchSizeRef.current || getBatchFallbackSize();
    if (!validateImageSize(fallbackSize).valid) {
      toast.error(copy("Invalid resolution", "分辨率无效"));
      return;
    }

    const attachments = chatAttachments.map((item) => ({
      ...item,
      file: cloneFile(item.file),
    }));
    if (!validateChatAttachments(attachments)) return;

    const requestCount = options?.retryCardId ? 1 : waterfallLoadSize;
    const available = waterfallMaxConcurrent - batchActiveRequestsRef.current;
    const loadSize = Math.min(requestCount, Math.max(available, 0));
    if (loadSize <= 0) return;
    if (batchStoppedRef.current && !options?.retryCardId) return;

    // 里程碑阈值检测：仅对自动续批(非 retry)生效。当本会话累计生成数跨越
    // [tier*10, tier*100, tier*1000] 中某个未展示阈值时，弹用量提醒并阻塞本批，
    // 待用户确认后由弹窗 onClose 解除阻塞并续批(对齐原项目)。
    if (!options?.retryCardId) {
      const tier = effectiveWaterfallTier;
      const nextCount = sessionCountRef.current + loadSize;
      const thresholds = [tier * 10, tier * 100, tier * 1000];
      for (const threshold of thresholds) {
        if (
          sessionCountRef.current < threshold &&
          nextCount >= threshold &&
          !milestoneShownRef.current.has(threshold)
        ) {
          milestoneShownRef.current.add(threshold);
          sessionCountRef.current = nextCount;
          warningBlockRef.current = true;
          setWaterfallWarning({ type: "milestone", tier, count: nextCount });
          return;
        }
      }
      sessionCountRef.current = nextCount;
    }

    const creditsPerRequest = applyBillingPreviewMultiplier(
      getPricedImageCreditCost(
        fallbackSize,
        getModerationCostOptions(
          attachments.filter((item) => item.kind === "image").length
        )
      ),
      chatBillingRoute.billingMultiplier
    );
    const pendingCredits = batchActiveRequestsRef.current * creditsPerRequest;
    const requiredCredits = creditsPerRequest * loadSize + pendingCredits;
    if (!customApiActive && balance < requiredCredits) {
      showGenerationError("Insufficient credits");
      return;
    }

    const cards: BatchCard[] = options?.retryCardId
      ? []
      : Array.from({ length: loadSize }, () => ({
          id: createLocalId(),
          state: "loading" as const,
          aspectRatio:
            WATERFALL_ASPECT_RATIOS[
              Math.floor(Math.random() * WATERFALL_ASPECT_RATIOS.length)
            ] || WATERFALL_ASPECT_RATIOS[0],
          prompt: currentPrompt,
          size: fallbackSize,
        }));

    if (cards.length > 0) {
      setBatchCards((prev) => [...prev, ...cards]);
      setWaterfallStats((prev) => ({
        ...prev,
        sent: prev.sent + cards.length,
      }));
    } else if (options?.retryCardId) {
      setBatchCards((prev) =>
        prev.map((card) =>
          card.id === options.retryCardId
            ? {
                ...card,
                state: "loading",
                error: undefined,
                streamText: undefined,
                streamThinking: undefined,
                streamAgent: undefined,
              }
            : card
        )
      );
      setWaterfallStats((prev) => ({
        sent: prev.sent + 1,
        success: prev.success,
        failed: Math.max(0, prev.failed - 1),
      }));
    }

    const runCard = async (cardId: string) => {
      const controller = new AbortController();
      batchAbortControllersRef.current.set(cardId, controller);
      batchActiveRequestsRef.current += 1;
      try {
        const data = await runChatRequest({
          prompt: currentPrompt,
          attachments,
          fallbackSize,
          historyMessages: [],
          streamCardId: cardId,
          agentMode: false,
          signal: controller.signal,
        });
        const variants = addSuccessfulChatResults(
          data,
          currentPrompt,
          fallbackSize
        );
        const variant = variants[variants.length - 1];
        syncWaterfallCredits(data.creditsConsumed);
        setWaterfallStats((prev) => ({
          ...prev,
          success: prev.success + 1,
        }));
        setBatchCards((prev) =>
          prev.map((card) =>
            card.id === cardId
              ? {
                  ...card,
                  state: variant?.imageUrl ? "image" : "text",
                  imageUrl: variant?.imageUrl || data.imageUrl,
                  generationId: variant?.generationId || data.generationId,
                  text: data.responseText || variant?.responseText,
                  streamText: undefined,
                  streamThinking: data.responseThinking,
                  streamAgent: data.responseAgent,
                  model: data.model,
                  size: variant?.size || data.size || fallbackSize,
                  creditsConsumed: data.creditsConsumed,
                }
              : card
          )
        );
      } catch (error) {
        if (controller.signal.aborted) {
          setBatchCards((prev) =>
            prev.map((card) =>
              card.id === cardId && card.state === "loading"
                ? {
                    ...card,
                    state: "error",
                    error: copy("Stopped", "已停止"),
                  }
                : card
            )
          );
          return;
        }
        const creditsConsumed =
          error instanceof Error
            ? (error as GenerationRequestError).creditsConsumed
            : undefined;
        syncChargedCredits(creditsConsumed);
        syncWaterfallCredits(creditsConsumed);
        setWaterfallStats((prev) => ({
          ...prev,
          failed: prev.failed + 1,
        }));
        setBatchCards((prev) =>
          prev.map((card) =>
            card.id === cardId
              ? {
                  ...card,
                  state: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : copy("Generation failed", "生成失败"),
                  creditsConsumed,
                }
              : card
          )
        );
      } finally {
        batchActiveRequestsRef.current = Math.max(
          0,
          batchActiveRequestsRef.current - 1
        );
        batchAbortControllersRef.current.delete(cardId);
      }
    };

    if (options?.retryCardId) {
      if (batchStoppedRef.current) {
        batchStoppedRef.current = false;
        setIsBatchStopped(false);
      }
      void runCard(options.retryCardId);
      return;
    }

    cards.forEach((card) => {
      void runCard(card.id);
    });
  };
  triggerBatchGenerationRef.current = triggerBatchGeneration;

  const handleBatchSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const currentPrompt = batchPrompt.trim();
    if (!currentPrompt) {
      toast.error(copy("Please enter a prompt", "请输入提示词"));
      return;
    }
    batchPromptRef.current = currentPrompt;
    batchSizeRef.current = getBatchFallbackSize();
    batchActiveRequestsRef.current = 0;
    for (const controller of batchAbortControllersRef.current.values()) {
      controller.abort();
    }
    batchAbortControllersRef.current.clear();
    batchLoadingMoreRef.current = false;
    batchStoppedRef.current = false;
    // 新会话：重置里程碑计数/已展示阈值/阻塞标记，避免跨会话残留
    sessionCountRef.current = 0;
    milestoneShownRef.current = new Set<number>();
    warningBlockRef.current = false;
    setBatchCards([]);
    setWaterfallCreditsConsumed(0);
    setWaterfallStats({ sent: 0, success: 0, failed: 0 });
    setIsBatchLoadingMore(false);
    setIsBatchStopped(false);
    setIsBatchActive(true);
    await triggerBatchGeneration();
  };

  const handleStopWaterfall = () => {
    batchStoppedRef.current = true;
    batchLoadingMoreRef.current = false;
    const abortingCount = batchAbortControllersRef.current.size;
    for (const controller of batchAbortControllersRef.current.values()) {
      controller.abort();
    }
    batchAbortControllersRef.current.clear();
    batchActiveRequestsRef.current = 0;
    if (abortingCount > 0) {
      setWaterfallStats((prev) => ({
        ...prev,
        failed: prev.failed + abortingCount,
      }));
    }
    setBatchCards((prev) =>
      prev.map((card) =>
        card.state === "loading"
          ? { ...card, state: "error", error: copy("Stopped", "已停止") }
          : card
      )
    );
    setIsBatchStopped(true);
    setIsBatchLoadingMore(false);
    toast.info(copy("Waterfall stopped", "瀑布流已停止"));
  };

  const handleClearWaterfall = () => {
    batchStoppedRef.current = false;
    for (const controller of batchAbortControllersRef.current.values()) {
      controller.abort();
    }
    batchAbortControllersRef.current.clear();
    batchActiveRequestsRef.current = 0;
    batchLoadingMoreRef.current = false;
    // 清空瀑布流：一并重置里程碑计数/阈值/阻塞，并关闭可能驻留的警告弹窗
    sessionCountRef.current = 0;
    milestoneShownRef.current = new Set<number>();
    warningBlockRef.current = false;
    setWaterfallWarning(null);
    setBatchCards([]);
    setWaterfallCreditsConsumed(0);
    setWaterfallStats({ sent: 0, success: 0, failed: 0 });
    setIsBatchLoadingMore(false);
    setIsBatchStopped(false);
    setIsBatchActive(false);
  };

  useEffect(() => {
    if (
      !isBatchActive ||
      !batchLoadTriggerRef.current ||
      !batchScrollRef.current
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (!batchPromptRef.current || batchLoadingMoreRef.current) return;
        if (batchStoppedRef.current) return;
        if (batchActiveRequestsRef.current >= waterfallMaxConcurrentRef.current)
          return;
        const triggerGeneration = triggerBatchGenerationRef.current;
        if (!triggerGeneration) return;
        batchLoadingMoreRef.current = true;
        setIsBatchLoadingMore(true);
        void triggerGeneration().finally(() => {
          batchLoadingMoreRef.current = false;
          setIsBatchLoadingMore(false);
        });
      },
      { root: batchScrollRef.current, threshold: 0.1 }
    );

    observer.observe(batchLoadTriggerRef.current);
    return () => observer.disconnect();
  }, [isBatchActive]);

  const handleChatPaste = (event: React.ClipboardEvent) => {
    if (
      !["chat", "agent", "waterfall"].includes(activeMode) ||
      isChatGenerating
    ) {
      return;
    }

    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File =>
        Boolean(file && (isImageFile(file) || isReadableChatFile(file)))
      );

    if (!files.length) return;
    event.preventDefault();
    void addChatAttachments(files);
  };

  // chat(web) 会话内生成可编辑文件(PPT/PSD):独立于图像 SSE 提交自成一条链路——自建会话消息、
  // 调 /api/editable-file/generate(session 鉴权、只选付费 web 账号)、把产物下载链接写回 assistant
  // 消息。轮次费由后端 chatRound 补扣(复用套餐 chatRoundCredits)。单飞(isChatGenerating 阻并发)。
  const submitEditableFileToChat = async (params: {
    kind: "ppt" | "psd";
    prompt: string;
    attachments: Array<{ file: File; kind: "image" | "file" }>;
    attachmentPreviews: NonNullable<ChatMessage["attachments"]>;
    conversationMode: ConversationMode;
  }) => {
    const { kind, prompt, attachments, attachmentPreviews, conversationMode } =
      params;
    const imageFiles = attachments.filter((item) => item.kind === "image");
    if (kind === "psd" && imageFiles.length === 0) {
      toast.error(
        copy("PSD needs a reference image", "生成 PSD 需要参考图")
      );
      return;
    }

    const userMessageId = createLocalId();
    const assistantMessageId = createLocalId();
    const createdAt = new Date().toISOString();
    const pendingMessages: ChatMessage[] = [
      ...chatMessages,
      {
        id: userMessageId,
        role: "user",
        text: prompt,
        mode: conversationMode,
        attachments: attachmentPreviews,
        createdAt,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        mode: conversationMode,
        text: "",
        variants: [
          {
            generationId: createGenerationId(),
            prompt,
            model: "gpt-5-5-thinking",
            size: "auto",
            responseText:
              kind === "psd"
                ? copy(
                    "Generating PSD (may take minutes)…",
                    "正在生成 PSD(可能需几分钟)…"
                  )
                : copy(
                    "Generating PPT (may take minutes)…",
                    "正在生成 PPT(可能需几分钟)…"
                  ),
            pending: true,
          },
        ],
        activeVariant: 0,
        createdAt,
      },
    ];
    setChatMessages(pendingMessages);
    persistChatConversationSnapshot({
      conversations: chatConversationsRef.current,
      conversationId: chatConversationId,
      mode: conversationMode,
      messages: pendingMessages,
      titleFallback: isZh ? "未命名对话" : "Untitled chat",
    });
    setChatPrompt("");
    clearChatAttachments();
    setIsChatGenerating(true);

    // 完成/失败时把 assistant 消息定稿(单飞,pendingMessages 即当前状态)。
    const applyFinal = (
      assistantPatch: Partial<ChatMessage>,
      variantPatch: Partial<ChatVariant>
    ) => {
      const finalMessages = pendingMessages.map((message) => {
        if (message.id !== assistantMessageId) return message;
        const baseVariant = message.variants?.[0] as ChatVariant;
        return {
          ...message,
          ...assistantPatch,
          variants: [{ ...baseVariant, pending: false, ...variantPatch }],
        };
      });
      setChatMessages(finalMessages);
      persistChatConversationSnapshot({
        conversations: chatConversationsRef.current,
        conversationId: chatConversationId,
        mode: conversationMode,
        messages: finalMessages,
        titleFallback: isZh ? "未命名对话" : "Untitled chat",
      });
    };

    try {
      const base64Images = await Promise.all(
        imageFiles.map((item) => fileToDataUrl(item.file))
      );
      const response = await fetch("/api/editable-file/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, prompt, base64Images, chatRound: true }),
      });
      const data = await readKeepAliveJson(response);
      if (!response.ok || data.error) {
        throw new Error(
          data.error?.message || copy("Generation failed", "生成失败")
        );
      }
      const files: Array<{ label: string; url: string }> = [];
      if (data.result?.primary_url) {
        files.push({
          label: kind === "psd" ? "PSD" : "PPTX",
          url: data.result.primary_url,
        });
      }
      if (data.result?.zip_url) {
        files.push({
          label: copy("Assets ZIP", "素材 ZIP"),
          url: data.result.zip_url,
        });
      }
      applyFinal(
        {},
        {
          files,
          creditsConsumed: data.credits_charged,
          pending: false,
          responseText:
            kind === "psd"
              ? copy("PSD ready. Download below.", "PSD 已生成,可在下方下载。")
              : copy("PPT ready. Download below.", "PPT 已生成,可在下方下载。"),
        }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy("Generation failed", "生成失败");
      applyFinal({ error: message }, { pending: false });
    } finally {
      setIsChatGenerating(false);
    }
  };

  const handleChatSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (activeMode === "agent" && !effectiveAgentAllowed) {
      toast.error(copy("Agent is unavailable", "Agent 当前不可用"), {
        description: agentBackendUnavailableReason,
      });
      return;
    }
    const currentPrompt = getChatPrompt().trim();
    if (!currentPrompt) {
      toast.error(copy("Please enter a message", "请输入消息"));
      return;
    }

    const requiresResponsesForReference =
      hasPromptImageReference(currentPrompt);
    const attachments = chatAttachments.map((item) => ({
      ...item,
      file: cloneFile(item.file),
    }));
    const hasImageAttachment = attachments.some(
      (item) => item.kind === "image"
    );
    const fallbackSize = hasImageAttachment ? chatCustomEditSize : size;
    const conversationMode = getConversationMode(activeMode);
    const cost =
      conversationMode === "agent" ? agentRoundCreditCost : chatRoundCreditCost;
    const outputSizeCheck = hasImageAttachment
      ? chatCustomEditSizeCheck
      : sizeCheck;

    if ((!customApiActive || requiresResponsesForReference) && balance < cost) {
      showGenerationError("Insufficient credits");
      return;
    }
    if (!outputSizeCheck.valid) {
      toast.error(copy("Invalid resolution", "分辨率无效"), {
        description: validationMessage(outputSizeCheck.message),
      });
      return;
    }
    if (attachments.length > 0) {
      const totalUploadSize = attachments.reduce(
        (total, item) => total + item.file.size,
        0
      );
      if (totalUploadSize > maxEditRequestBytes) {
        toast.error(copy("Upload is too large", "上传内容过大"), {
          description: copy(
            `Attachments total ${formatMegabytes(totalUploadSize)}. Keep the total under ${formatMegabytes(maxEditRequestBytes)}.`,
            `附件总大小为 ${formatMegabytes(totalUploadSize)}，请控制在 ${formatMegabytes(maxEditRequestBytes)} 以内。`
          ),
        });
        return;
      }
    }

    const attachmentPreviews = attachments.map((item) => ({
      id: item.sourceId || item.file.name,
      name: item.file.name,
      // 复用附件已算好的持久 data URL(chatAttachments 在 readFileAsDataUrl 时生成);
      // 不要用 URL.createObjectURL 重造 blob: URL——blob 只在当前页面存活,持久化到会话
      // 记录后刷新即失效(参考图消失),且 getMessageImageUrls 只收 data:/http(s) 会把它
      // 滤掉,导致后续轮次历史也拿不到用户上传的参考图。
      previewUrl: item.kind === "image" ? item.previewUrl : undefined,
      kind: item.kind,
    }));

    // chat(web) 选了 PPT/PSD:走可编辑文件链路(独立于图像 SSE 提交),完成即返回。
    if (activeMode === "chat-web" && chatWebGenKind !== "image") {
      await submitEditableFileToChat({
        kind: chatWebGenKind,
        prompt: currentPrompt,
        attachments,
        attachmentPreviews,
        conversationMode,
      });
      return;
    }

    const generationId = createGenerationId();
    const userMessageId = createLocalId();
    const assistantMessageId = createLocalId();
    const createdAt = new Date().toISOString();
    const assistantInitialVariant = mergeChatVariant(undefined, {
      generationId,
      prompt: currentPrompt,
      model: chatImageModel !== "default" ? chatImageModel : chatModel,
      size: fallbackSize || size,
      agentEvents:
        conversationMode === "agent"
          ? createOptimisticAgentRoundEvents(1)
          : undefined,
      pending: true,
    });
    const conversationBeforeSend = chatMessages.filter((message) =>
      isMessageInConversationMode(message, conversationMode)
    );
    const pendingMessages: ChatMessage[] = [
      ...chatMessages,
      {
        id: userMessageId,
        role: "user",
        text: currentPrompt,
        mode: conversationMode,
        attachments: attachmentPreviews,
        createdAt,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        mode: conversationMode,
        text: hasImageAttachment
          ? copy("Editing image...", "正在编辑图片...")
          : copy("Generating image...", "正在生成图片..."),
        variants: [assistantInitialVariant],
        activeVariant: 0,
        createdAt,
      },
    ];
    setChatMessages(pendingMessages);
    persistChatConversationSnapshot({
      conversations: chatConversationsRef.current,
      conversationId: chatConversationId,
      mode: conversationMode,
      messages: pendingMessages,
      titleFallback: isZh ? "未命名对话" : "Untitled chat",
    });
    setChatPrompt("");
    clearStreamingPreview();
    setIsChatGenerating(true);
    setChatStream(
      createInitialChatStreamState({
        messageId: assistantMessageId,
        // 流状态 mode 仅作 chat/agent 显示区分;web 会话按 chat 显示。
        mode: conversationMode === "agent" ? "agent" : "chat",
        agentMode: conversationMode === "agent",
        generationId,
        prompt: currentPrompt,
        model: chatImageModel !== "default" ? chatImageModel : chatModel,
        size: fallbackSize || size,
      })
    );
    scrollChatToBottom();

    try {
      const data = await runChatRequest({
        prompt: currentPrompt,
        attachments,
        fallbackSize: fallbackSize || size,
        historyMessages: conversationBeforeSend,
        generationId,
        streamMessageId: assistantMessageId,
        agentMode: conversationMode === "agent",
      });
      const variants = addSuccessfulChatResults(
        data,
        currentPrompt,
        fallbackSize || size
      );
      // 默认展示"成品"那张:分层结果整图的 outputRole 为 final(其余层为 agent_draft),
      // 用它作活动变体,避免大图落在最后生成的某个图层上。非分层时 final 即最后一张,行为不变。
      const finalVariantIndex = variants.findIndex(
        (item) => item.outputRole === "final"
      );
      const activeIndex =
        finalVariantIndex >= 0 ? finalVariantIndex : variants.length - 1;
      const variant = variants[activeIndex];
      if (!variant || variants.length === 0) {
        const message = copy(
          "API returned no image data",
          "接口未返回图片数据"
        );
        setChatMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  text: copy("Generation failed", "生成失败"),
                  error: message,
                }
              : item
          )
        );
        if (isCreatePageMountedRef.current) {
          showGenerationError(message);
        }
        return;
      }

      setChatMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                text:
                  variant.responseText ||
                  (variant.imageUrl
                    ? copy("Image generated", "图片已生成")
                    : copy("Response generated", "回复已生成")),
                variants: variants.map((item) => ({
                  ...item,
                  pending: false,
                })),
                activeVariant: activeIndex,
              }
            : message
        )
      );
      clearChatAttachments();
      if (isCreatePageMountedRef.current) {
        toast.success(
          data.imageUrl
            ? copy("Image generated", "图片已生成")
            : copy("Response generated", "回复已生成")
        );
      }
    } catch (error) {
      const creditsConsumed =
        error instanceof Error
          ? (error as GenerationRequestError).creditsConsumed
          : undefined;
      syncChargedCredits(creditsConsumed);
      const message =
        error instanceof Error
          ? error.message
          : copy("An unexpected error occurred.", "发生未知错误。");
      setChatMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                text: copy("Generation failed", "生成失败"),
                error: message,
                variants: getChatVariants(item).map((variant) => ({
                  ...variant,
                  pending: false,
                })),
              }
            : item
        )
      );
      if (isCreatePageMountedRef.current) {
        toast.error(copy("Generation failed", "生成失败"), {
          description: message,
        });
      }
    } finally {
      setIsChatGenerating(false);
      setChatStream(null);
      clearStreamingPreview();
      if (isCreatePageMountedRef.current) {
        scrollChatToBottom();
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentPrompt = getPrompt().trim();
    if (!currentPrompt) {
      toast.error(copy("Please enter a prompt", "请输入提示词"));
      return;
    }
    if (!customApiActive && balance < textBatchCreditCost) {
      showGenerationError("Insufficient credits");
      return;
    }
    if (!sizeCheck.valid) {
      toast.error(copy("Invalid resolution", "分辨率无效"), {
        description: validationMessage(sizeCheck.message),
      });
      return;
    }
    const requestSize = size;
    const previewMode: VisualOutputMode = "text-single";
    const generationIds = Array.from({ length: batchCount }, () =>
      createGenerationId()
    );
    setVisualResults((prev) => ({ ...prev, [previewMode]: null }));
    setVisualModeLoading(previewMode, { size: requestSize });
    clearVisualStreamingPreview(previewMode);
    setIsTextSingleGenerating(true);
    try {
      const data = await runTextGenerationRequest({
        prompt: currentPrompt,
        count: batchCount,
        stream: true,
        previewMode,
        generationIds,
      });

      const generatedCount = addSuccessfulResults(data, currentPrompt, size, {
        previewMode,
      }).length;
      toast.success(
        generatedCount > 1
          ? copy(
              `${generatedCount} images generated`,
              `已生成 ${generatedCount} 张图片`
            )
          : copy("Image generated", "图片已生成")
      );
    } catch (error) {
      const creditsConsumed =
        error instanceof Error
          ? (error as GenerationRequestError).creditsConsumed
          : undefined;
      syncChargedCredits(creditsConsumed);
      toast.error(copy("Generation failed", "生成失败"), {
        description:
          error instanceof Error
            ? error.message
            : copy("An unexpected error occurred.", "发生未知错误。"),
      });
    } finally {
      setIsTextSingleGenerating(false);
      setVisualModeLoading(previewMode, null);
      clearVisualStreamingPreview(previewMode);
    }
  };

  const runTextGenerationRequest = async (params: {
    prompt: string;
    count?: number;
    stream?: boolean;
    previewMode?: VisualOutputMode;
    generationIds?: string[];
  }) => {
    const response = await fetch("/api/images/generate", {
      method: "POST",
      headers: {
        Accept: params.stream ? "text/event-stream" : "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: params.prompt,
        size,
        stream: Boolean(params.stream),
        count: params.count || 1,
        ...(params.generationIds?.length === 1
          ? { generationId: params.generationIds[0] }
          : {}),
        ...(params.generationIds && params.generationIds.length > 1
          ? { generationIds: params.generationIds }
          : {}),
        quality,
        moderation,
        output_format: outputFormat,
        background,
        ...(background === "transparent" && transparentMatte
          ? { transparent_matte: true }
          : {}),
        ...(outputFormat !== "png"
          ? { output_compression: outputCompression }
          : {}),
        ...(showImageModelControls && textModel !== "default"
          ? { model: textModel }
          : {}),
        ...(imageGptModel !== "default" ? { gptModel: imageGptModel } : {}),
        ...(showThinkingControls ? { thinking: imageThinking } : {}),
        ...(promptOptimizationAllowed ? { promptOptimization } : {}),
        // 显式传 true/false，避免用户关闭 Web-first 时因字段缺失被服务端默认 true 覆盖。
        mix_web_first: textMixWebFirst,
        hd_repair: hdRepair,
      }),
    });

    const data = params.stream
      ? await readImageStreamResponse(response, {
          previewMode: params.previewMode,
        })
      : await readImageApiJsonResponse(response);

    if (!response.ok || data.error) {
      const error = new Error(data.error || `API error: ${response.status}`);
      (error as GenerationRequestError).creditsConsumed = data.creditsConsumed;
      throw error;
    }

    return data;
  };

  const handleTextLineBatchSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (linePromptItems.length === 0) {
      toast.error(
        copy("Enter at least one prompt line", "请至少输入一行提示词")
      );
      return;
    }
    if (!customApiActive && balance < lineBatchCreditCost) {
      showGenerationError("Insufficient credits");
      return;
    }
    if (!sizeCheck.valid) {
      toast.error(copy("Invalid resolution", "分辨率无效"), {
        description: validationMessage(sizeCheck.message),
      });
      return;
    }

    const requestSize = size;
    const previewMode: VisualOutputMode = "text-lines";
    const generationIds = linePromptItems.flatMap(() =>
      Array.from({ length: lineBatchRepeatCount }, () => createGenerationId())
    );
    setVisualResults((prev) => ({ ...prev, [previewMode]: null }));
    setVisualModeLoading(previewMode, { size: requestSize });
    clearVisualStreamingPreview(previewMode);
    setIsTextLinesGenerating(true);
    let generatedCount = 0;
    let generationIndex = 0;
    try {
      for (const itemPrompt of linePromptItems) {
        for (
          let repeatIndex = 0;
          repeatIndex < lineBatchRepeatCount;
          repeatIndex++
        ) {
          const data = await runTextGenerationRequest({
            prompt: itemPrompt,
            count: 1,
            stream: false,
            generationIds: [
              generationIds[generationIndex] || createGenerationId(),
            ],
          });
          generationIndex += 1;
          generatedCount += addSuccessfulResults(data, itemPrompt, size, {
            previewMode,
          }).length;
        }
      }

      toast.success(
        generatedCount > 1
          ? copy(
              `${generatedCount} images generated`,
              `已生成 ${generatedCount} 张图片`
            )
          : copy("Image generated", "图片已生成")
      );
    } catch (error) {
      const creditsConsumed =
        error instanceof Error
          ? (error as GenerationRequestError).creditsConsumed
          : undefined;
      syncChargedCredits(creditsConsumed);
      toast.error(copy("Generation failed", "生成失败"), {
        description:
          error instanceof Error
            ? error.message
            : copy("An unexpected error occurred.", "发生未知错误。"),
      });
    } finally {
      setIsTextLinesGenerating(false);
      setVisualModeLoading(previewMode, null);
      clearVisualStreamingPreview(previewMode);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentEditPrompt = getEditPrompt().trim();
    if (!currentEditPrompt) {
      toast.error(copy("Please enter an edit prompt", "请输入编辑提示词"));
      return;
    }
    if (editImages.length === 0) {
      toast.error(
        copy("Upload at least one source image", "请至少上传一张源图片")
      );
      return;
    }
    if (maskPoints.length > 0 && !maskFile) {
      toast.error(copy("Save the mask before editing", "编辑前请先保存蒙版"));
      return;
    }
    if (!effectiveEditSize) {
      toast.error(copy("Waiting for source image size", "正在读取源图片尺寸"), {
        description: copy(
          "The first source image is still loading.",
          "第一张源图片仍在加载。"
        ),
      });
      return;
    }
    if (!useEditFirstImageSize && !customEditSizeCheck.valid) {
      toast.error(copy("Invalid resolution", "分辨率无效"), {
        description: validationMessage(customEditSizeCheck.message),
      });
      return;
    }
    const editRequiresResponsesForReference =
      hasPromptImageReference(currentEditPrompt);
    if (
      (!customApiActive || editRequiresResponsesForReference) &&
      balance < editBatchCreditCost
    ) {
      showGenerationError("Insufficient credits");
      return;
    }
    const totalUploadSize =
      editImages.reduce((total, item) => total + item.file.size, 0) +
      (maskFile?.file.size || 0);
    if (totalUploadSize > maxEditRequestBytes) {
      toast.error(copy("Upload is too large", "上传内容过大"), {
        description: copy(
          `Source images and mask total ${formatMegabytes(totalUploadSize)}. Keep the total under ${formatMegabytes(maxEditRequestBytes)}.`,
          `源图片和蒙版总大小为 ${formatMegabytes(totalUploadSize)}，请控制在 ${formatMegabytes(maxEditRequestBytes)} 以内。`
        ),
      });
      return;
    }

    const generationIds = Array.from({ length: editBatchCount }, () =>
      createGenerationId()
    );
    const formData = new FormData();
    formData.append("prompt", currentEditPrompt);
    formData.append("quality", quality);
    formData.append("moderation", moderation);
    formData.append("output_format", outputFormat);
    formData.append("background", background);
    // 透明抠图回退显式开关(issue #27)。
    if (background === "transparent" && transparentMatte) {
      formData.append("transparent_matte", "true");
    }
    // 高清修复:关闭时显式传 false 走轻量 general-x4v3;默认(true)由后端选 SwinIR。
    formData.append("hd_repair", String(hdRepair));
    if (outputFormat !== "png") {
      formData.append("output_compression", String(outputCompression));
    }
    if (showImageModelControls && editModel !== "default") {
      formData.append("model", editModel);
    }
    if (imageGptModel !== "default") {
      formData.append("gptModel", imageGptModel);
    }
    if (showThinkingControls) {
      formData.append("thinking", imageThinking);
    }
    if (useEditFirstImageSize) {
      formData.append("displaySize", effectiveEditSize);
    } else {
      formData.append("size", effectiveEditSize);
    }
    editImages.forEach(({ file }) => {
      formData.append(editImages.length === 1 ? "image" : "image[]", file);
    });
    if (maskFile) formData.append("mask", maskFile.file);
    formData.append("count", String(editBatchCount));
    if (generationIds.length === 1) {
      formData.append("generationId", generationIds[0]!);
    } else {
      formData.append("generationIds", JSON.stringify(generationIds));
    }
    if (promptOptimizationAllowed) {
      formData.append("prompt_optimization", String(promptOptimization));
    }
    if (editRequiresResponsesForReference) {
      formData.append("requires_responses_backend", "true");
    } else {
      // 显式传 false，确保页面预测车道与服务端实际选路使用同一开关值。
      formData.append("mix_web_first", String(editMixWebFirst));
    }

    setVisualResults((prev) => ({ ...prev, image: null }));
    setVisualModeLoading("image", { size: effectiveEditSize });
    setIsEditing(true);
    clearVisualStreamingPreview("image");
    formData.append("stream", "true");
    try {
      const response = await fetch("/api/images/edit", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
        },
        body: formData,
      });
      const data = await readImageStreamResponse(response, {
        previewMode: "image",
      });

      if (!response.ok || data.error) {
        showGenerationError(data.error || `API error: ${response.status}`, {
          creditsConsumed: data.creditsConsumed,
        });
        return;
      }

      const generatedCount = addSuccessfulResults(
        data,
        currentEditPrompt,
        effectiveEditSize,
        { previewMode: "image" }
      ).length;
      toast.success(
        generatedCount > 1
          ? copy(
              `${generatedCount} images edited`,
              `已编辑 ${generatedCount} 张图片`
            )
          : copy("Image edited", "图片已编辑")
      );
    } catch (error) {
      toast.error(copy("Generation failed", "生成失败"), {
        description:
          error instanceof Error
            ? error.message
            : copy("An unexpected error occurred.", "发生未知错误。"),
      });
    } finally {
      setIsEditing(false);
      setVisualModeLoading("image", null);
      clearVisualStreamingPreview("image");
    }
  };

  const addImages = (files: FileList | File[] | null) => {
    const imageFiles = Array.from(files || []);
    if (!imageFiles.length) return;

    const accepted: EditImageFile[] = [];
    for (const file of imageFiles) {
      if (!isImageFile(file)) {
        toast.error(copy("Unsupported file type", "不支持的文件类型"), {
          description: copy(
            "Use PNG, JPEG, or WebP images.",
            "请使用 PNG、JPEG 或 WebP 图片。"
          ),
        });
        continue;
      }
      if (file.size > maxImageBytes) {
        toast.error(copy("File too large", "文件过大"), {
          description: copy(
            `${file.name} exceeds ${formatMegabytes(maxImageBytes)}.`,
            `${file.name} 超过 ${formatMegabytes(maxImageBytes)}。`
          ),
        });
        continue;
      }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) });
    }

    if (!accepted.length) return;
    setEditImages((prev) => {
      const slots = maxEditImages - prev.length;
      if (slots <= 0) {
        for (const item of accepted) {
          revokePreview(item.previewUrl);
        }
        toast.error(
          copy(
            `Upload up to ${maxEditImages} source images`,
            `最多可上传 ${maxEditImages} 张源图片`
          )
        );
        return prev;
      }
      const next = accepted.slice(0, slots);
      for (const item of accepted.slice(slots)) {
        revokePreview(item.previewUrl);
      }
      if (accepted.length > slots) {
        toast.error(
          copy(
            `Only ${slots} more source image(s) can be added`,
            `还可以再添加 ${slots} 张源图片`
          )
        );
      }
      return [...prev, ...next];
    });
  };

  const handleImagePaste = (event: React.ClipboardEvent) => {
    if (activeMode !== "image" || isEditing) return;

    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file && isImageFile(file)));

    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  };

  const removeImage = (index: number) => {
    setEditImages((prev) => {
      const target = prev[index];
      if (target) revokePreview(target.previewUrl);
      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const clearEditImages = () => {
    setEditImages((prev) => {
      for (const item of prev) {
        revokePreview(item.previewUrl);
      }
      return [];
    });
    setMaskEditorOpen(false);
    setMaskPoints([]);
    clearMask();
  };

  const setMask = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      toast.error(copy("Mask must be a PNG file", "蒙版必须是 PNG 文件"));
      return;
    }
    if (file.size > maxImageBytes) {
      toast.error(copy("Mask is too large", "蒙版文件过大"), {
        description: copy(
          `Maximum size is ${formatMegabytes(maxImageBytes)}.`,
          `最大支持 ${formatMegabytes(maxImageBytes)}。`
        ),
      });
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      if (
        firstImageSize &&
        (img.naturalWidth !== firstImageSize.width ||
          img.naturalHeight !== firstImageSize.height)
      ) {
        URL.revokeObjectURL(previewUrl);
        toast.error(
          copy(
            "Mask dimensions must match the first source image",
            "蒙版尺寸必须与第一张源图片一致"
          ),
          {
            description: copy(
              `Expected ${firstImageSize.width}x${firstImageSize.height}.`,
              `应为 ${firstImageSize.width}x${firstImageSize.height}。`
            ),
          }
        );
        return;
      }

      setMaskFile((prev) => {
        if (prev) revokePreview(prev.previewUrl);
        return { file, previewUrl };
      });
      setMaskPoints([]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      toast.error(copy("Failed to load mask image", "蒙版图片加载失败"));
    };
    img.src = previewUrl;
  };

  const clearMask = () => {
    setMaskFile((prev) => {
      if (prev) revokePreview(prev.previewUrl);
      return null;
    });
  };

  const clearDrawnMask = () => {
    setMaskPoints([]);
    clearMask();
  };

  const addMaskPoint = (x: number, y: number) => {
    setMaskPoints((prev) => [...prev, { x, y, size: maskBrushSize }]);
    clearMask();
  };

  const getMaskPointerPosition = (
    event:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>
  ) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point =
      "touches" in event ? event.touches[0] || event.changedTouches[0] : event;
    if (!point) return null;
    return {
      x: ((point.clientX - rect.left) / rect.width) * canvas.width,
      y: ((point.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const startMaskDrawing = (
    event:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>
  ) => {
    event.preventDefault();
    const point = getMaskPointerPosition(event);
    if (!point) return;
    isDrawingRef.current = true;
    lastMaskPointRef.current = point;
    addMaskPoint(point.x, point.y);
  };

  const drawMaskLine = (
    event:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (!isDrawingRef.current) return;
    event.preventDefault();
    const point = getMaskPointerPosition(event);
    const lastPoint = lastMaskPointRef.current;
    if (!point || !lastPoint) return;

    const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    const angle = Math.atan2(point.y - lastPoint.y, point.x - lastPoint.x);
    const step = Math.max(1, maskBrushSize / 4);
    const nextPoints: MaskPoint[] = [];

    for (let i = step; i < distance; i += step) {
      nextPoints.push({
        x: lastPoint.x + Math.cos(angle) * i,
        y: lastPoint.y + Math.sin(angle) * i,
        size: maskBrushSize,
      });
    }
    nextPoints.push({ x: point.x, y: point.y, size: maskBrushSize });
    setMaskPoints((prev) => [...prev, ...nextPoints]);
    clearMask();
    lastMaskPointRef.current = point;
  };

  const stopMaskDrawing = () => {
    isDrawingRef.current = false;
    lastMaskPointRef.current = null;
  };

  const saveDrawnMask = () => {
    if (!firstImageSize || maskPoints.length === 0) {
      toast.error(copy("Draw a mask area first", "请先绘制蒙版区域"));
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = firstImageSize.width;
    canvas.height = firstImageSize.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "destination-out";
    for (const point of maskPoints) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
      ctx.fill();
    }

    const previewUrl = canvas.toDataURL("image/png");
    canvas.toBlob((blob) => {
      if (!blob) {
        toast.error(copy("Failed to save mask", "保存蒙版失败"));
        return;
      }
      const file = new File([blob], "generated-mask.png", {
        type: "image/png",
      });
      setMaskFile((prev) => {
        if (prev) revokePreview(prev.previewUrl);
        return { file, previewUrl };
      });
      toast.success(copy("Mask saved", "蒙版已保存"));
    }, "image/png");
  };

  const applyResultAsReference = async (sourceResult = result) => {
    if (!sourceResult?.imageUrl) return;

    try {
      const item = await urlToEditImageFile(
        sourceResult.imageUrl,
        `gpt2image-${sourceResult.generationId}`,
        sourceResult.generationId
      );
      clearEditImages();
      setEditImages([item]);
      setActiveMode("image");
      setEditPrompt("");
      toast.success(
        copy("Result added as reference image", "结果已作为参考图片")
      );
    } catch (error) {
      toast.error(
        copy("Failed to use result as reference", "设置参考图片失败"),
        {
          description:
            error instanceof Error
              ? error.message
              : copy("Could not load image.", "无法加载图片。"),
        }
      );
    }
  };

  const selectRecentAsReference = async (generation: RecentGeneration) => {
    if (!generation.imageUrl) {
      toast.error(copy("This image is not available yet", "这张图片暂不可用"));
      return;
    }

    const existingIndex = editImages.findIndex(
      (item) => item.sourceId === generation.id
    );
    if (existingIndex >= 0) {
      removeImage(existingIndex);
      toast.success(copy("Reference image removed", "参考图片已移除"));
      return;
    }

    if (editImages.length >= maxEditImages) {
      toast.error(
        copy(
          `Upload up to ${maxEditImages} source images`,
          `最多可上传 ${maxEditImages} 张源图片`
        )
      );
      return;
    }

    try {
      const item = await urlToEditImageFile(
        generation.imageUrl,
        `gpt2image-${generation.id}`,
        generation.id
      );
      setEditImages((prev) => [...prev, item]);
      toast.success(copy("Reference image selected", "参考图片已选择"));
    } catch (error) {
      toast.error(
        copy("Failed to use image as reference", "设置参考图片失败"),
        {
          description:
            error instanceof Error
              ? error.message
              : copy("Could not load image.", "无法加载图片。"),
        }
      );
    }
  };

  const openRecentPreview = (generation: RecentGeneration) => {
    if (!generation.imageUrl) {
      toast.error(copy("This image is not available yet", "这张图片暂不可用"));
      return;
    }
    setSelectedRecentId(generation.id);
  };

  const handleRecentClick = (generation: RecentGeneration) => {
    if (isConversationMode(activeMode)) {
      if (!generation.imageUrl) {
        toast.error(
          copy("This image is not available yet", "这张图片暂不可用")
        );
        return;
      }
      void attachImageUrlToChat(
        generation.imageUrl,
        `gpt2image-${generation.id}`,
        generation.id
      );
      return;
    }

    if (activeMode === "image") {
      void selectRecentAsReference(generation);
      return;
    }
    openRecentPreview(generation);
  };

  const selectedRecent =
    recent.find((item) => item.id === selectedRecentId) ??
    chatMessages.flatMap((message) =>
      getChatVariants(message)
        .filter((variant) => variant.generationId === selectedRecentId)
        .map(
          (variant): ChatRecentGeneration => ({
            id: variant.generationId || createLocalId(),
            prompt: variant.prompt,
            revisedPrompt: variant.revisedPrompt || null,
            model: variant.model,
            size: variant.size,
            creditsConsumed: variant.creditsConsumed || 0,
            status: "completed",
            imageUrl: variant.imageUrl || null,
            createdAt: variant.createdAt || new Date().toISOString(),
            canDelete: false,
          })
        )
    )[0] ??
    // 文生图/视觉模式的结果存在 visualResults(不在 recent/chat 里),也要能解析出来供预览,
    // 否则点击结果图时找不到对应项 → 预览打不开(假按钮)。
    Object.values(visualResults)
      .filter(
        (result): result is ResultState =>
          result != null && result.generationId === selectedRecentId
      )
      .map(
        (result): ChatRecentGeneration => ({
          id: result.generationId,
          prompt: result.prompt,
          revisedPrompt: result.revisedPrompt ?? null,
          model: result.model,
          size: result.size,
          creditsConsumed: result.creditsConsumed ?? 0,
          status: "completed",
          imageUrl: result.imageUrl,
          createdAt: new Date().toISOString(),
          canDelete: false,
        })
      )[0] ??
    null;

  const textSettingsPanel = (mode: TextGenerationMode) => {
    const isLineMode = mode === "lines";
    const modeBusy = isLineMode
      ? isTextLinesGenerating
      : isTextSingleGenerating;
    const countValue = isLineMode ? lineBatchRepeatCount : batchCount;
    const setCountValue = (value: number) => {
      const normalized = Math.min(Math.max(1, value), batchCountMax);
      if (isLineMode) {
        setLineBatchRepeatCount(normalized);
      } else {
        setBatchCount(normalized);
      }
    };
    const formattedCost = isLineMode
      ? formattedLineBatchCreditCost
      : formattedTextBatchCreditCost;
    const costSuffix = isLineMode
      ? copy(
          ` for ${lineBatchTotalCount} total`,
          `，共 ${lineBatchTotalCount} 张`
        )
      : batchCostSuffix(batchCount);

    return (
      <div className="space-y-4 rounded-lg border border-border bg-background p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {showImageModelControls && (
                <div
                  className={`space-y-1.5 ${
                    textMixWebFirstActive ? "opacity-55" : ""
                  }`}
                  title={
                    textMixWebFirstActive
                      ? responsesOnlyDisabledReason
                      : undefined
                  }
                >
                  <label
                    htmlFor={`text-model-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {labelWithHelp(
                      copy("Image model", "图片模型"),
                      imageModelHelpText
                    )}
                  </label>
                  <Select
                    value={textModel}
                    onValueChange={setTextModel}
                    disabled={modeBusy || textMixWebFirstActive}
                  >
                    <SelectTrigger
                      id={`text-model-${mode}`}
                      className="w-full"
                      title={imageModelHelpText}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEXT_MODEL_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {textModelLabel(option.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!isFireflyModel(textModel) && (
                <div className="space-y-1.5">
                  <label
                    htmlFor={`text-gpt-model-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {labelWithHelp(
                      copy("GPT model", "GPT 模型"),
                      gptModelHelpText
                    )}
                  </label>
                  {renderGptModelSelect({
                    id: `text-gpt-model-${mode}`,
                    value: imageGptModel,
                    onChange: setImageGptModel,
                    disabled: modeBusy,
                    allowDefault: true,
                  })}
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {copy(
                      "Used by platform Web/Codex backend pools; external image APIs keep using the image model.",
                      "仅用于平台 Web/Codex 后端池；默认会沿用后端配置，外接 image API 仍按图片模型请求。"
                    )}
                  </p>
                </div>
              )}

              {showThinkingControls && !isFireflyModel(textModel) && (
                <div className="space-y-1.5">
                  <label
                    htmlFor={`text-thinking-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {labelWithHelp(
                      copy("Thinking", "思考强度"),
                      thinkingHelpText
                    )}
                  </label>
                  {renderThinkingSelect({
                    id: `text-thinking-${mode}`,
                    value: imageThinking,
                    onChange: setImageThinking,
                    disabled: modeBusy,
                  })}
                </div>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor={isLineMode ? "line-repeat-count" : "batch-count"}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {isLineMode
                    ? copy("Repeat each line", "每行重复")
                    : copy("Repeat prompt", "重复生成")}
                </label>
                <ConcurrencyNumberInput
                  id={isLineMode ? "line-repeat-count" : "batch-count"}
                  value={countValue}
                  max={batchCountMax}
                  disabled={modeBusy}
                  onChange={setCountValue}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {labelWithHelp(
                      copy("Resolution", "分辨率"),
                      resolutionHelpText
                    )}
                  </span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {copy("Current", "当前")}：
                    {useAutoSize ? autoSizeLabel : size}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setTextSizeDialogOpen(true)}
                  disabled={modeBusy}
                  className="shrink-0"
                >
                  {copy("Set size", "设置尺寸")}
                </Button>
              </div>
              {/* 高清修复放分辨率卡内:与后端类型无关(纯服务端超分后处理),须对 web 后端也可见。 */}
              {renderHdRepairToggle({
                id: `image-hd-repair-${mode}`,
                disabled: modeBusy,
              })}
            </div>

            {!isWebOnlyBackend && (
              <div
                className={`grid gap-3 sm:grid-cols-2 ${
                  disableResponsesOnlyControls ? "opacity-55" : ""
                }`}
                title={responsesOnlyDisabledReason}
              >
                <div className="space-y-1.5">
                  <label
                    htmlFor={`image-quality-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {copy("Quality", "质量")}
                  </label>
                  <Select
                    value={quality}
                    onValueChange={(value) => setQuality(value as ImageQuality)}
                    disabled={modeBusy || disableResponsesOnlyControls}
                  >
                    <SelectTrigger
                      id={`image-quality-${mode}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUALITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {qualityLabel(option.value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={`image-output-format-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {labelWithHelp(
                      copy("Output format", "输出格式"),
                      outputFormatHelpText
                    )}
                  </label>
                  <Select
                    value={outputFormat}
                    onValueChange={(value) =>
                      setOutputFormat(value as ImageOutputFormat)
                    }
                    disabled={modeBusy || disableResponsesOnlyControls || textFireflyActive}
                  >
                    <SelectTrigger
                      id={`image-output-format-${mode}`}
                      className="w-full"
                      title={outputFormatHelpText}
                    >
                      <SelectValue />
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
                {outputFormat !== "png" && (
                  <div className="space-y-1.5">
                    <label
                      htmlFor={`image-output-compression-${mode}`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {labelWithHelp(
                        copy("Compression", "压缩率"),
                        outputCompressionHelpText
                      )}
                    </label>
                    <Input
                      id={`image-output-compression-${mode}`}
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={outputCompression}
                      onChange={(event) =>
                        setOutputCompression(
                          Math.min(
                            100,
                            Math.max(0, Number(event.target.value) || 0)
                          )
                        )
                      }
                      disabled={modeBusy || disableResponsesOnlyControls || textFireflyActive}
                      title={outputCompressionHelpText}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <label
                    htmlFor={`image-background-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {labelWithHelp(
                      copy("Background", "背景"),
                      backgroundHelpText
                    )}
                  </label>
                  {renderBackgroundSelect({
                    id: `image-background-${mode}`,
                    disabled: modeBusy || disableResponsesOnlyControls,
                  })}
                  {renderTransparentMatteToggle({
                    id: `image-transparent-matte-${mode}`,
                    disabled: modeBusy || disableResponsesOnlyControls,
                  })}
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={`image-oai-moderation-${mode}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {copy("OAI moderation strength", "OAI 自身审核强度")}
                  </label>
                  <Select
                    value={moderation}
                    onValueChange={(value) =>
                      setModeration(value as ImageModeration)
                    }
                    disabled={modeBusy || disableResponsesOnlyControls || textFireflyActive}
                  >
                    <SelectTrigger
                      id={`image-oai-moderation-${mode}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODERATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {moderationLabel(option.value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {responsesOnlyDisabledReason && !isWebOnlyBackend && (
              <p className="text-xs text-muted-foreground">
                {responsesOnlyDisabledReason}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground lg:justify-end">
            <Coins className="h-3.5 w-3.5" />
            {customApiActive ? (
              <span className="font-medium text-foreground">
                {customApiBillingLabel}
              </span>
            ) : (
              <span>
                {copy("Balance", "余额")}:{" "}
                <span className="font-medium text-foreground">
                  {formattedBalance}
                </span>{" "}
                · {copy("Cost", "费用")}:{" "}
                <span className="font-medium text-foreground">
                  {formattedCost}
                </span>
                {costSuffix}
              </span>
            )}
          </div>
        </div>
        {!sizeCheck.valid && (
          <p className="text-xs text-destructive">
            {validationMessage(sizeCheck.message)}
          </p>
        )}
      </div>
    );
  };

  const renderVisualOutput = (mode: VisualOutputMode) => {
    const loading = isVisualModeLoading(mode);
    const modeResult = visualResults[mode] || null;
    const dimensions = getVisualLoadingDimensions(mode);
    const previewUrl = visualPreviewUrls[mode] || null;

    return (
      <>
        {loading && (
          <div
            className="mt-8 mb-10 flex max-w-2xl items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/30"
            style={{
              aspectRatio: `${dimensions.width} / ${dimensions.height}`,
            }}
          >
            {previewUrl ? (
              <div className="relative h-full w-full">
                <Image
                  src={previewUrl}
                  alt={copy("Streaming preview", "流式预览")}
                  fill
                  sizes="(max-width: 1024px) 100vw, 768px"
                  className="object-contain"
                  unoptimized={shouldBypassImageOptimization(previewUrl)}
                />
                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {copy("Previewing stream", "正在预览流式结果")}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p className="text-sm">
                  {copy("Generating your image...", "正在生成图片...")}
                </p>
              </div>
            )}
          </div>
        )}

        {modeResult && !loading && (
          <section className="mt-8 mb-10 space-y-4 animate-in fade-in zoom-in-95 duration-400 motion-reduce:animate-none">
            <button
              type="button"
              onClick={() => setSelectedRecentId(modeResult.generationId)}
              className="group relative mx-auto block w-full max-w-2xl overflow-hidden rounded-lg border bg-muted"
              style={{
                aspectRatio: `${parseImageSize(modeResult.size)?.width || defaultDimensions.width} / ${
                  parseImageSize(modeResult.size)?.height ||
                  defaultDimensions.height
                }`,
              }}
              title={copy("Open image preview", "打开图片预览")}
            >
              <Image
                src={thumbSrc(modeResult.imageUrl, 1024)}
                alt={modeResult.prompt}
                fill
                sizes="(max-width: 1024px) 100vw, 768px"
                className="object-contain"
                unoptimized={shouldBypassImageOptimization(modeResult.imageUrl)}
              />
              <span className="absolute right-2 top-2 rounded bg-background/90 px-2 py-1 text-xs font-medium text-foreground opacity-0 shadow-sm transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100">
                <Eye className="mr-1 inline h-3.5 w-3.5" />
                {copy("Preview", "预览")}
              </span>
            </button>
            <div className="mx-auto max-w-2xl space-y-3">
              <p className="text-sm text-muted-foreground">
                {modeResult.prompt}
              </p>
              <p className="text-xs text-muted-foreground">
                {copy("Model", "模型")}:{" "}
                <span className="font-medium text-foreground">
                  {modeResult.model}
                </span>{" "}
                · {copy("Resolution", "分辨率")}:{" "}
                <span className="font-medium text-foreground">
                  {modeResult.size}
                </span>
              </p>
              {modeResult.revisedPrompt &&
                modeResult.revisedPrompt !== modeResult.prompt && (
                  <p className="text-xs italic text-muted-foreground">
                    {copy("Revised", "优化提示词")}: {modeResult.revisedPrompt}
                  </p>
                )}
              {modeResult.promptRepairNotice && (
                <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {copy(
                    "The original prompt was rejected by safety checks, so the system made additional adjustments before generating this result.",
                    "原提示词因审核被拒，系统已进行更多修改后生成本次结果。"
                  )}
                </p>
              )}
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm">
                  <a
                    href={modeResult.imageUrl}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {copy("Download", "下载")}
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyResultAsReference(modeResult)}
                >
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  {copy("Edit this", "编辑这张")}
                </Button>
              </div>
            </div>
          </section>
        )}
      </>
    );
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
      <header className="mb-10 space-y-2.5">
        <h1 className="font-serif text-3xl font-semibold tracking-tight md:text-4xl">
          {copy("Create", "创作")}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {copy(
            "Generate a new image from text, or transform uploaded images with a prompt.",
            "用文字生成新图片，或通过提示词改造上传的图片。"
          )}
        </p>
      </header>

      <Tabs
        value={activeMode}
        onValueChange={(value) => {
          const modeAllowed =
            value === "agent"
              ? effectiveAgentAllowed
              : value === "waterfall"
                ? waterfallAllowed
                : value === "chat"
                  ? chatAllowed
                  : true;
          if (!modeAllowed) {
            toast.error(
              copy(
                "This mode is not enabled for your plan.",
                "当前套餐未开启该模式。"
              )
            );
            return;
          }
          if (value === "agent" && agentBackendUnavailableReason) {
            toast.error(copy("Agent is unavailable", "Agent 当前不可用"), {
              description: agentBackendUnavailableReason,
            });
            return;
          }
          setActiveMode(value as ActiveMode);
        }}
        className="mb-10"
      >
        <TabsList className="mb-6 h-auto flex-wrap justify-start gap-1 rounded-full border border-border bg-muted/40 p-1">
          <TabsTrigger value="text" className="gap-1.5 rounded-full px-4">
            <Wand2 className="h-4 w-4" />
            {copy("Text to image", "文生图")}
          </TabsTrigger>
          <TabsTrigger value="image" className="gap-1.5 rounded-full px-4">
            <ImagePlus className="h-4 w-4" />
            {copy("Image to image", "图生图")}
          </TabsTrigger>
          <TabsTrigger
            value="chat"
            disabled={!chatAllowed}
            className="gap-1.5 rounded-full px-4"
          >
            <MessageSquare className="h-4 w-4" />
            {copy("chat(codex)", "chat(codex)")}
            {!chatAllowed && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Pro
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="chat-web" className="gap-1.5 rounded-full px-4">
            <MessageSquare className="h-4 w-4" />
            {copy("chat(web)", "chat(web)")}
          </TabsTrigger>
          <TabsTrigger
            value="agent"
            disabled={!effectiveAgentAllowed}
            title={agentBackendUnavailableReason}
            className="gap-1.5 rounded-full px-4"
          >
            <Wand2 className="h-4 w-4" />
            {copy("Agent", "Agent")}
            {gpt55ChatAllowed && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                GPT-5.5
              </span>
            )}
            {!agentAllowed ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Locked
              </span>
            ) : agentBackendUnavailableReason ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Codex
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="waterfall"
            disabled={!waterfallAllowed}
            className="gap-1.5 rounded-full px-4"
          >
            <ImagePlus className="h-4 w-4" />
            {copy("Waterfall", "瀑布流")}
            {!waterfallAllowed && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Locked
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="video" className="gap-1.5 rounded-full px-4">
            <Wand2 className="h-4 w-4" />
            {copy("Video", "视频")}
          </TabsTrigger>
        </TabsList>

        <div role="tabpanel" hidden={activeMode !== "text"} className="mt-0">
          <Tabs
            value={textMode}
            onValueChange={(value) => setTextMode(value as TextGenerationMode)}
            className="space-y-4"
          >
            <TabsList className="rounded-full border border-border bg-muted/40 p-1">
              <TabsTrigger value="single" className="rounded-full px-4">
                {copy("Single prompt", "单提示词")}
              </TabsTrigger>
              <TabsTrigger value="lines" className="rounded-full px-4">
                {copy("Line batch", "逐行批量")}
              </TabsTrigger>
            </TabsList>

            <div
              role="tabpanel"
              hidden={textMode !== "single"}
              className="mt-0"
            >
              <form onSubmit={handleSubmit} className="space-y-4">
                <PromptTextareaField
                  promptKey="prompt"
                  placeholder={copy(
                    "Describe the image you want to create...",
                    "描述你想创作的图片..."
                  )}
                  rows={5}
                  disabled={isTextSingleGenerating}
                  className="resize-none rounded-lg border-input bg-background text-base"
                />
                {promptOptimizationField(
                  "text-prompt-optimization",
                  isTextSingleGenerating
                )}
                {textSettingsPanel("single")}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={isTextSingleGenerating || !promptHasText}
                  >
                    {isTextSingleGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {copy("Generating", "生成中")}
                      </>
                    ) : (
                      <>
                        <ImagePlus className="mr-2 h-4 w-4" />
                        {copy("Generate", "生成")}
                      </>
                    )}
                  </Button>
                </div>
              </form>
              {renderVisualOutput("text-single")}
            </div>

            <div role="tabpanel" hidden={textMode !== "lines"} className="mt-0">
              <form onSubmit={handleTextLineBatchSubmit} className="space-y-4">
                <Textarea
                  value={linePrompts}
                  onChange={(e) => setLinePrompts(e.target.value)}
                  placeholder={copy(
                    "One prompt per line. Each line generates one image.",
                    "每行一个提示词，每行生成一张图片。"
                  )}
                  rows={8}
                  disabled={isTextLinesGenerating}
                  className="resize-none rounded-lg border-input bg-background text-base"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {copy("Prompt lines", "提示词行数")}:{" "}
                    <span className="font-medium text-foreground">
                      {linePromptItems.length}
                    </span>
                  </span>
                  <span>
                    {copy("Total images", "总图片数")}:{" "}
                    <span className="font-medium text-foreground">
                      {lineBatchTotalCount}
                    </span>
                  </span>
                </div>
                {promptOptimizationField(
                  "text-line-prompt-optimization",
                  isTextLinesGenerating
                )}
                {textSettingsPanel("lines")}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      isTextLinesGenerating || linePromptItems.length === 0
                    }
                  >
                    {isTextLinesGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {copy("Generating", "生成中")}
                      </>
                    ) : (
                      <>
                        <ImagePlus className="mr-2 h-4 w-4" />
                        {copy("Generate line batch", "生成逐行批量")}
                      </>
                    )}
                  </Button>
                </div>
              </form>
              {renderVisualOutput("text-lines")}
            </div>
          </Tabs>
        </div>

        <div role="tabpanel" hidden={activeMode !== "image"} className="mt-0">
          <form
            onSubmit={handleEditSubmit}
            onPaste={handleImagePaste}
            className="space-y-4"
          >
            <div className="relative">
              {renderReferenceMentionMenu({
                open: Boolean(editMention?.open) && canUseEditReferenceMentions,
                options: filteredEditReferenceOptions,
                onSelect: selectEditMention,
                emptyText: copy(
                  "Upload a source image first.",
                  "请先上传源图片。"
                ),
              })}
              <PromptTextareaField
                promptKey="editPrompt"
                textareaRef={editPromptRef}
                onValueChange={handleEditPromptChange}
                placeholder={copy(
                  "Describe how to transform the uploaded image...",
                  "描述如何改造上传的图片..."
                )}
                rows={5}
                disabled={isEditing}
                className="resize-none rounded-lg border-input bg-background text-base"
                onBlur={() => setTimeout(() => setEditMention(null), 120)}
                onClick={(event) => {
                  const target = event.currentTarget;
                  setEditMention(
                    canUseEditReferenceMentions
                      ? getMentionTrigger(
                          target.value,
                          target.selectionStart ?? target.value.length
                        )
                      : null
                  );
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    editMention?.open &&
                    filteredEditReferenceOptions[0]
                  ) {
                    event.preventDefault();
                    selectEditMention(filteredEditReferenceOptions[0]);
                    return;
                  }
                  if (event.key === "Escape" && editMention?.open) {
                    event.preventDefault();
                    setEditMention(null);
                  }
                }}
              />
            </div>
            <p className="text-xs leading-snug text-muted-foreground">
              {editReferenceMentionStatusText}
            </p>
            {promptOptimizationField("edit-prompt-optimization", isEditing)}

            <div className="space-y-4 rounded-lg border border-border bg-background p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {copy("Source images", "源图片")}
                  </span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {copy(
                      `Upload PNG, JPEG, or WebP. Up to ${maxEditImages} images, ${formatMegabytes(maxEditRequestBytes)} total.`,
                      `上传 PNG、JPEG 或 WebP，最多 ${maxEditImages} 张，总大小不超过 ${formatMegabytes(maxEditRequestBytes)}。`
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={isEditing || editImages.length >= maxEditImages}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {copy("Upload images", "上传图片")}
                </Button>
                {editImages.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={clearEditImages}
                    disabled={isEditing}
                  >
                    {copy("Clear all", "全部清除")}
                  </Button>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  multiple
                  accept={IMAGE_ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              {editImages.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {editImages.map((item, index) => (
                    <div
                      key={`${item.file.name}-${item.previewUrl}`}
                      className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                    >
                      <span className="absolute left-1 top-1 z-10 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
                        {index + 1}
                      </span>
                      <Image
                        src={item.previewUrl}
                        alt={
                          item.file.name ||
                          copy(
                            `Source image ${index + 1}`,
                            `源图片 ${index + 1}`
                          )
                        }
                        fill
                        sizes="160px"
                        className="object-cover"
                        unoptimized
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon-xs"
                        className="absolute right-1 top-1 opacity-95"
                        onClick={() => removeImage(index)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
              <div className="space-y-4 rounded-lg border border-border bg-background p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <span className="text-sm font-medium text-foreground">
                      {copy("Optional mask", "可选蒙版")}
                    </span>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {copy(
                        "Draw on the first source image or upload a PNG mask. Transparent areas are edited.",
                        "在第一张源图上绘制，或上传 PNG 蒙版。透明区域会被编辑。"
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setMaskEditorOpen((value) => !value)}
                      disabled={isEditing || !firstImageSize}
                    >
                      <Brush className="mr-2 h-4 w-4" />
                      {maskEditorOpen
                        ? copy("Close editor", "关闭编辑器")
                        : copy("Draw mask", "绘制蒙版")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => maskInputRef.current?.click()}
                      disabled={isEditing || !firstImageSize}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {copy("Upload mask", "上传蒙版")}
                    </Button>
                    {maskFile && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={clearMask}
                        disabled={isEditing}
                      >
                        {copy("Clear", "清除")}
                      </Button>
                    )}
                  </div>
                  <input
                    ref={maskInputRef}
                    type="file"
                    accept="image/png"
                    className="sr-only"
                    onChange={(e) => {
                      setMask(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>
                {maskEditorOpen && firstPreviewUrl && firstImageSize && (
                  <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                    <div
                      className="relative mx-auto w-full max-w-2xl overflow-hidden rounded-md border bg-muted"
                      style={{
                        aspectRatio: `${firstImageSize.width} / ${firstImageSize.height}`,
                      }}
                    >
                      <Image
                        src={firstPreviewUrl}
                        alt={copy(
                          "Source image for mask editing",
                          "用于蒙版编辑的源图片"
                        )}
                        fill
                        sizes="(max-width: 1024px) 100vw, 640px"
                        className="object-contain"
                        unoptimized
                      />
                      <canvas
                        ref={maskCanvasRef}
                        width={firstImageSize.width}
                        height={firstImageSize.height}
                        className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                        onMouseDown={startMaskDrawing}
                        onMouseMove={drawMaskLine}
                        onMouseUp={stopMaskDrawing}
                        onMouseLeave={stopMaskDrawing}
                        onTouchStart={startMaskDrawing}
                        onTouchMove={drawMaskLine}
                        onTouchEnd={stopMaskDrawing}
                      />
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <label
                        htmlFor="mask-brush-size"
                        className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
                      >
                        {copy("Brush", "画笔")} {maskBrushSize}px
                        <input
                          id="mask-brush-size"
                          type="range"
                          min={4}
                          max={128}
                          step={1}
                          value={maskBrushSize}
                          onChange={(event) =>
                            setMaskBrushSize(Number(event.target.value))
                          }
                          className="w-40 accent-primary"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={clearDrawnMask}
                          disabled={isEditing}
                        >
                          <Eraser className="mr-2 h-4 w-4" />
                          {copy("Clear mask", "清除蒙版")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={saveDrawnMask}
                          disabled={isEditing || maskPoints.length === 0}
                        >
                          <Save className="mr-2 h-4 w-4" />
                          {copy("Save mask", "保存蒙版")}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                {maskFile && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {copy("Saved mask", "已保存蒙版")}
                    </p>
                    <div className="relative aspect-video w-44 overflow-hidden rounded-md border bg-muted">
                      <Image
                        src={maskFile.previewUrl}
                        alt={copy("Mask preview", "蒙版预览")}
                        fill
                        sizes="176px"
                        className="object-contain"
                        unoptimized
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4 rounded-lg border border-border bg-background p-4">
                {showImageModelControls && (
                  <div
                    className={`space-y-2 ${
                      editMixWebFirstActive ? "opacity-55" : ""
                    }`}
                    title={
                      editMixWebFirstActive
                        ? responsesOnlyDisabledReason
                        : undefined
                    }
                  >
                    <label
                      htmlFor="edit-model"
                      className="text-sm font-medium text-foreground"
                    >
                      {labelWithHelp(
                        copy("Image model", "图片模型"),
                        imageModelHelpText
                      )}
                    </label>
                    <Select
                      value={editModel}
                      onValueChange={setEditModel}
                      disabled={isEditing || editMixWebFirstActive || editFireflyActive}
                    >
                      <SelectTrigger
                        id="edit-model"
                        className="w-full"
                        title={imageModelHelpText}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EDIT_MODEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {editModelLabel(option.label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {!isFireflyModel(editModel) && (
                  <div className="space-y-2">
                    <label
                      htmlFor="edit-gpt-model"
                      className="text-sm font-medium text-foreground"
                    >
                      {labelWithHelp(
                        copy("GPT model", "GPT 模型"),
                        gptModelHelpText
                      )}
                    </label>
                    {renderGptModelSelect({
                      id: "edit-gpt-model",
                      value: imageGptModel,
                      onChange: setImageGptModel,
                      disabled: isEditing,
                      allowDefault: true,
                    })}
                    <p className="text-xs leading-snug text-muted-foreground">
                      {copy(
                        "Used by platform Web/Codex backend pools; external image APIs keep using the image model.",
                        "仅用于平台 Web/Codex 后端池；默认会沿用后端配置，外接 image API 仍按图片模型请求。"
                      )}
                    </p>
                  </div>
                )}

                {showThinkingControls && !isFireflyModel(editModel) && (
                  <div className="space-y-2">
                    <label
                      htmlFor="edit-thinking"
                      className="text-sm font-medium text-foreground"
                    >
                      {labelWithHelp(
                        copy("Thinking", "思考强度"),
                        thinkingHelpText
                      )}
                    </label>
                    {renderThinkingSelect({
                      id: "edit-thinking",
                      value: imageThinking,
                      onChange: setImageThinking,
                      disabled: isEditing,
                    })}
                  </div>
                )}

                {!isWebOnlyBackend && (
                  <>
                    <div
                      className={`space-y-2 ${
                        editMixWebFirstActive ? "opacity-55" : ""
                      }`}
                      title={
                        editMixWebFirstActive
                          ? responsesOnlyDisabledReason
                          : undefined
                      }
                    >
                      <label
                        htmlFor="edit-quality"
                        className="text-sm font-medium text-foreground"
                      >
                        {copy("Quality", "质量")}
                      </label>
                      <Select
                        value={quality}
                        onValueChange={(value) =>
                          setQuality(value as ImageQuality)
                        }
                        disabled={isEditing || editMixWebFirstActive}
                      >
                        <SelectTrigger id="edit-quality" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {QUALITY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {qualityLabel(option.value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div
                      className={`space-y-2 ${
                        editMixWebFirstActive ? "opacity-55" : ""
                      }`}
                      title={
                        editMixWebFirstActive
                          ? responsesOnlyDisabledReason
                          : undefined
                      }
                    >
                      <label
                        htmlFor="edit-output-format"
                        className="text-sm font-medium text-foreground"
                      >
                        {labelWithHelp(
                          copy("Output format", "输出格式"),
                          outputFormatHelpText
                        )}
                      </label>
                      <Select
                        value={outputFormat}
                        onValueChange={(value) =>
                          setOutputFormat(value as ImageOutputFormat)
                        }
                        disabled={isEditing || editMixWebFirstActive || editFireflyActive}
                      >
                        <SelectTrigger
                          id="edit-output-format"
                          className="w-full"
                          title={outputFormatHelpText}
                        >
                          <SelectValue />
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

                    {outputFormat !== "png" && (
                      <div
                        className={`space-y-2 ${
                          editMixWebFirstActive ? "opacity-55" : ""
                        }`}
                        title={
                          editMixWebFirstActive
                            ? responsesOnlyDisabledReason
                            : undefined
                        }
                      >
                        <label
                          htmlFor="edit-output-compression"
                          className="text-sm font-medium text-foreground"
                        >
                          {labelWithHelp(
                            copy("Compression", "压缩率"),
                            outputCompressionHelpText
                          )}
                        </label>
                        <Input
                          id="edit-output-compression"
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={outputCompression}
                          onChange={(event) =>
                            setOutputCompression(
                              Math.min(
                                100,
                                Math.max(0, Number(event.target.value) || 0)
                              )
                            )
                          }
                          disabled={isEditing || editMixWebFirstActive || editFireflyActive}
                          title={outputCompressionHelpText}
                        />
                      </div>
                    )}

                    <div
                      className={`space-y-2 ${
                        editMixWebFirstActive ? "opacity-55" : ""
                      }`}
                      title={
                        editMixWebFirstActive
                          ? responsesOnlyDisabledReason
                          : backgroundHelpText
                      }
                    >
                      <label
                        htmlFor="edit-background"
                        className="text-sm font-medium text-foreground"
                      >
                        {labelWithHelp(
                          copy("Background", "背景"),
                          backgroundHelpText
                        )}
                      </label>
                      {renderBackgroundSelect({
                        id: "edit-background",
                        disabled: isEditing || editMixWebFirstActive,
                      })}
                      {renderTransparentMatteToggle({
                        id: "edit-transparent-matte",
                        disabled: isEditing || editMixWebFirstActive,
                      })}
                    </div>

                    <div
                      className={`space-y-2 ${
                        editMixWebFirstActive ? "opacity-55" : ""
                      }`}
                      title={
                        editMixWebFirstActive
                          ? responsesOnlyDisabledReason
                          : undefined
                      }
                    >
                      <label
                        htmlFor="edit-oai-moderation"
                        className="text-sm font-medium text-foreground"
                      >
                        {copy("OAI moderation strength", "OAI 自身审核强度")}
                      </label>
                      <Select
                        value={moderation}
                        onValueChange={(value) =>
                          setModeration(value as ImageModeration)
                        }
                        disabled={isEditing || editMixWebFirstActive || editFireflyActive}
                      >
                        <SelectTrigger
                          id="edit-oai-moderation"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODERATION_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {moderationLabel(option.value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
                {editMixWebFirstActive &&
                  responsesOnlyDisabledReason &&
                  !isWebOnlyBackend && (
                    <p className="text-xs text-muted-foreground">
                      {responsesOnlyDisabledReason}
                    </p>
                  )}

                <div className="space-y-2">
                  <label
                    htmlFor="edit-batch-count"
                    className="text-sm font-medium text-foreground"
                  >
                    {copy("Batch", "批量")}
                  </label>
                  <ConcurrencyNumberInput
                    id="edit-batch-count"
                    value={editBatchCount}
                    max={batchCountMax}
                    disabled={isEditing}
                    onChange={setEditBatchCount}
                  />
                </div>

                <div className="space-y-3 rounded-md bg-muted/40 p-3">
                  <label
                    htmlFor="edit-use-source-size"
                    className="flex cursor-pointer items-start gap-2 text-sm font-medium text-foreground"
                  >
                    <Checkbox
                      id="edit-use-source-size"
                      checked={useEditFirstImageSize}
                      onCheckedChange={(checked) => {
                        setUseEditFirstImageSize(checked === true);
                        if (checked === true) setUseAutoEditSize(false);
                      }}
                      disabled={isEditing}
                      className="mt-0.5"
                    />
                    <span>
                      {copy(
                        "Use first image resolution",
                        "使用第一张图片分辨率"
                      )}
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {copy(
                          "Default for edits. If the reference dimensions are not supported as an output size, the request is rounded to the nearest valid size. Turn off for outpainting or canvas extension.",
                          "编辑默认使用该尺寸；如果参考图尺寸不能作为输出尺寸，请求会贴近到合法尺寸。扩图或扩展画布时可关闭。"
                        )}
                      </span>
                    </span>
                  </label>

                  {!useEditFirstImageSize && (
                    <div className="space-y-3 border-t border-border pt-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-muted-foreground">
                          {copy("Current", "当前")}：
                          <span className="font-medium text-foreground">
                            {useAutoEditSize ? autoSizeLabel : customEditSize}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setEditSizeDialogOpen(true)}
                          disabled={isEditing}
                          size="sm"
                        >
                          {copy("Set size", "设置尺寸")}
                        </Button>
                      </div>
                      {!customEditSizeCheck.valid && (
                        <p className="text-xs text-destructive">
                          {validationMessage(customEditSizeCheck.message)}
                        </p>
                      )}
                    </div>
                  )}
                  {/* 高清修复:超分后处理与后端无关,放尺寸卡内确保 web 后端也可见。 */}
                  {renderHdRepairToggle({
                    id: "edit-hd-repair",
                    disabled: isEditing,
                  })}
                </div>

                <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                  <p>
                    {labelWithHelp(
                      copy("Output size", "输出尺寸"),
                      resolutionHelpText
                    )}
                    :{" "}
                    <span className="font-medium text-foreground">
                      {editDisplaySize}
                    </span>
                  </p>
                  {editReferenceSizeNote && (
                    <p className="mt-1">{editReferenceSizeNote}</p>
                  )}
                  <p className="mt-1">
                    {customApiActive && !editHasImageReference ? (
                      <span className="font-medium text-foreground">
                        {customApiBillingLabel}
                      </span>
                    ) : (
                      <>
                        {copy("Cost", "费用")}:{" "}
                        <span className="font-medium text-foreground">
                          {formattedEditBatchCreditCost}
                        </span>
                        {batchCostSuffix(editBatchCount)}
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={
                  isEditing || !editPromptHasText || editImages.length === 0
                }
              >
                {isEditing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {copy("Editing", "编辑中")}
                  </>
                ) : (
                  <>
                    <ImagePlus className="mr-2 h-4 w-4" />
                    {copy("Edit image", "编辑图片")}
                  </>
                )}
              </Button>
            </div>
          </form>
          {renderVisualOutput("image")}
        </div>

        <div
          role="tabpanel"
          hidden={
            activeMode !== "chat" &&
            activeMode !== "agent" &&
            activeMode !== "chat-web"
          }
          className="mt-0"
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {activeMode === "agent" ? (
                    <Wand2 className="h-4 w-4" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                  {activeMode === "agent"
                    ? copy("Agent mode", "Agent 模式")
                    : activeMode === "chat-web"
                      ? copy("Web chat", "网页对话")
                      : copy("Chat mode", "对话模式")}
                </div>
                <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                  {activeMode === "agent"
                    ? copy(
                        "Codex-style agent mode can search, read attached files, use tools, and show the run process.",
                        "Codex 风格 Agent 模式可联网、读取附件、调用工具，并展示运行过程。"
                      )
                    : activeMode === "chat-web"
                      ? copy(
                          "Web conversation over ChatGPT web accounts — keeps context for text/image creation, and can generate editable PPT/PSD in the same chat.",
                          "网页对话(基于 ChatGPT 网页账号):保留上下文进行文字/图片创作,并可在同一对话里生成可编辑 PPT/PSD。"
                        )
                      : copy(
                          "Original chat mode keeps conversation context for text/image creation without forcing agent tools.",
                          "原对话模式保留上下文进行文字/图片创作,不强制注入 Agent 工具。"
                        )}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Select
                  value={
                    activeConversationExists
                      ? chatConversationId
                      : currentModeConversations[0]?.id || chatConversationId
                  }
                  onValueChange={(value) => {
                    const conversation = currentModeConversations.find(
                      (item) => item.id === value
                    );
                    if (conversation) {
                      handleOpenChatConversation(conversation);
                    }
                  }}
                  disabled={
                    isChatGenerating || currentModeConversations.length === 0
                  }
                >
                  <SelectTrigger className="h-9 w-[180px] sm:w-[220px]">
                    <SelectValue
                      placeholder={copy("Chat history", "历史对话")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {currentModeConversations.map((conversation) => (
                      <SelectItem key={conversation.id} value={conversation.id}>
                        {conversation.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleNewChat}
                  disabled={isChatGenerating}
                >
                  <Plus className="h-4 w-4" />
                  {copy("New chat", "新对话")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleClearChatHistory}
                  disabled={
                    isChatGenerating || visibleChatMessages.length === 0
                  }
                >
                  <Trash2 className="h-4 w-4" />
                  {copy("Clear history", "清理记录")}
                </Button>
                {chatAttachments.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={clearChatAttachments}
                    disabled={isChatGenerating}
                  >
                    <X className="h-4 w-4" />
                    {copy("Clear attachments", "清除附件")}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex min-h-[680px] flex-col overflow-hidden rounded-lg border border-border bg-background">
              <div
                ref={chatMessagesRef}
                className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
              >
                {visibleChatMessages.length === 0 ? (
                  <div className="flex min-h-[420px] flex-col items-center justify-center text-center text-muted-foreground">
                    {activeMode === "agent" ? (
                      <Wand2 className="mb-3 h-8 w-8" />
                    ) : (
                      <MessageSquare className="mb-3 h-8 w-8" />
                    )}
                    <p className="text-sm font-medium text-foreground">
                      {activeMode === "agent"
                        ? copy("Start an agent run", "开始 Agent 任务")
                        : copy("Start a visual conversation", "开始视觉对话")}
                    </p>
                    <p className="mt-1 max-w-md text-xs">
                      {activeMode === "agent"
                        ? copy(
                            "Agent mode can use tools, search, and iterate images in the same run.",
                            "Agent 模式可以调用工具、联网查询，并在同一轮中迭代图片。"
                          )
                        : copy(
                            "Auto mode generates from text, edits attached images, and keeps the conversation as context.",
                            "Auto 模式会根据文字生成图片、编辑附件图片，并保留对话上下文。"
                          )}
                    </p>
                  </div>
                ) : (
                  <>
                    {visibleChatMessages.map((message) => {
                      const variants = getChatVariants(message);
                      const activeVariant = getActiveChatVariant(message);
                      const activeIndex = message.activeVariant || 0;
                      const webChoiceVariants = variants.filter(
                        (variant) =>
                          variant.outputRole === "choice" && variant.imageUrl
                      );
                      const isStreamingMessage =
                        chatStream?.messageId === message.id;
                      const activeVariantPending =
                        activeVariant?.pending === true;

                      return (
                        <div
                          key={message.id}
                          className={`flex ${
                            message.role === "user"
                              ? "justify-end"
                              : "justify-start"
                          }`}
                        >
                          <div
                            className={`max-w-[88%] ${
                              message.role === "user"
                                ? "text-right"
                                : "text-left"
                            }`}
                          >
                            <div
                              className={`rounded-lg border px-3 py-3 text-sm ${
                                message.role === "user"
                                  ? "rounded-br-[5px] border-transparent bg-secondary text-secondary-foreground"
                                  : "rounded-bl-[5px] border-border bg-background text-foreground"
                              }`}
                            >
                              {message.role === "user" ? (
                                <div className="flex flex-col gap-3">
                                  {message.attachments?.length ? (
                                    <div className="flex flex-wrap justify-end gap-2">
                                      {message.attachments.map((attachment) => (
                                        <div
                                          key={attachment.id}
                                          className="relative h-12 w-12 overflow-hidden rounded-md border border-border bg-muted"
                                        >
                                          {attachment.kind === "file" ||
                                          !attachment.previewUrl ? (
                                            <span className="flex h-full w-full items-center justify-center">
                                              <FileText className="h-5 w-5 text-muted-foreground" />
                                            </span>
                                          ) : (
                                            <Image
                                              src={attachment.previewUrl}
                                              alt={attachment.name}
                                              fill
                                              sizes="48px"
                                              className="object-cover"
                                              unoptimized
                                            />
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                  <p className="whitespace-pre-wrap break-words">
                                    {message.text}
                                  </p>
                                </div>
                              ) : isStreamingMessage ? (
                                renderChatStreamBubble(message.id)
                              ) : message.error ? (
                                <p className="text-destructive">
                                  {message.error}
                                </p>
                              ) : activeVariant ? (
                                <div>
                                  {renderThinkingBlock(
                                    activeVariant.responseThinking,
                                    message.mode === "agent"
                                  )}
                                  {message.mode === "agent"
                                    ? renderAgentRoundCards(
                                        activeVariant.agentEvents,
                                        activeVariant.responseAgent,
                                        true
                                      )
                                    : null}
                                  {activeVariant.responseText && (
                                    <p
                                      className={`whitespace-pre-wrap break-words leading-relaxed ${
                                        activeVariant.imageUrl ? "mb-3" : ""
                                      }`}
                                    >
                                      {activeVariant.responseText}
                                    </p>
                                  )}
                                  {activeVariant.files?.length ? (
                                    <div className="mt-2 flex flex-col gap-2">
                                      {activeVariant.files.map((chatFile) => (
                                        <a
                                          key={chatFile.url}
                                          href={chatFile.url}
                                          download
                                          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm transition-colors duration-150 hover:bg-muted"
                                        >
                                          <FileText className="h-4 w-4" />
                                          {copy("Download", "下载")}{" "}
                                          {chatFile.label}
                                        </a>
                                      ))}
                                    </div>
                                  ) : null}
                                  {activeVariant.imageUrl && (
                                    <div className="overflow-hidden rounded-md border bg-background">
                                      <button
                                        type="button"
                                        className="group relative block w-full bg-muted"
                                        style={{
                                          aspectRatio: `${
                                            parseImageSize(activeVariant.size)
                                              ?.width || defaultDimensions.width
                                          } / ${
                                            parseImageSize(activeVariant.size)
                                              ?.height ||
                                            defaultDimensions.height
                                          }`,
                                        }}
                                        onClick={() => {
                                          if (activeVariant.generationId) {
                                            setSelectedRecentId(
                                              activeVariant.generationId
                                            );
                                          }
                                        }}
                                        title={copy(
                                          "Open image preview",
                                          "打开图片预览"
                                        )}
                                      >
                                        <Image
                                          src={thumbSrc(
                                            activeVariant.imageUrl,
                                            512
                                          )}
                                          alt={activeVariant.prompt}
                                          fill
                                          sizes="(max-width: 768px) 80vw, 420px"
                                          className="object-contain"
                                          unoptimized={shouldBypassImageOptimization(
                                            activeVariant.imageUrl
                                          )}
                                        />
                                        <span className="absolute right-2 top-2 rounded bg-background/90 px-2 py-1 text-[11px] font-medium text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                          <Eye className="mr-1 inline h-3 w-3" />
                                          {copy("Preview", "预览")}
                                        </span>
                                      </button>
                                      <div className="flex flex-wrap gap-2 p-2">
                                        <Button
                                          asChild
                                          variant="outline"
                                          size="xs"
                                        >
                                          <a
                                            href={activeVariant.imageUrl}
                                            download
                                            target="_blank"
                                            rel="noopener noreferrer"
                                          >
                                            <Download className="h-3 w-3" />
                                            {copy("Download", "下载")}
                                          </a>
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          onClick={() =>
                                            attachResultToChat(activeVariant)
                                          }
                                        >
                                          <RefreshCcw className="h-3 w-3" />
                                          {copy("Edit next", "继续编辑")}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                  {activeVariantPending && (
                                    <div className="mt-3 flex items-center gap-2 text-muted-foreground">
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                      {copy(
                                        "Generation is still running. Reconnecting to status...",
                                        "仍在生成中，正在恢复状态..."
                                      )}
                                    </div>
                                  )}
                                  {!activeVariant.responseText &&
                                    !activeVariant.imageUrl &&
                                    !activeVariantPending && (
                                      <p className="text-muted-foreground">
                                        {copy(
                                          "Response generated",
                                          "回复已生成"
                                        )}
                                      </p>
                                    )}
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  {copy("Generating...", "生成中...")}
                                </div>
                              )}
                            </div>

                            {message.role === "assistant" && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {variants.length > 1 && (
                                  <div className="inline-flex items-center rounded-md border border-border bg-background text-xs text-muted-foreground">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      disabled={
                                        isChatGenerating || activeIndex === 0
                                      }
                                      onClick={() =>
                                        handleChatVariantChange(message.id, -1)
                                      }
                                      title={copy(
                                        "Previous variant",
                                        "上一个版本"
                                      )}
                                    >
                                      <ChevronLeft className="h-3 w-3" />
                                    </Button>
                                    <span className="px-2">
                                      {activeIndex + 1} / {variants.length}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      disabled={
                                        isChatGenerating ||
                                        activeIndex >= variants.length - 1
                                      }
                                      onClick={() =>
                                        handleChatVariantChange(message.id, 1)
                                      }
                                      title={copy("Next variant", "下一个版本")}
                                    >
                                      <ChevronRight className="h-3 w-3" />
                                    </Button>
                                  </div>
                                )}
                                {webChoiceVariants.length > 1 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {variants.map((variant, index) => {
                                      if (
                                        variant.outputRole !== "choice" ||
                                        !variant.imageUrl
                                      ) {
                                        return null;
                                      }
                                      return (
                                        <button
                                          key={`${variant.generationId || index}-choice`}
                                          type="button"
                                          className={`relative h-10 w-10 overflow-hidden rounded-md border bg-muted ${
                                            index === activeIndex
                                              ? "border-primary ring-1 ring-primary"
                                              : "border-border"
                                          }`}
                                          onClick={() =>
                                            handleChatVariantSelect(
                                              message.id,
                                              index
                                            )
                                          }
                                          title={copy(
                                            `Choose image ${index + 1}`,
                                            `选择第 ${index + 1} 张`
                                          )}
                                        >
                                          <Image
                                            src={thumbSrc(variant.imageUrl, 256)}
                                            alt={variant.prompt}
                                            fill
                                            sizes="40px"
                                            className="object-contain"
                                            unoptimized={shouldBypassImageOptimization(
                                              variant.imageUrl
                                            )}
                                          />
                                          {index === activeIndex && (
                                            <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                                              <Check className="h-2.5 w-2.5" />
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {variants.some(
                                  (variant) => variant.outputRole === "choice"
                                ) && (
                                  <span className="text-xs text-muted-foreground">
                                    {copy(
                                      "Web returned multiple choices; switching syncs the selected image.",
                                      "Web 返回了多个候选，切换时会同步选中图片。"
                                    )}
                                  </span>
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={isChatGenerating}
                                  onClick={() => handleChatRetry(message.id)}
                                  title={
                                    message.error
                                      ? copy("Retry generation", "重试生成")
                                      : copy(
                                          "Generate another variant",
                                          "再生成一个版本"
                                        )
                                  }
                                >
                                  <RefreshCcw className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

                {chatStream &&
                  !retryingChatMessageId &&
                  !chatStream.messageId && (
                    <>
                      {chatStream.mode === activeConversationMode && (
                        <div className="flex justify-start">
                          <div className="max-w-[88%]">
                            {renderChatStreamBubble(undefined)}
                          </div>
                        </div>
                      )}
                    </>
                  )}
              </div>

              {renderChatInput()}
            </div>
          </div>
        </div>

        <div
          role="tabpanel"
          hidden={activeMode !== "waterfall"}
          className="mt-0"
        >
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
                {/* 每批并发张数(tier)：对齐原项目 TIER，可选项受套餐并发上限约束 */}
                <Select
                  value={String(effectiveWaterfallTier)}
                  onValueChange={(value) => setWaterfallTier(Number(value))}
                  disabled={isBatchActive}
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
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUALITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {qualityLabel(option.value)}
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
                  disabled={isBatchActive}
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
                            title={copy(
                              "Remove reference image",
                              "移除参考图片"
                            )}
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
                <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
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
                <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
                  {batchCards.map((card) => (
                    <div
                      key={card.id}
                      className={`mb-3 break-inside-avoid overflow-hidden rounded-lg border bg-muted/30 ${
                        card.state === "error"
                          ? "border-destructive/30"
                          : "border-border"
                      }`}
                      style={
                        card.aspectRatio &&
                        (card.state === "loading" ||
                          (card.state === "image" && !card.imageUrl))
                          ? { aspectRatio: card.aspectRatio }
                          : undefined
                      }
                    >
                      {card.state === "loading" && !card.imageUrl && (
                        <div className="flex h-full min-h-40 items-center justify-center text-muted-foreground">
                          <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                      )}

                      {card.imageUrl && (
                        <button
                          type="button"
                          className="group relative block w-full bg-muted"
                          onClick={() => {
                            if (card.generationId) {
                              setSelectedRecentId(card.generationId);
                            }
                          }}
                          title={copy("Open image preview", "打开图片预览")}
                        >
                          <Image
                            src={thumbSrc(card.imageUrl, 640)}
                            alt={card.prompt}
                            width={640}
                            height={640}
                            className="h-auto w-full object-contain"
                            unoptimized={shouldBypassImageOptimization(
                              card.imageUrl
                            )}
                          />
                          {card.state === "loading" && (
                            <span className="absolute left-2 top-2 rounded-full bg-background/90 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm">
                              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                              {copy("Streaming", "流式生成中")}
                            </span>
                          )}
                          {card.state === "image" && (
                            <div className="absolute inset-x-2 bottom-2 hidden items-center justify-end gap-1 group-hover:flex">
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon-xs"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  saveBatchCardToRecent(card);
                                }}
                                disabled={card.saved}
                                title={copy("Save to recent", "保存到最近生成")}
                              >
                                <Save className="h-3 w-3" />
                              </Button>
                              <Button
                                asChild
                                variant="secondary"
                                size="icon-xs"
                                title={copy("Download", "下载")}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <a
                                  href={card.imageUrl}
                                  download
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Download className="h-3 w-3" />
                                </a>
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon-xs"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (card.generationId) {
                                    setSelectedRecentId(card.generationId);
                                  }
                                }}
                                title={copy("Fullscreen", "全屏")}
                              >
                                <Maximize2 className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </button>
                      )}

                      {card.state === "text" && (
                        <div className="p-3 text-sm leading-relaxed">
                          {renderThinkingBlock(card.streamThinking)}
                          {renderAgentBlock(card.streamAgent)}
                          <p className="whitespace-pre-wrap break-words">
                            {card.text || card.streamText || ""}
                          </p>
                        </div>
                      )}

                      {card.state === "error" && (
                        <div className="space-y-3 p-3 text-sm text-destructive">
                          <p className="break-words">
                            {card.error ||
                              copy("Generation failed", "生成失败")}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              triggerBatchGeneration({
                                retryCardId: card.id,
                              })
                            }
                          >
                            <RefreshCcw className="h-4 w-4" />
                            {copy("Retry", "重试")}
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
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

        <div role="tabpanel" hidden={activeMode !== "video"} className="mt-0">
          <VideoCreatePanel recent={recent} pricing={videoPricing} />
        </div>
      </Tabs>

      {recent.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <h2 className="font-serif text-xl font-semibold tracking-tight">
              {copy("Recent", "最近生成")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {isConversationMode(activeMode)
                ? copy(
                    "Click an image to attach it as the next reference.",
                    "点击图片可作为下一次参考图。"
                  )
                : activeMode === "image"
                  ? copy(
                      "Click an image to add or remove it as a reference.",
                      "点击图片可添加或移除为参考图。"
                    )
                  : copy(
                      "Click an image to open the full preview.",
                      "点击图片打开完整预览。"
                    )}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            {recent.map((g) => {
              const selectedForEdit = editImages.some(
                (item) => item.sourceId === g.id
              );
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`group relative aspect-square overflow-hidden rounded-md border bg-muted text-left transition duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    selectedForEdit && activeMode === "image"
                      ? "border-primary ring-2 ring-primary/50"
                      : "hover:border-foreground/40"
                  }`}
                  title={
                    isConversationMode(activeMode)
                      ? copy("Attach as reference", "添加为参考")
                      : activeMode === "image"
                        ? copy("Use as reference image", "作为参考图片")
                        : copy("Open image preview", "打开图片预览")
                  }
                  onClick={() => handleRecentClick(g)}
                  disabled={!g.imageUrl}
                >
                  {g.imageUrl ? (
                    <Image
                      src={thumbSrc(g.imageUrl, 320)}
                      alt={g.prompt}
                      fill
                      sizes="80px"
                      className="object-contain transition-[scale,filter] duration-150 group-hover:scale-105 group-hover:brightness-105"
                      unoptimized={shouldBypassImageOptimization(g.imageUrl)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <ImagePlus className="h-6 w-6" />
                    </div>
                  )}
                  <span className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-background/90 px-2 py-1 text-[11px] font-medium text-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                    {isConversationMode(activeMode) ? (
                      <>
                        <MessageSquare className="mr-1 h-3 w-3" />
                        {copy("Attach", "添加参考")}
                      </>
                    ) : activeMode === "image" ? (
                      selectedForEdit ? (
                        <>
                          <Check className="mr-1 h-3 w-3" />
                          {copy("Selected", "已选择")}
                        </>
                      ) : (
                        <>
                          <ImagePlus className="mr-1 h-3 w-3" />
                          {copy("Use as reference", "作为参考图")}
                        </>
                      )
                    ) : (
                      <>
                        <Eye className="mr-1 h-3 w-3" />
                        {copy("Preview", "预览")}
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {selectedRecent && (
        <ImageLightbox
          generation={selectedRecent as LightboxGeneration}
          imageUrl={selectedRecent.imageUrl}
          open={selectedRecentId !== null}
          timeZone={timeZone}
          onClose={() => setSelectedRecentId(null)}
          onDelete={
            selectedRecent.canDelete === false
              ? undefined
              : (id) => {
                  setRecent((prev) => prev.filter((item) => item.id !== id));
                  setEditImages((prev) => {
                    const next = prev.filter((item) => item.sourceId !== id);
                    for (const item of prev) {
                      if (item.sourceId === id) revokePreview(item.previewUrl);
                    }
                    return next;
                  });
                }
          }
        />
      )}

      <ImageSizeDialog
        open={textSizeDialogOpen}
        onOpenChange={setTextSizeDialogOpen}
        title={copy("Set image size", "设置图像尺寸")}
        value={textSizeDialogValue}
        copy={copy}
        validationMessage={validationMessage}
        showMixRouting={canUseMixWebFirstRouting}
        mixRoutingPixelRange={forceWebPixelRange}
        onConfirm={(next) => {
          setUseAutoSize(next.auto);
          setTextMixWebFirst(next.mixWebFirst);
          if (!next.auto) {
            setWidth(next.width);
            setHeight(next.height);
          }
        }}
      />
      <ImageSizeDialog
        open={editSizeDialogOpen}
        onOpenChange={setEditSizeDialogOpen}
        title={copy("Set image size", "设置图像尺寸")}
        value={editSizeDialogValue}
        copy={copy}
        validationMessage={validationMessage}
        showMixRouting={canUseMixWebFirstRouting}
        mixRoutingPixelRange={forceWebPixelRange}
        onConfirm={(next) => {
          setUseEditFirstImageSize(false);
          setUseAutoEditSize(next.auto);
          setEditMixWebFirst(next.mixWebFirst);
          if (!next.auto) {
            setEditWidth(next.width);
            setEditHeight(next.height);
          }
        }}
      />
      <ImageSizeDialog
        open={chatSizeDialogOpen}
        onOpenChange={setChatSizeDialogOpen}
        title={copy("Set image size", "设置图像尺寸")}
        value={chatSizeDialogValue}
        copy={copy}
        validationMessage={validationMessage}
        showMixRouting={canUseMixWebFirstRouting}
        mixRoutingPixelRange={forceWebPixelRange}
        onConfirm={(next) => {
          setChatMixWebFirst(next.mixWebFirst);
          if (hasChatImageAttachments) {
            setUseAutoChatEditSize(next.auto);
            if (!next.auto) {
              setChatEditWidth(next.width);
              setChatEditHeight(next.height);
            }
            return;
          }
          setUseAutoSize(next.auto);
          if (!next.auto) {
            setWidth(next.width);
            setHeight(next.height);
          }
        }}
      />
      {waterfallWarning && (
        <WaterfallWarningPopup
          type={waterfallWarning.type}
          tier={waterfallWarning.tier}
          count={waterfallWarning.count}
          copy={copy}
          onClose={() => {
            // 里程碑警告确认后：解除阻塞并恢复自动续批；首次提示关闭仅落标记不续批
            const wasMilestoneBlock = warningBlockRef.current;
            setWaterfallWarning(null);
            if (wasMilestoneBlock) {
              warningBlockRef.current = false;
              void triggerBatchGeneration();
            }
          }}
        />
      )}
    </div>
  );
}
