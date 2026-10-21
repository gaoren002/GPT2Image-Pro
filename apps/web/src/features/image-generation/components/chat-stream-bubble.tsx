"use client";

/**
 * 聊天流式气泡(叶子订阅组件)。
 *
 * 职责:订阅运行时 store 的 chatStream,把流式期间逐帧变化的展示(思考块、
 * Agent 过程卡片、正文、部分图预览、等待态)限制在本组件内重渲。此前
 * create-page-client 父组件直接订阅 chatStream,流式期间每帧触发 1 万行
 * 组件全量重渲,是"生成时越来越卡"的主因之一。
 *
 * 使用方:create-page-client(chat 面板消息流内联流式气泡,与面板级
 * 无 messageId 的流式占位)。父组件传 renderThinkingBlock/renderAgentRoundCards
 * 之类的渲染回调时必须传稳定引用(父组件内用 useCallback 固定),否则本
 * 组件会随父组件重渲而失去隔离效果。
 */

import { Loader2 } from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import type { AgentRunEvent } from "../types";
import type { ChatStreamState } from "./chat-stream-state";

const shouldBypassImageOptimization = (imageUrl: string | undefined) =>
  Boolean(imageUrl);

export function ChatStreamBubble({
  messageId,
  renderThinkingBlock,
  renderAgentRoundCards,
}: {
  /** 匹配 chatStream.messageId;面板级占位(无消息 id 的流)传 undefined。 */
  messageId?: string;
  renderThinkingBlock: (thinking?: string, open?: boolean) => React.ReactNode;
  renderAgentRoundCards: (
    events?: AgentRunEvent[],
    fallbackAgent?: string,
    open?: boolean
  ) => React.ReactNode;
}) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [chatStream] = useCreateRuntimeState<ChatStreamState | null>(
    "chatStream",
    null
  );

  if (!chatStream || chatStream.messageId !== messageId) return null;
  const isAgentStream = chatStream.mode === "agent";
  const hasVisibleAgentProgress =
    isAgentStream && chatStream.agentEvents.length > 0;
  return (
    <div className="rounded-lg rounded-bl-[5px] border border-border bg-background px-3 py-3 text-sm text-foreground">
      {renderThinkingBlock(chatStream.thinking, true)}
      {hasVisibleAgentProgress
        ? renderAgentRoundCards(chatStream.agentEvents, chatStream.agent, true)
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
      {!chatStream.text && !chatStream.imageUrl && !hasVisibleAgentProgress && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {copy("Generating...", "生成中...")}
        </div>
      )}
    </div>
  );
}
