"use client";

/**
 * 图生图面板(独立组件,从 create-page-client 拆出)。
 *
 * 职责:源图上传/蒙版绘制/编辑设置/批量。面板内部订阅 activeMode 与本
 * 面板的全部 store 状态(editImages、蒙版、尺寸/格式设置等),切 tab 时
 * props 稳定只更新 hidden;上传与编辑期间的高频帧(editImages、蒙版
 * 坐标)限制在本面板重渲。
 *
 * 约束:传入的渲染回调与 handler 必须是稳定引用(父级 useCallback)。
 */

import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  Brush,
  Eraser,
  ImagePlus,
  Loader2,
  Save,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import type {
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
} from "../types";
import type { ChatModel, ChatThinkingLevel } from "./create-page-client";
import {
  ConcurrencyNumberInput,
  EDIT_MODEL_OPTIONS,
  formatMegabytes,
  getMentionTrigger,
  IMAGE_ACCEPT,
  MODERATION_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
} from "./panel-shared";
import { PromptTextareaField } from "./prompt-textarea-field";

export function ImagePanel({
  addImages,
  backgroundHelpText,
  batchCostSuffix,
  customApiActive,
  editModelLabel,
  moderationLabel,
  outputCompressionHelpText,
  outputFormatHelpText,
  outputFormatLabel,
  qualityLabelWithBilling,
  setEditSizeDialogOpen,
  showImageModelControls,
  showThinkingControls,
  isWebOnlyBackend,
  autoSizeLabel,
  batchCountMax,
  canUseEditReferenceMentions,
  clearDrawnMask,
  clearEditImages,
  clearMask,
  customApiBillingLabel,
  customEditSize,
  customEditSizeCheck,
  drawMaskLine,
  editCreditFormula,
  editDisplaySize,
  editMixWebFirstActive,
  editPromptRef,
  editQualityMultipliers,
  editReferenceMentionStatusText,
  editReferenceSizeNote,
  filteredEditReferenceOptions,
  firstPreviewUrl,
  formattedEditBatchCreditCost,
  gptModelHelpText,
  handleEditPromptChange,
  handleEditSubmit,
  handleImagePaste,
  imageInputRef,
  imageModelHelpText,
  labelWithHelp,
  maskCanvasRef,
  maskInputRef,
  maxEditImages,
  maxEditRequestBytes,
  promptOptimizationField,
  removeImage,
  renderBackgroundSelect,
  renderGptModelSelect,
  renderHdRepairToggle,
  renderReferenceMentionMenu,
  renderThinkingSelect,
  renderTransparentMatteToggle,
  renderVisualOutput,
  resolutionHelpText,
  responsesOnlyDisabledReason,
  saveDrawnMask,
  selectEditMention,
  setMask,
  startMaskDrawing,
  stopMaskDrawing,
  thinkingHelpText,
  validationMessage,
}: {
  addImages: (files: FileList | File[] | null) => void;
  autoSizeLabel: React.ReactNode;
  backgroundHelpText: string;
  batchCostSuffix: (count: number) => React.ReactNode;
  customApiActive: boolean;
  editModelLabel: (value: string) => string;
  moderationLabel: (value: ImageModeration) => string;
  outputCompressionHelpText: string;
  outputFormatHelpText: string;
  outputFormatLabel: (format: ImageOutputFormat) => string;
  qualityLabelWithBilling: (
    value: ImageQuality,
    multipliers?: Partial<Record<string, number>> | null
  ) => string;
  setEditSizeDialogOpen: (open: boolean) => void;
  showImageModelControls: boolean;
  showThinkingControls: boolean;
  isWebOnlyBackend: boolean;
  batchCountMax: number;
  canUseEditReferenceMentions: boolean;
  clearDrawnMask: () => void;
  clearEditImages: () => void;
  clearMask: () => void;
  customApiBillingLabel: React.ReactNode;
  customEditSize: string;
  customEditSizeCheck: { valid: boolean; message?: string };
  drawMaskLine: (...args: never[]) => void;
  editCreditFormula: React.ReactNode;
  editDisplaySize: string;
  editMixWebFirstActive: boolean;
  editPromptRef: React.RefObject<HTMLTextAreaElement | null>;
  editQualityMultipliers: Partial<Record<string, number>> | null;
  editReferenceMentionStatusText: string;
  editReferenceSizeNote: React.ReactNode;
  filteredEditReferenceOptions: Array<{
    token: string;
    label: string;
    detail: string;
    previewUrl?: string;
  }>;
  firstPreviewUrl: string | null | undefined;
  formattedEditBatchCreditCost: string;
  gptModelHelpText: string;
  handleEditPromptChange: (next: string, cursor: number) => void;
  handleEditSubmit: (e: React.FormEvent) => void;
  handleImagePaste: React.ClipboardEventHandler<HTMLFormElement>;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  imageModelHelpText: string;
  labelWithHelp: (label: string, title: string) => React.ReactNode;
  maskCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  maskInputRef: React.RefObject<HTMLInputElement | null>;
  maxEditImages: number;
  maxEditRequestBytes: number;
  promptOptimizationField: (id: string, disabled?: boolean) => React.ReactNode;
  removeImage: (index: number) => void;
  renderBackgroundSelect: (params: {
    id: string;
    disabled?: boolean;
    compact?: boolean;
  }) => React.ReactNode;
  renderGptModelSelect(params: {
    id: string;
    value: ChatModel | "default";
    onChange: (value: ChatModel | "default") => void;
    disabled?: boolean;
    compact?: boolean;
    allowDefault?: boolean;
  }): React.ReactNode;
  // 注:renderGptModelSelect 的窄类型由主文件函数签名保持;面板调用经
  // value 包装适配,不在此放宽。
  renderHdRepairToggle: (params: {
    id: string;
    disabled?: boolean;
  }) => React.ReactNode;
  renderReferenceMentionMenu: (params: {
    open: boolean;
    options: Array<{
      token: string;
      label: string;
      detail: string;
      previewUrl?: string;
    }>;
    onSelect: (option: {
      token: string;
      label: string;
      detail: string;
      previewUrl?: string;
    }) => void;
    emptyText: string;
  }) => React.ReactNode;
  renderThinkingSelect(params: {
    id: string;
    value: ChatThinkingLevel;
    onChange: (value: ChatThinkingLevel) => void;
    disabled?: boolean;
    compact?: boolean;
  }): React.ReactNode;
  renderTransparentMatteToggle: (params: {
    id: string;
    disabled?: boolean;
  }) => React.ReactNode;
  renderVisualOutput(mode: "image"): React.ReactNode;
  resolutionHelpText: string;
  responsesOnlyDisabledReason: string | undefined;
  saveDrawnMask: () => void;
  selectEditMention: (option: {
    token: string;
    label: string;
    detail: string;
    previewUrl?: string;
  }) => void;
  setMask: (files: FileList | null) => void;
  startMaskDrawing: (...args: never[]) => void;
  stopMaskDrawing: (...args: never[]) => void;
  thinkingHelpText: string;
  validationMessage(message?: string): string | undefined;
}) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [activeMode] = useCreateRuntimeState<string>("activeMode", "text");
  const [editImages] = useCreateRuntimeState<
    Array<{
      id: string;
      file: File;
      previewUrl: string;
      sourceId?: string;
      width?: number;
      height?: number;
    }>
  >("editImages", []);
  const [editMention, setEditMention] = useCreateRuntimeState<{
    open: boolean;
    start: number;
    end: number;
    query: string;
  } | null>("editMention", null);
  const [isEditing] = useCreateRuntimeState("isEditing", false);
  const [maskBrushSize, setMaskBrushSize] = useCreateRuntimeState(
    "maskBrushSize",
    20
  );
  const [maskEditorOpen, setMaskEditorOpen] = useCreateRuntimeState(
    "maskEditorOpen",
    false
  );
  const [maskFile] = useCreateRuntimeState<{
    file: File;
    previewUrl: string;
    sourceId?: string;
  } | null>("maskFile", null);
  const [maskPoints] = useCreateRuntimeState<never[]>("maskPoints", []);
  const [editBatchCount, setEditBatchCount] = useCreateRuntimeState(
    "editBatchCount",
    1
  );
  const [useEditFirstImageSize, setUseEditFirstImageSize] =
    useCreateRuntimeState("useEditFirstImageSize", true);
  const [useAutoEditSize, setUseAutoEditSize] = useCreateRuntimeState(
    "useAutoEditSize",
    true
  );
  const [editHasImageReference] = useCreateRuntimeState(
    "editPromptHasRef",
    false
  );
  const [editPromptHasText] = useCreateRuntimeState("editPromptHasText", false);
  const [imageGptModel, setImageGptModel] = useCreateRuntimeState<
    ChatModel | "default"
  >("imageGptModel", "default");
  const [imageThinking, setImageThinking] =
    useCreateRuntimeState<ChatThinkingLevel>("imageThinking", "low");
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
  const [outputCompression, setOutputCompression] = useCreateRuntimeState(
    "outputCompression",
    90
  );
  const [firstImageSize] = useCreateRuntimeState<{
    width: number;
    height: number;
  } | null>("firstImageSize", null);
  const [editModel, setEditModel] = useCreateRuntimeState(
    "editModel",
    "default"
  );

  return (
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
            emptyText: copy("Upload a source image first.", "请先上传源图片。"),
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
                  <span className="absolute left-1 top-1 z-10 rounded-sm bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-whisper">
                    {index + 1}
                  </span>
                  <Image
                    src={item.previewUrl || ""}
                    alt={
                      item.file.name ||
                      copy(`Source image ${index + 1}`, `源图片 ${index + 1}`)
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
                    src={maskFile.previewUrl || ""}
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
                  disabled={isEditing || editMixWebFirstActive}
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

            <div className="space-y-2">
              <label
                htmlFor="edit-gpt-model"
                className="text-sm font-medium text-foreground"
              >
                {labelWithHelp(copy("GPT model", "GPT 模型"), gptModelHelpText)}
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

            {showThinkingControls && (
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
                    onValueChange={(value) => setQuality(value as ImageQuality)}
                    disabled={isEditing || editMixWebFirstActive}
                  >
                    <SelectTrigger id="edit-quality" className="w-full">
                      <SelectValue>
                        {qualityLabelWithBilling(
                          quality,
                          editQualityMultipliers
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {QUALITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {qualityLabelWithBilling(
                            option.value,
                            editQualityMultipliers
                          )}
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
                    disabled={isEditing || editMixWebFirstActive}
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
                      disabled={isEditing || editMixWebFirstActive}
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
                    disabled={isEditing || editMixWebFirstActive}
                  >
                    <SelectTrigger id="edit-oai-moderation" className="w-full">
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
                  {copy("Use first image resolution", "使用第一张图片分辨率")}
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
                    {batchCostSuffix(editBatchCount)}{" "}
                    <span className="text-muted-foreground">
                      {copy("per image", "单张")} {editCreditFormula}
                    </span>
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
  );
}
