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
  type: "api" | "account" | "adobe";
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
  useStream?: boolean;
  contentSafetyEnabled?: boolean;
  headers?: Record<string, string>;
  backend?: {
    type: "platform" | "pool-api" | "pool-account" | "pool-adobe" | "user-api";
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
    // pool-api 专属：该 api 后端上游实为 Adobe（adobe-sourced）。为真时计费吃成员倍率
    // （见 service.ts），且 firefly-* 请求经反向转换（截家族名 + 推 size）后由本后端服务。
    adobeSourced?: boolean;
    // 本次请求是否为 firefly 意图（firefly-* 模型或 force_firefly）。解析时按请求口径盖在
    // config 上，使后端失败换号重试能保持「只走 Adobe（pool-adobe / adobe_sourced api）」，
    // 避免 firefly/按-Adobe-计费 的请求被重试到非 Adobe 后端（计费/产物错配）。
    fireflyOnly?: boolean;
    // adobe（pool-adobe）专属：暴露的 Firefly 模型家族、默认宽高比/分辨率、是否支持
    // 视频。供 image-generation 派发 adobe 请求时选择 family 与映射缺省值。
    // gateway：调外部 adobe2api；direct：本仓库直连 Firefly（adobe_account/token + 旁路）。
    adobeMode?: "gateway" | "direct";
    adobeEnabledModels?: string[] | null;
    adobeDefaultRatio?: string;
    adobeDefaultResolution?: string;
    adobeSupportsVideo?: boolean;
    // gpt-image 质量(系统级,low/medium/high → detailLevel 1/3/5);缺省走 high。
    adobeGptImageQuality?: string;
    billingGroupId?: string | null;
    billingMultiplier?: number;
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
