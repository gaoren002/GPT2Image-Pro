"use client";

/**
 * 对话面板(独立组件,从 create-page-client 拆出)。
 *
 * 职责:chat/agent/chat-web 三种对话模式容器(头部操作、消息流、输入区)。
 * 面板内订阅 activeMode/chatAttachments/isChatGenerating/retryingChatMessageId;
 * 消息流与流式气泡已由 ChatMessageList/ChatPanelStreamGate/ChatStreamBubble
 * 叶子组件订阅。切 tab 时 props 稳定,只更新 hidden。
 *
 * 约束:传入的 handler 与渲染回调必须是稳定引用。
 */

import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";
import { Button } from "@repo/ui/components/button";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { DEFAULT_IMAGE_SIZE, parseImageSize } from "../resolution";

const defaultDimensions = parseImageSize(DEFAULT_IMAGE_SIZE) || {
  width: 1024,
  height: 1024,
};

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  useCreateRuntimeAccessor,
  useCreateRuntimeState,
} from "@/features/image-generation/create-runtime-store";
import type { ChatMessage, ChatVariant } from "./chat-message-types";
import { ChatMessageList, ChatPanelStreamGate } from "./chat-subscriptions";

const shouldBypassImageOptimization = (imageUrl: string | undefined) =>
  Boolean(imageUrl);

function getChatVariants(message: ChatMessage): ChatVariant[] {
  return message.variants || [];
}

function getActiveChatVariant(message: ChatMessage): ChatVariant | null {
  const variants = getChatVariants(message);
  return variants[message.activeVariant || 0] || null;
}

const thumbSrc = (imageUrl: string | null | undefined, width: number): string =>
  buildStorageThumbnailUrl(imageUrl, width) || imageUrl || "";

export function ChatPanel({
  activeConversationExists,
  attachResultToChat,
  chatMessagesRef,
  clearChatAttachments,
  currentModeConversations,
  handleChatRetry,
  handleChatVariantChange,
  handleChatVariantSelect,
  handleClearChatHistory,
  handleNewChat,
  handleOpenChatConversation,
  renderAgentRoundCards,
  renderChatInput,
  renderChatStreamBubble,
  renderThinkingBlock,
  activeConversationMode,
  isMessageInConversationMode,
}: {
  activeConversationExists: boolean;
  attachResultToChat: (
    variant?: import("./chat-message-types").ChatVariant
  ) => Promise<void> | void;
  chatMessagesRef: React.RefObject<HTMLDivElement | null>;
  clearChatAttachments: () => void;
  currentModeConversations: import("./chat-message-types").ChatConversation[];
  handleChatRetry: (assistantId: string) => void;
  handleChatVariantChange: (messageId: string, direction: -1 | 1) => void;
  handleChatVariantSelect: (messageId: string, nextIndex: number) => void;
  handleClearChatHistory: () => void;
  handleNewChat: () => void;
  handleOpenChatConversation: (
    conversation: import("./chat-message-types").ChatConversation
  ) => void;
  renderAgentRoundCards: (
    events?: import("../types").AgentRunEvent[],
    fallbackAgent?: string,
    open?: boolean
  ) => React.ReactNode;
  renderChatInput: () => React.ReactNode;
  renderChatStreamBubble: (messageId?: string) => React.ReactNode;
  renderThinkingBlock: (thinking?: string, open?: boolean) => React.ReactNode;
  activeConversationMode: "chat" | "agent" | "web";
  isMessageInConversationMode: (
    message: import("./chat-message-types").ChatMessage,
    mode: import("./chat-message-types").ConversationMode
  ) => boolean;
}) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [activeMode] = useCreateRuntimeState<string>("activeMode", "text");
  type ChatAttachmentItem = {
    id: string;
    kind: "image" | "file";
    file: File;
    previewUrl?: string;
  };
  const [chatAttachments] = useCreateRuntimeState<ChatAttachmentItem[]>(
    "chatAttachments",
    []
  );
  const [isChatGenerating] = useCreateRuntimeState("isChatGenerating", false);
  const [retryingChatMessageId] = useCreateRuntimeState<string | null>(
    "retryingChatMessageId",
    null
  );
  const [chatConversationId] = useCreateRuntimeState<string>(
    "chatConversationId",
    () => `chat-${Date.now().toString(36)}`
  );
  const [, setSelectedRecentId] = useCreateRuntimeState<string | null>(
    "selectedRecentId",
    null
  );
  // 面板内读取最新消息(附件按钮清空条件的空态判断等低频读点)。
  const [getChatMessages] = useCreateRuntimeAccessor<ChatMessage[]>(
    "chatMessages",
    []
  );

  return (
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
                <SelectValue placeholder={copy("Chat history", "历史对话")} />
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
              disabled={isChatGenerating || getChatMessages().length === 0}
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
            <ChatMessageList
              activeConversationMode={activeConversationMode}
              isConversationModeMatch={isMessageInConversationMode}
              renderList={(visibleChatMessages, chatStreamMessageId) => (
                <>
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
                          chatStreamMessageId === message.id;
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
                                        {message.attachments.map(
                                          (attachment) => (
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
                                          )
                                        )}
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
                                                ?.width ||
                                              defaultDimensions.width
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
                                          <span className="absolute right-2 top-2 rounded-sm bg-background/90 px-2 py-1 text-[11px] font-medium text-foreground opacity-0 shadow-whisper transition-opacity group-hover:opacity-100">
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
                                          handleChatVariantChange(
                                            message.id,
                                            -1
                                          )
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
                                        title={copy(
                                          "Next variant",
                                          "下一个版本"
                                        )}
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
                                              src={thumbSrc(
                                                variant.imageUrl,
                                                256
                                              )}
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
                </>
              )}
            />
            <ChatPanelStreamGate
              activeConversationMode={activeConversationMode}
              renderBubble={renderChatStreamBubble}
              retryingChatMessageId={retryingChatMessageId}
            />
          </div>

          {renderChatInput()}
        </div>
      </div>
    </div>
  );
}
