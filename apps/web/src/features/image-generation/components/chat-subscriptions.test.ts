// @vitest-environment jsdom

/** 实际 React effect 回归：去抖、关页和卸载均须尊重快照账号归属。 */
import { act, createElement, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateRuntimeProvider,
  useCreateRuntimeAccessor,
} from "../create-runtime-store";
import type {
  ChatConversation,
  ChatMessage,
  ConversationMode,
} from "./chat-message-types";
import { CHAT_PERSIST_DEBOUNCE_MS } from "./chat-persistence";
import { ChatPersistenceAgent } from "./chat-subscriptions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let updateMessages: Dispatch<SetStateAction<ChatMessage[]>>;
const scope = { userId: "user-a", active: true };
const refs = {
  didLoadChatRef: { current: true },
  chatMessagesConversationIdRef: { current: "chat-a" as string | null },
  chatMessagesModeRef: { current: "chat" as ConversationMode | null },
  chatConversationsRef: { current: [] as ChatConversation[] },
};
const setChatConversations = vi.fn();

/** 初始化真实 runtime store，让订阅组件运行真实 effect。 */
function Probe() {
  [, updateMessages] = useCreateRuntimeAccessor<ChatMessage[]>("chatMessages", [
    {
      id: "message-a",
      role: "user",
      text: "private-a",
      mode: "chat",
      createdAt: "2026-10-24T00:00:00Z",
    },
  ]);
  const props = {
    scope,
    chatConversationId: "chat-a",
    isZh: true,
    ...refs,
    setChatConversations,
  };
  return createElement(ChatPersistenceAgent, props);
}

/** 等待真实 effect 清理与定时器提交。 */
async function tick() {
  await act(async () => vi.advanceTimersByTime(CHAT_PERSIST_DEBOUNCE_MS));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  scope.active = true;
  refs.chatConversationsRef.current = [];
  refs.chatMessagesConversationIdRef.current = "chat-a";
  refs.chatMessagesModeRef.current = "chat";
  setChatConversations.mockReset();
  vi.mocked(toast.error).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(CreateRuntimeProvider, null, createElement(Probe))
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ChatPersistenceAgent 旧账号回调", () => {
  it("切账号后尚未到期的旧 debounce 不写盘或改内存列表", async () => {
    scope.active = false;
    await tick();
    expect(localStorage.length).toBe(0);
    expect(setChatConversations).not.toHaveBeenCalled();
  });

  it("切账号后的旧 unmount flush 不写盘", async () => {
    scope.active = false;
    await act(async () => root.unmount());
    expect(localStorage.length).toBe(0);
    expect(setChatConversations).not.toHaveBeenCalled();
  });

  it("切账号后的旧 beforeunload flush 不写盘", async () => {
    scope.active = false;
    window.dispatchEvent(new Event("beforeunload"));
    expect(localStorage.length).toBe(0);
    expect(setChatConversations).not.toHaveBeenCalled();
  });

  it("同一账号正常卸载仍冲刷去抖窗口内的消息", async () => {
    await act(async () => root.unmount());
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) || "")
      )
    ).toEqual(expect.arrayContaining([expect.stringContaining("private-a")]));
    expect(setChatConversations).toHaveBeenCalledOnce();
  });

  it("真实写盘失败会提示用户，但完整内存消息仍保留", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "QuotaExceededError");
    });
    await tick();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("未能保存"),
      { id: "chat-persistence-failure" }
    );
    expect(refs.chatConversationsRef.current[0]?.messages[0]?.text).toBe(
      "private-a"
    );
    expect(setChatConversations).toHaveBeenCalledOnce();
  });

  it("上传确认后同一事件内关页，旧去抖闭包须冲刷最新引用而不是旧消息", async () => {
    const reference =
      "/api/storage/generations/user-a/requests/input.png?sig=one&exp=1";
    await act(async () => {
      updateMessages((previous) =>
        previous.map((message) => ({
          ...message,
          attachments: [
            {
              id: "input",
              name: "reference.png",
              kind: "image",
              previewUrl: reference,
            },
          ],
        }))
      );
      // effect 尚未重建，必须由现有 beforeunload 回调读取最新 store。
      window.dispatchEvent(new Event("beforeunload"));
    });
    const values = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index) || "")
    );
    expect(values).toEqual(
      expect.arrayContaining([expect.stringContaining(reference)])
    );
  });

  it("4MB 输入仍等待上传确认时不误报最终保存失败，确认失败后须报告", async () => {
    await act(async () =>
      updateMessages((previous) => [
        ...previous.map((message) => ({
          ...message,
          attachments: [
            {
              id: "large",
              name: "large.png",
              kind: "image" as const,
              previewUrl: `data:image/png;base64,${"x".repeat(4 * 1024 * 1024)}`,
            },
          ],
        })),
        {
          id: "assistant",
          role: "assistant",
          text: "generating",
          mode: "chat",
          createdAt: "2026-10-24T00:00:00Z",
          variants: [
            {
              prompt: "edit",
              model: "gpt-image-2",
              size: "1024x1024",
              pending: true,
            },
          ],
        },
      ])
    );
    await tick();
    expect(toast.error).not.toHaveBeenCalled();
    await act(async () =>
      updateMessages((previous) =>
        previous.map((message) => ({
          ...message,
          variants: message.variants?.map((variant) => ({
            ...variant,
            pending: false,
          })),
        }))
      )
    );
    await tick();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("超过本地保存容量"),
      { id: "chat-persistence-failure" }
    );
    expect(
      refs.chatConversationsRef.current[0]?.messages[0]?.attachments?.[0]
        ?.previewUrl
    ).toMatch(/^data:image/);
  });
});
