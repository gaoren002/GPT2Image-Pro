/**
 * 聊天消息模型共享类型。
 *
 * 职责:ChatMessage / ChatVariant / 会话等类型此前内联在 create-page-client
 * (1 万行组件)里;聊天叶子组件(chat-subscriptions 等)拆出后需要跨文件
 * 引用,抽到本模块。create-page-client 改为从这里 re-export,业务语义不变。
 */

import type { AgentRunEvent } from "../types";

export type ConversationMode = "chat" | "agent" | "web";

export type ChatGptWebConversationState = {
  conversationId: string;
  parentMessageId: string;
  accountId?: string;
  apiKeyId?: string;
  selectionMessageId?: string;
  selectedImageMessageId?: string;
};

export type StickyBackendMemberState = {
  type: "api" | "account";
  id: string;
  groupId?: string | null;
  accountBackend?: "web" | "responses";
};

export type ResponsesPreviousResponseState = {
  responseId: string;
  backendMember: StickyBackendMemberState;
  store: true;
  createdAt?: string;
};

export type ChatAttachmentPreview = {
  id: string;
  name: string;
  previewUrl?: string;
  kind?: "image" | "file";
};

export type ChatVariant = {
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

export type ChatMessage = {
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

export type ChatConversation = {
  id: string;
  mode: ConversationMode;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type BatchCard = {
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
