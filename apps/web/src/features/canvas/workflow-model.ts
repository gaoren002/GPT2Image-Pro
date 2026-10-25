/** 工作流的有界 JSON 模型、连线校验与单节点运行计划；供编辑器和无数据库测试共用。 */
import { z } from "zod";

export const MAX_WORKFLOW_NODES = 100;
export const MAX_WORKFLOW_EDGES = 300;
export const MAX_WORKFLOW_BYTES = 4 * 1024 * 1024;
export const MAX_WORKFLOW_IMAGES = 8;
export const MAX_WORKFLOW_PROMPT = 32_000;
export const WORKFLOW_MODELS = ["gpt-image-2.5", "gpt-image-2"] as const;
export const WORKFLOW_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
export const WORKFLOW_QUALITIES = ["medium", "high"] as const;

/** 只接受本站存储相对地址；拒绝 URL 归一化、转义分隔符与路径穿越绕过。 */
export function isWorkflowImageUrl(value: string): boolean {
  if (value.length > 4096 || !value.startsWith("/api/storage/")) return false;
  if (/[\\\s#]/.test(value) || hasControlCharacter(value)) return false;
  try {
    const url = new URL(value, "https://workflow.invalid");
    const rawPath = value.split("?", 1)[0];
    if (url.origin !== "https://workflow.invalid" || url.pathname !== rawPath)
      return false;
    const segments = url.pathname.slice("/api/storage/".length).split("/");
    return (
      segments.length >= 2 &&
      segments.every((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          Boolean(decoded) &&
          decoded !== "." &&
          decoded !== ".." &&
          !/[\\/%]/.test(decoded) &&
          !hasControlCharacter(decoded)
        );
      })
    );
  } catch {
    return false;
  }
}

/** URL 的原始字符和解码后路径都不能含控制字符，避免浏览器规范化后改变请求目标。 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const imageUrlSchema = z
  .string()
  .refine(isWorkflowImageUrl, "只允许本站 /api/storage/ 图片");
export const workflowImageSchema = z.object({
  id: idSchema,
  prompt: z.string().max(MAX_WORKFLOW_PROMPT),
  url: imageUrlSchema,
  thumbnailUrl: imageUrlSchema,
});
const attemptSchema = z.object({
  generationId: z.uuid(),
  state: z.enum(["unconfirmed", "completed", "acknowledged"]),
  startedAt: z.iso.datetime(),
});
const dataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    text: z.string().max(MAX_WORKFLOW_PROMPT),
  }),
  z.object({ kind: z.literal("image"), image: workflowImageSchema.optional() }),
  z.object({
    kind: z.literal("generate"),
    model: z.enum(WORKFLOW_MODELS),
    size: z.enum(WORKFLOW_SIZES),
    quality: z.enum(WORKFLOW_QUALITIES),
    result: workflowImageSchema.optional(),
    attempt: attemptSchema.optional(),
  }),
]);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const nodeSchema = z.object({
  id: idSchema,
  type: z.literal("workflow"),
  position: z.object({ x: coordinate, y: coordinate }),
  data: dataSchema,
});
const edgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  sourceHandle: z.enum(["prompt", "image"]),
  targetHandle: z.enum(["prompt", "image"]),
});
const documentSchema = z.object({
  type: z.literal("gpt2image-workflow"),
  version: z.literal(1),
  nodes: z.array(nodeSchema).max(MAX_WORKFLOW_NODES),
  edges: z.array(edgeSchema).max(MAX_WORKFLOW_EDGES),
  viewport: z
    .object({ x: coordinate, y: coordinate, zoom: z.number().min(0.1).max(2) })
    .optional(),
});

export type WorkflowDocument = z.infer<typeof documentSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowData = WorkflowNode["data"];
export type WorkflowImage = z.infer<typeof workflowImageSchema>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export type WorkflowConnection = Pick<WorkflowEdge, "source" | "target"> & {
  sourceHandle?: string | null;
  targetHandle?: string | null;
};
export type WorkflowRunPlan = {
  nodeId: string;
  prompt: string;
  model: (typeof WORKFLOW_MODELS)[number];
  size: (typeof WORKFLOW_SIZES)[number];
  quality: (typeof WORKFLOW_QUALITIES)[number];
  images: WorkflowImage[];
};

/** 检查单条候选边；返回中文失败原因，不修改图，使用迭代遍历避免深图递归溢出。 */
export function workflowConnectionError(
  document: Pick<WorkflowDocument, "nodes" | "edges">,
  connection: WorkflowConnection
): string | null {
  if (document.edges.length >= MAX_WORKFLOW_EDGES) return "连线数量已达上限";
  const source = document.nodes.find((node) => node.id === connection.source);
  const target = document.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return "连线节点不存在";
  if (source.id === target.id) return "节点不能连接自身";
  if (target.data.kind !== "generate") return "只能连接到生成节点";
  const handle = source.data.kind === "prompt" ? "prompt" : "image";
  if (
    connection.sourceHandle !== handle ||
    connection.targetHandle !== handle
  ) {
    return "提示词只能接提示词输入，图片只能接图片输入";
  }
  const incoming = document.edges.filter((edge) => edge.target === target.id);
  if (
    incoming.some(
      (edge) => edge.source === source.id && edge.targetHandle === handle
    )
  )
    return "这两个端口已经连接";
  if (
    handle === "prompt" &&
    incoming.some((edge) => edge.targetHandle === "prompt")
  )
    return "每个生成节点只能连接一个提示词";
  if (
    handle === "image" &&
    incoming.filter((edge) => edge.targetHandle === "image").length >=
      MAX_WORKFLOW_IMAGES
  )
    return `最多连接 ${MAX_WORKFLOW_IMAGES} 张参考图`;
  const pending = [target.id];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === source.id) return "不能创建循环连线";
    visited.add(current);
    for (const edge of document.edges) {
      if (edge.source === current) pending.push(edge.target);
    }
  }
  return null;
}

/** 校验并白名单投影 JSON；函数、React Flow 选择态和运行态不会进入返回值。 */
export function parseWorkflowDocument(input: unknown): WorkflowDocument {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `工作流格式无效：${parsed.error.issues[0]?.message ?? "字段错误"}`
    );
  const document = parsed.data;
  if (
    new Set(document.nodes.map((node) => node.id)).size !==
    document.nodes.length
  )
    throw new Error("节点 ID 重复");
  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) throw new Error("连线 ID 重复");
    const error = workflowConnectionError(
      { nodes: document.nodes, edges },
      edge
    );
    if (error) throw new Error(error);
    edgeIds.add(edge.id);
    edges.push(edge);
  }
  for (const node of document.nodes) {
    if (node.data.kind !== "generate") continue;
    if (node.data.result && node.data.attempt?.state !== "completed")
      throw new Error("生成结果缺少已完成任务记录");
    if (node.data.attempt?.state === "completed" && !node.data.result)
      throw new Error("已完成任务缺少图片结果");
  }
  return document;
}

/** 文件与 IDB 使用同一入口；先限制字符及 UTF-8 字节，再解析，坏文件由调用方保留旧图。 */
export function loadWorkflowDocument(json: string): WorkflowDocument {
  if (
    json.length > MAX_WORKFLOW_BYTES ||
    new TextEncoder().encode(json).byteLength > MAX_WORKFLOW_BYTES
  )
    throw new Error("工作流文件超过 4 MiB");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("工作流不是有效的 JSON 文件");
  }
  return parseWorkflowDocument(value);
}

/** 先白名单投影再序列化；不依赖 JSON.stringify 忽略函数，循环的未知扩展字段也会被丢弃。 */
export function serializeWorkflowDocument(document: unknown): string {
  const serialized = JSON.stringify(parseWorkflowDocument(document));
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKFLOW_BYTES)
    throw new Error("工作流超过 4 MiB，无法保存");
  return serialized;
}

/** 初次打开提供可编辑示例；只建立提示词输入，不执行任何付费操作。 */
export function createWorkflowDocument(): WorkflowDocument {
  return {
    type: "gpt2image-workflow",
    version: 1,
    nodes: [
      {
        id: "prompt-start",
        type: "workflow",
        position: { x: 40, y: 100 },
        data: { kind: "prompt", text: "" },
      },
      {
        id: "generate-start",
        type: "workflow",
        position: { x: 440, y: 100 },
        data: {
          kind: "generate",
          model: "gpt-image-2.5",
          size: "1024x1024",
          quality: "medium",
        },
      },
    ],
    edges: [
      {
        id: "prompt-to-generate",
        source: "prompt-start",
        target: "generate-start",
        sourceHandle: "prompt",
        targetHandle: "prompt",
      },
    ],
  };
}

/** 只解析点击节点的直接输入；上游缺结果或仍在运行时失败，绝不自动运行依赖。 */
export function buildWorkflowRunPlan(
  input: WorkflowDocument,
  nodeId: string,
  running: ReadonlySet<string> = new Set()
): WorkflowRunPlan {
  const document = parseWorkflowDocument(input);
  const node = document.nodes.find((item) => item.id === nodeId);
  if (node?.data.kind !== "generate") throw new Error("请选择生成节点");
  if (running.has(nodeId)) throw new Error("此节点正在运行，请勿重复提交");
  if (node.data.attempt?.state === "unconfirmed")
    throw new Error("上次任务尚未确认，请先去历史记录核对");
  const incoming = document.edges.filter((edge) => edge.target === nodeId);
  const promptEdge = incoming.find((edge) => edge.targetHandle === "prompt");
  const promptNode = document.nodes.find(
    (item) => item.id === promptEdge?.source
  );
  const prompt =
    promptNode?.data.kind === "prompt" ? promptNode.data.text.trim() : "";
  if (!prompt) throw new Error("请连接提示词节点并填写内容");
  const images = incoming
    .filter((edge) => edge.targetHandle === "image")
    .map((edge) => {
      const source = document.nodes.find((item) => item.id === edge.source);
      if (source?.data.kind === "image") {
        if (!source.data.image) throw new Error("请为参考图节点选择近期作品");
        return source.data.image;
      }
      if (source?.data.kind === "generate") {
        if (
          running.has(source.id) ||
          source.data.attempt?.state === "unconfirmed"
        )
          throw new Error("上游任务尚未完成，请先确认上游结果");
        if (!source.data.result)
          throw new Error("上游生成节点没有结果，请先运行上游节点");
        return source.data.result;
      }
      throw new Error("图片输入无效");
    });
  return {
    nodeId,
    prompt,
    images,
    model: node.data.model,
    size: node.data.size,
    quality: node.data.quality,
  };
}
