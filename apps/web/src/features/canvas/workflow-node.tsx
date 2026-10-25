"use client";

/** React Flow 自定义节点与交互上下文；持久节点 data 只含模型字段，操作回调留在 Context。 */
import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Textarea } from "@repo/ui/components/textarea";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { ImagePlus, Loader2, Play, Trash2 } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Link } from "@/i18n/routing";
import {
  MAX_WORKFLOW_PROMPT,
  WORKFLOW_MODELS,
  WORKFLOW_QUALITIES,
  WORKFLOW_SIZES,
  type WorkflowData,
  type WorkflowImage,
} from "./workflow-model";

export type WorkflowFlowNode = Node<WorkflowData, "workflow">;
export type WorkflowUI = {
  running: ReadonlySet<string>;
  transferring: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  updateData: (id: string, data: WorkflowData) => void;
  chooseImage: (id: string, result?: boolean) => void;
  requestRun: (id: string) => void;
  acknowledge: (id: string) => void;
  continueEditing: (id: string, image: WorkflowImage) => void;
  remove: (id: string) => void;
};
export const WorkflowUIContext = createContext<WorkflowUI | null>(null);

/** 渲染已通过白名单校验的站内图片；签名/文件失效时明确提示重新选择，禁用外部 referrer。 */
function WorkflowPreview({ image }: { image: WorkflowImage }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === image.url)
    return (
      <p
        role="status"
        className="rounded border border-dashed p-4 text-xs text-muted-foreground"
      >
        图片暂不可用，请刷新近期作品并重新选择，或去历史查看。
      </p>
    );
  return (
    // biome-ignore lint/performance/noImgElement: 私有站内签名图片直接读取，避免优化器改变鉴权上下文。
    <img
      src={image.url}
      alt={image.prompt.slice(0, 100) || "工作流图片"}
      referrerPolicy="no-referrer"
      loading="lazy"
      draggable={false}
      onError={() => setFailedUrl(image.url)}
      className="max-h-64 w-full rounded border object-contain"
    />
  );
}

/** 三类节点共用外壳；生成节点双输入区分提示词/图片，只输出已生成图片。 */
export function WorkflowNodeCard({
  id,
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const ui = useContext(WorkflowUIContext);
  if (!ui) throw new Error("工作流节点缺少 UI 上下文");
  const busy = ui.running.has(id);
  const titles = { prompt: "提示词", image: "参考图", generate: "生成图片" };
  const waiting =
    data.kind === "generate" && data.attempt?.state === "unconfirmed" && !busy;
  return (
    <section
      aria-label={`${titles[data.kind]}节点`}
      className={`relative w-80 rounded-xl border bg-card text-card-foreground shadow-sm ${selected ? "ring-2 ring-primary" : ""}`}
    >
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">{titles[data.kind]}</span>
        <Button
          className="nodrag nopan"
          variant="ghost"
          size="icon"
          aria-label={`删除${titles[data.kind]}节点`}
          aria-disabled={busy}
          onClick={() => ui.remove(id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="nodrag nopan space-y-3 p-4">
        {data.kind === "prompt" && (
          <>
            <Label htmlFor={`prompt-${id}`}>描述想要生成的图片</Label>
            <Textarea
              id={`prompt-${id}`}
              className="nowheel min-h-32 resize-y"
              value={data.text}
              maxLength={MAX_WORKFLOW_PROMPT}
              placeholder="输入提示词，再连接到生成节点左侧的提示词端口"
              onChange={(event) =>
                ui.updateData(id, { kind: "prompt", text: event.target.value })
              }
            />
            <p className="text-right text-xs text-muted-foreground">
              {data.text.length} / {MAX_WORKFLOW_PROMPT}
            </p>
          </>
        )}
        {data.kind === "image" && (
          <>
            {data.image ? (
              <WorkflowPreview image={data.image} />
            ) : (
              <p className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
                从本人近期作品选择参考图
              </p>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => ui.chooseImage(id)}
            >
              <ImagePlus className="mr-2 h-4 w-4" />
              {data.image ? "更换参考图" : "选择近期作品"}
            </Button>
          </>
        )}
        {data.kind === "generate" && (
          <>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>左侧：提示词 / 图片输入</span>
              <span>右侧：图片输出</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`model-${id}`}>模型</Label>
                <Select
                  value={data.model}
                  disabled={busy}
                  onValueChange={(value) => {
                    const model = WORKFLOW_MODELS.find(
                      (item) => item === value
                    );
                    if (model) ui.updateData(id, { ...data, model });
                  }}
                >
                  <SelectTrigger id={`model-${id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_MODELS.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model === "gpt-image-2.5"
                          ? "GPT image 2.5"
                          : "GPT image 2"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`size-${id}`}>尺寸</Label>
                <Select
                  value={data.size}
                  disabled={busy}
                  onValueChange={(value) => {
                    const size = WORKFLOW_SIZES.find((item) => item === value);
                    if (size) ui.updateData(id, { ...data, size });
                  }}
                >
                  <SelectTrigger id={`size-${id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_SIZES.map((size) => (
                      <SelectItem key={size} value={size}>
                        {size.replace("x", " × ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`quality-${id}`}>质量</Label>
                <Select
                  value={data.quality}
                  disabled={busy}
                  onValueChange={(value) => {
                    const quality = WORKFLOW_QUALITIES.find(
                      (item) => item === value
                    );
                    if (quality) ui.updateData(id, { ...data, quality });
                  }}
                >
                  <SelectTrigger id={`quality-${id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_QUALITIES.map((quality) => (
                      <SelectItem key={quality} value={quality}>
                        {quality === "medium" ? "medium（中）" : "high（高）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              付费操作：按现有生图/编辑规则扣积分，每次仅运行此节点、生成 1 张。
            </p>
            <Button
              className="w-full"
              disabled={busy || waiting}
              onClick={() => ui.requestRun(id)}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {busy
                ? "处理中，请勿重复提交"
                : waiting
                  ? "上次任务待历史确认"
                  : "运行此节点"}
            </Button>
            {busy && (
              <p role="status" className="text-xs text-muted-foreground">
                正在准备或等待结果。此节点暂不能删除；切换 Tab /
                离开会断开请求，已提交任务可能继续执行并扣积分。
              </p>
            )}
            {waiting && (
              <div className="space-y-2 rounded border border-amber-500/50 bg-amber-500/5 p-3 text-xs">
                <p>
                  上次请求的结果尚未确认，任务可能仍在执行。请先核对历史，避免再次扣费。
                </p>
                <Link
                  href="/dashboard/history"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  打开历史记录核对
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => ui.chooseImage(id, true)}
                >
                  从近期作品选回结果
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={() => ui.acknowledge(id)}
                >
                  我已核对历史，解锁新任务
                </Button>
              </div>
            )}
            {data.attempt && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>任务编号（可在历史核对）</p>
                <code className="block select-text break-all">
                  {data.attempt.generationId}
                </code>
                <Link
                  href="/dashboard/history"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  查看历史记录
                </Link>
              </div>
            )}
            {data.result && (
              <>
                <WorkflowPreview image={data.result} />
                <p className="text-xs text-muted-foreground">
                  结果可从右侧图片端口连接到下一个生成节点。
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={ui.transferring.has(id)}
                  onClick={() => {
                    if (data.result) ui.continueEditing(id, data.result);
                  }}
                >
                  {ui.transferring.has(id) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  继续编辑这张图
                </Button>
              </>
            )}
          </>
        )}
        {ui.errors[id] && (
          <p role="alert" className="break-words text-xs text-destructive">
            {ui.errors[id]}
          </p>
        )}
      </div>
      {data.kind === "generate" && (
        <>
          <Handle
            type="target"
            id="prompt"
            position={Position.Left}
            style={{ top: 72, width: 12, height: 12, background: "#8b5cf6" }}
            isConnectable={!busy}
            aria-label="提示词输入"
          />
          <span className="pointer-events-none absolute -left-2 top-[84px] rounded bg-background px-1 text-[10px] text-muted-foreground">
            提示词
          </span>
          <Handle
            type="target"
            id="image"
            position={Position.Left}
            style={{ top: 118, width: 12, height: 12, background: "#0d9488" }}
            isConnectable={!busy}
            aria-label="参考图输入"
          />
          <span className="pointer-events-none absolute -left-2 top-[130px] rounded bg-background px-1 text-[10px] text-muted-foreground">
            图片
          </span>
        </>
      )}
      <Handle
        type="source"
        id={data.kind === "prompt" ? "prompt" : "image"}
        position={Position.Right}
        style={{
          top: data.kind === "prompt" ? 72 : 118,
          width: 12,
          height: 12,
          background: data.kind === "prompt" ? "#8b5cf6" : "#0d9488",
        }}
        isConnectable={!busy}
        aria-label={data.kind === "prompt" ? "提示词输出" : "图片输出"}
      />
    </section>
  );
}
