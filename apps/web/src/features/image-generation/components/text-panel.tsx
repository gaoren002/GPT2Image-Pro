"use client";

/**
 * 文生图面板(独立组件,从 create-page-client 拆出)。
 *
 * 职责:单提示词/逐行批量两个子模式。面板自己订阅 activeMode(仅 hidden
 * 布尔翻转重渲)与 textMode/isText*Generating/promptHasText/linePrompts 等
 * 本面板状态;切 tab 时 props 全部稳定,面板只更新 hidden 属性,不再随父
 * 组件全量重算 JSX(此前四个面板 JSX 都在父组件 1 万行渲染里,切 tab 是
 * 全量同步重渲的根源)。
 *
 * 约束:传入的渲染回调(textSettingsPanel/promptOptimizationField/
 * renderVisualOutput)与 handler 必须是稳定引用。
 */

import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { ImagePlus, Loader2 } from "lucide-react";
import { useLocale } from "next-intl";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import { PromptTextareaField } from "./prompt-textarea-field";

export type TextGenerationMode = "single" | "lines";
export type VisualOutputMode = "text-single" | "text-lines" | "image";

export function TextPanel({
  handleSubmit,
  handleTextLineBatchSubmit,
  promptOptimizationField,
  textSettingsPanel,
  renderVisualOutput,
  formattedLineCost,
  lineBatchRepeatCount,
}: {
  handleSubmit: (e: React.FormEvent) => void;
  handleTextLineBatchSubmit: (e: React.FormEvent) => void;
  promptOptimizationField: (id: string, disabled?: boolean) => React.ReactNode;
  textSettingsPanel: (
    mode: TextGenerationMode,
    panel: {
      modeBusy: boolean;
      totalCount: number;
      formattedLineCost: string;
    }
  ) => React.ReactNode;
  renderVisualOutput: (mode: VisualOutputMode) => React.ReactNode;
  /** 逐行批量整批报价(父级即时算,随输入变化)。 */
  formattedLineCost: string;
  lineBatchRepeatCount: number;
}) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [activeMode] = useCreateRuntimeState<string>("activeMode", "text");
  const [textMode, setTextMode] = useCreateRuntimeState<TextGenerationMode>(
    "textMode",
    "single"
  );
  const [isTextSingleGenerating] = useCreateRuntimeState(
    "isTextSingleGenerating",
    false
  );
  const [isTextLinesGenerating] = useCreateRuntimeState(
    "isTextLinesGenerating",
    false
  );
  const [promptHasText] = useCreateRuntimeState("promptHasText", false);
  const [linePrompts, setLinePrompts] = useCreateRuntimeState(
    "linePrompts",
    ""
  );
  const linePromptItems = linePrompts
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const lineBatchTotalCount = linePromptItems.length * lineBatchRepeatCount;

  return (
    <div role="tabpanel" hidden={activeMode !== "text"} className="mt-0">
      <Tabs
        value={textMode}
        onValueChange={(value) => setTextMode(value as TextGenerationMode)}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="single" className="px-4">
            {copy("Single prompt", "单提示词")}
          </TabsTrigger>
          <TabsTrigger value="lines" className="px-4">
            {copy("Line batch", "逐行批量")}
          </TabsTrigger>
        </TabsList>

        <div role="tabpanel" hidden={textMode !== "single"} className="mt-0">
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
            {textSettingsPanel("single", {
              modeBusy: isTextSingleGenerating,
              totalCount: 0,
              formattedLineCost,
            })}
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
            {textSettingsPanel("lines", {
              modeBusy: isTextLinesGenerating,
              totalCount: lineBatchTotalCount,
              formattedLineCost,
            })}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={isTextLinesGenerating || linePromptItems.length === 0}
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
  );
}
