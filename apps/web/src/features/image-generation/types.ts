export interface GenerateImageParams {
  prompt: string;
  apiPrompt?: string;
  promptOptimization?: boolean;
  signal?: AbortSignal;
  moderationBlockRiskLevel?: ModerationBlockRiskLevel;
  size?: string;
  width?: number;
  height?: number;
  model?: string;
  gptModel?: string;
  /** 服务端套餐快照授予的旗舰文本模型权限，不从客户端请求读取。 */
  allowPremiumModels?: boolean;
  thinking?: ThinkingLevel;
  n?: number;
  quality?: ImageQuality;
  moderation?: ImageModeration;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  background?: ImageBackground;
  mixWebFirst?: boolean;
  forceWebBackend?: boolean;
  requiresResponsesBackend?: boolean;
  /** 透明背景抠图回退(显式开关,issue #27):仅 true 且 background=transparent 时,后端不支持
   * 透明则"不透明重生成 + 服务端 ISNet 抠图"得到透明结果;不开则透明直接透传、不支持即返回真实错误。 */
  transparentMatte?: boolean;
  /** 审核改写重试:显式 false 时本次失败不自动改写提示词重试,直接返回真实错误(issue #24)。 */
  moderationPromptRepair?: boolean;
  /** 高清修复:true 时对最终图用 SCUNet 盲复原(去噪/去压缩块/增强质感,不改分辨率);仅在主开关
   *  IMAGE_RESTORATION_ENABLED 开时生效,默认关(见 operations.ts / image-restoration.ts)。 */
  hdRepair?: boolean;
}

export interface GenerateImageResult {
  /** 服务端最终成功成员的计价白名单；不得包含配置、凭据或租约。 */
  billingSnapshot?: ImageGenerationBillingSnapshot;
  imageBase64?: string;
  imageUrl?: string;
  imageOutputs?: GeneratedImageOutput[];
  imageOutputCount?: number;
  generationId?: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  promptRepairNotice?: string;
  responseText?: string;
  model?: string;
  responseThinking?: string;
  responseAgent?: string;
  agentEvents?: AgentRunEvent[];
  agentRoundCount?: number;
  /** 是否为"生成即分层"产物(可导出分层 PSD)。 */
  layered?: boolean;
  webConversation?: ChatGptWebConversationState;
  backendMember?: StickyBackendMemberState;
  responsesPreviousResponse?: ResponsesPreviousResponseState;
  responsesUsage?: ResponsesTokenUsage;
  partialAgentError?: string;
  error?: string;
  upstreamResetAt?: string;
  retryAfterSeconds?: number;
  backendAttempts?: BackendAttemptDiagnostic[];
}

/** 仅保留结算与对账必要的标量，不能扩展为整个 backend/config 的副本。 */
export interface ImageGenerationBillingSnapshot {
  backendType: NonNullable<ApiConfig["backend"]>["type"] | null;
  backendId: string | null;
  groupId: string | null;
  billingGroupId: string | null;
  accountBackend: "web" | "responses" | null;
  /** 入口收到的请求质量，保留原始审计口径。 */
  requestedQuality: string | null;
  /** 计价质量：原请求质量，或 raw Responses 用户显式填写的工具质量；不取 mapping 改写值。 */
  billingQuality: string | null;
  outboundModel: string;
  /** 实际出站质量，仅记录路由结果，不改变质量计价规则。 */
  outboundQuality: string | null;
  backendBillingMultiplier: number;
  poolApiModelBillingMultiplier: number;
  qualityBillingMultiplier: number;
  poolApiModelBillingReplacesQuality: boolean;
  billingMultiplier: number;
}

export interface BackendAttemptDiagnostic {
  attempt: number;
  backendType?: string;
  backendId?: string;
  accountBackend?: string;
  durationMs: number;
  error?: string;
}

export interface ResponsesTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface GeneratedImageOutput {
  imageBase64?: string;
  imageUrl?: string;
  imageFileId?: string;
  webImageMessageId?: string;
  webImageGroupId?: string;
  generationId?: string;
  size?: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  promptRepairNotice?: string;
  index?: number;
  outputRole?: "final" | "agent_draft" | "choice";
}

export interface PartialImageResult {
  imageBase64?: string;
  imageUrl?: string;
  index?: number;
  partialImageIndex?: number;
  final?: boolean;
}

export type AgentRunEventKind =
  | "message"
  | "reasoning"
  | "web_search"
  | "code_interpreter"
  | "image_generation"
  | "image_partial"
  | "tool";

export type AgentRunEventStatus =
  | "started"
  | "running"
  | "completed"
  | "failed";

export interface AgentRunEvent {
  id?: string;
  kind: AgentRunEventKind;
  status?: AgentRunEventStatus;
  title: string;
  detail?: string;
  imageBase64?: string;
  imageUrl?: string;
  index?: number;
  partialImageIndex?: number;
  timestamp?: string;
  toolType?: string;
}

export interface ImageGenerationCallbacks {
  onPartialImage?: (image: PartialImageResult) => Promise<void> | void;
  onTextDelta?: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onAgentDelta?: (delta: string) => Promise<void> | void;
  onAgentEvent?: (event: AgentRunEvent) => Promise<void> | void;
}

export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type ImageModeration = "auto" | "low";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "transparent" | "opaque" | "auto";
export type ModerationBlockRiskLevel = "low" | "medium" | "high";

export interface ImageInputFile {
  data: Buffer;
  name: string;
  type: string;
  url?: string;
  storageBucket?: string;
  storageKey?: string;
  imageFileId?: string;
}

export interface ResponsesInputFile {
  data: Buffer;
  name: string;
  type: string;
  url?: string;
  fileId?: string;
}

export type ThinkingLevel =
  | "minimal"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface EditImageParams {
  prompt: string;
  apiPrompt?: string;
  promptOptimization?: boolean;
  signal?: AbortSignal;
  moderationBlockRiskLevel?: ModerationBlockRiskLevel;
  images: ImageInputFile[];
  mask?: ImageInputFile;
  size?: string;
  model?: string;
  gptModel?: string;
  /** 服务端套餐快照授予的旗舰文本模型权限，不从客户端请求读取。 */
  allowPremiumModels?: boolean;
  thinking?: ThinkingLevel;
  quality?: ImageQuality;
  n?: number;
  moderation?: ImageModeration;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  background?: ImageBackground;
  mixWebFirst?: boolean;
  forceWebBackend?: boolean;
  requiresResponsesBackend?: boolean;
  /** 透明背景抠图回退(显式开关,issue #27):仅 true 且 background=transparent 时,后端不支持
   * 透明则"不透明重生成 + 服务端 ISNet 抠图"得到透明结果;不开则透明直接透传、不支持即返回真实错误。 */
  transparentMatte?: boolean;
  /** 审核改写重试:显式 false 时本次失败不自动改写提示词重试,直接返回真实错误(issue #24)。 */
  moderationPromptRepair?: boolean;
  /** 高清修复:true 时对最终图用 SCUNet 盲复原(去噪/去压缩块/增强质感,不改分辨率);仅在主开关
   *  IMAGE_RESTORATION_ENABLED 开时生效,默认关(见 operations.ts / image-restoration.ts)。 */
  hdRepair?: boolean;
}

export interface ChatImageParams {
  prompt: string;
  apiPrompt?: string;
  fileContext?: string;
  files?: ResponsesInputFile[];
  promptOptimization?: boolean;
  signal?: AbortSignal;
  moderationBlockRiskLevel?: ModerationBlockRiskLevel;
  images?: ImageInputFile[];
  history?: ChatHistoryMessage[];
  size?: string;
  model?: string;
  imageModel?: string;
  allowPremiumModels?: boolean;
  quality?: ImageQuality;
  n?: number;
  moderation?: ImageModeration;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  background?: ImageBackground;
  stream?: boolean;
  thinking?: ThinkingLevel;
  agentMode?: boolean;
  agentMaxRounds?: number;
  agentForceMaxRounds?: boolean;
  /** 分层生成("生成即分层"):agent 先出整图、再逐层生成。仅 agentMode 下有效。 */
  layeredGeneration?: boolean;
  waterfallMode?: boolean;
  rawResponsesBody?: unknown;
  rawChatCompletionsBody?: unknown;
  chatCompletionsUpstreamMode?: "responses" | "chat_completions" | "images";
  mixWebFirst?: boolean;
  requiresResponsesBackend?: boolean;
  /** 网页对话轮次(chat(web) tab):强制 web 后端且走 text-capable 路径——回文字、按需出图,
   *  而非图像路径的强制出图。仅 chat 模式 + web 池后端下生效(见 service.generateChatImage)。 */
  webChat?: boolean;
  /** 透明背景抠图回退(显式开关,issue #27):仅 true 且 background=transparent 时,后端不支持
   * 透明则"不透明重生成 + 服务端 ISNet 抠图"得到透明结果;不开则透明直接透传、不支持即返回真实错误。 */
  transparentMatte?: boolean;
  /** 审核改写重试:显式 false 时本次失败不自动改写提示词重试,直接返回真实错误(issue #24)。 */
  moderationPromptRepair?: boolean;
  /** 高清修复:true 时对最终图用 SCUNet 盲复原(去噪/去压缩块/增强质感,不改分辨率);仅在主开关
   *  IMAGE_RESTORATION_ENABLED 开时生效,默认关(见 operations.ts / image-restoration.ts)。 */
  hdRepair?: boolean;
}

export interface ChatGptWebConversationState {
  conversationId: string;
  parentMessageId: string;
  accountId?: string;
  apiKeyId?: string;
  selectionMessageId?: string;
  selectedImageMessageId?: string;
}

export interface StickyBackendMemberState {
  type: "api" | "account";
  id: string;
  groupId?: string | null;
  accountBackend?: "web" | "responses";
}

export interface ResponsesPreviousResponseState {
  responseId: string;
  backendMember: StickyBackendMemberState;
  store: true;
  createdAt?: string;
}

export interface ChatHistoryVariant {
  text?: string;
  imageUrl?: string;
  imageFileId?: string;
  webImageMessageId?: string;
  webImageGroupId?: string;
  size?: string;
  timestamp?: string;
  webConversation?: ChatGptWebConversationState;
  backendMember?: StickyBackendMemberState;
  responsesPreviousResponse?: ResponsesPreviousResponseState;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  text?: string;
  imageUrls?: string[];
  variants?: ChatHistoryVariant[];
  activeVariant?: number;
  error?: string;
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  model?: string;
  /** 本站型号 → 上游型号；派发前改写出站 model/quality。 */
  modelMapping?: Array<{
    from: string;
    to: string;
    whenQuality?: string;
    setQuality?: string;
  }>;
  useStream?: boolean;
  contentSafetyEnabled?: boolean;
  headers?: Record<string, string>;
  backend?: {
    type: "platform" | "pool-api" | "pool-account" | "user-api";
    id?: string;
    groupId?: string | null;
    // 解析到的【目标分组】backendType。供换号重试循环判定是否为混合分组——web→codex
    // 回退仅在 mixed 分组生效(纯 web / 纯 codex 分组各自闭环,不跨车道回退)。
    groupBackendType?: "web" | "responses" | "mixed";
    userId?: string;
    apiKeyId?: string;
    requestKind?: "image_generation" | "image_edit" | "chat" | "responses";
    accountBackend?: "web" | "responses";
    apiInterfaceMode?: "images" | "responses" | "mixed";
    chatCompletionsUpstreamMode?: "responses" | "chat_completions" | "images";
    imagesUpstreamMode?: "images" | "responses";
    apiForceResponsesEndpoint?: boolean;
    // 池 API 尺寸方言（metadata.sizeDialect）：上游对 size 参数的兼容形态。
    // - 不设/"wxh"：WIDTHxHEIGHT 原样直传（默认，兼容绝大多数上游）。
    // - "exact-ratio"：上游只接受能整除出精确比例的 WxH（如 suduma gzs）；
    //   出站前把任意 WxH 吸附到最近的精确比例栅格。
    // - "ratio-string"：上游只认比例串（如 "3:2"）；预设档位请求改发比例串，
    //   自定义尺寸仍发 WxH（无法精确表达时按上游能力取舍）。
    sizeDialect?: "wxh" | "exact-ratio" | "ratio-string";
    // 池 API 异步任务模式（metadata.asyncTaskMode，兼容速度马）：images 接口受理后只回
    // 任务号时，轮询 GET {baseUrl}/tasks/{id} 取图，不发 stream。见 upstream-async-task.ts。
    asyncTaskMode?: boolean;
    billingGroupId?: string | null;
    billingMultiplier?: number;
    // 池 API / 池账号成员的质量计价倍率表（quality → 倍率，DB json 原样）。
    // 解析与回退规则见 quality-billing.ts；预扣与成功结算均按请求质量，mapping 不回灌计价。
    qualityBilling?: Partial<Record<string, number>> | null;
    // 池 API 按模型计价倍率表（出站模型 id → 统一倍率或质量分档表，精确命中）；
    // 仅 pool-api 读取。来源是成员 metadata.modelBilling，解析见 model-billing.ts。
    modelBilling?: Record<
      string,
      number | Partial<Record<string, number>>
    > | null;
    // 池成员调度优先级(越小越先)。换号预算按同优先级计数,耗尽后跳到更高数值的下一档。
    priority?: number;
    reportResult?: boolean;
    inflightLease?: boolean;
    inflightLeaseId?: string | null;
    inflightLeasePersisted?: boolean;
  };
}

export interface GenerationRecord {
  id: string;
  prompt: string;
  revisedPrompt: string | null;
  model: string;
  size: string;
  status: "pending" | "completed" | "failed";
  imageUrl: string | null;
  creditsConsumed: number;
  createdAt: Date;
}
