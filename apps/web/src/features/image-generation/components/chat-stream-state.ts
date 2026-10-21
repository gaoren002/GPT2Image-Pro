/**
 * 聊天流式状态类型。
 *
 * 职责:chatStream 运行时 store key 的值类型定义,供 create-page-client(写入方)
 * 与 chat-stream-bubble(订阅展示方)共享。此前类型内联在 create-page-client 里,
 * 叶子组件拆出后跨文件引用,抽到独立模块避免组件间互相 import。
 * AgentRunEvent 复用 features/image-generation/types.ts 的规范定义。
 */

import type { AgentRunEvent } from "../types";

export type ChatStreamState = {
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
