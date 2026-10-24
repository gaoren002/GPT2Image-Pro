// @vitest-environment jsdom

/** 真实共享 runtime 下的账号切换、旧异步 setter、软导航与重新登录回归。 */
import { act, createElement, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateRuntimeProvider,
  useCreateRuntimeState,
} from "../create-runtime-store";
import type { ChatMessage } from "./chat-message-types";
import {
  type ChatStorageScope,
  revokeChatStorageScope,
} from "./chat-persistence";
import { ChatAccountBoundary, useChatScopeSetter } from "./chat-subscriptions";

let root: Root;
let container: HTMLDivElement;
let changeAccount: Dispatch<SetStateAction<string | null | undefined>>;
const accounts = new Map<
  string,
  {
    scope: ChatStorageScope;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  }
>();

/** 模拟侧栏发布的已确认会话，使用与生产完全相同的 runtime key。 */
function SessionControl() {
  [, changeAccount] = useCreateRuntimeState<string | null | undefined>(
    "chatAccountUserId",
    undefined
  );
  return null;
}

/** 消费真实共享消息状态，保留每次挂载的异步 setter 用于迟到回调。 */
function AccountProbe({ scope }: { scope: ChatStorageScope }) {
  const [messages, rawSetter] = useCreateRuntimeState<ChatMessage[]>(
    "chatMessages",
    []
  );
  const setMessages = useChatScopeSetter(scope, rawSetter);
  accounts.set(scope.userId, { scope, setMessages });
  return createElement(
    "span",
    null,
    `${scope.userId}:${messages.map((item) => item.text).join(",")}`
  );
}

/** 路由切换只卸载创作页，布局里的 provider 与身份保留。 */
function Layout({ showPage = true }: { showPage?: boolean }) {
  return createElement(
    CreateRuntimeProvider,
    null,
    createElement(SessionControl),
    showPage
      ? createElement(ChatAccountBoundary, {
          renderAccount: (scope) =>
            createElement(AccountProbe, { key: scope.userId, scope }),
        })
      : null
  );
}

/** 正常消息样本，不借助持久化副作用修改共享 store。 */
function message(text: string): ChatMessage {
  return { id: text, text, role: "user", createdAt: "2026-10-24T00:00:00Z" };
}

/** 更新已确认账号并等待边界完成清理和重新挂载。 */
async function switchAccount(userId: string | null) {
  await act(async () => changeAccount(userId));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  accounts.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Layout)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ChatAccountBoundary", () => {
  it("身份未确认或未登录时不挂载聊天数据消费者", async () => {
    expect(container.textContent).toBe("");
    expect(accounts.size).toBe(0);
    await switchAccount(null);
    expect(accounts.size).toBe(0);
  });

  it("A 切 B 先清旧内存，A 的迟到回调不能把旧正文写进 B", async () => {
    await switchAccount("user-a");
    const old = accounts.get("user-a");
    if (!old) throw new Error("missing first account");
    await act(async () => old.setMessages([message("private-a")]));
    expect(container.textContent).toBe("user-a:private-a");
    await switchAccount("user-b");
    expect(old.scope.active).toBe(false);
    expect(container.textContent).toBe("user-b:");
    await act(async () => old.setMessages([message("late-private-a")]));
    expect(container.textContent).toBe("user-b:");
    await act(async () =>
      accounts.get("user-b")?.setMessages([message("private-b")])
    );
    expect(container.textContent).toBe("user-b:private-b");
  });

  it("同账号软导航仍保留消息和有效 scope，后台回合可以继续更新", async () => {
    await switchAccount("user-a");
    const old = accounts.get("user-a");
    if (!old) throw new Error("missing first account");
    await act(async () => old.setMessages([message("before-navigation")]));
    await act(async () =>
      root.render(createElement(Layout, { showPage: false }))
    );
    await act(async () =>
      old.setMessages([message("completed-in-background")])
    );
    await act(async () => root.render(createElement(Layout)));
    expect(container.textContent).toBe("user-a:completed-in-background");
    expect(accounts.get("user-a")?.scope).toBe(old.scope);
  });

  it("成功登出立即隐藏消息，同账号重新登录取得新 scope，不复活旧回调", async () => {
    await switchAccount("user-a");
    const old = accounts.get("user-a");
    if (!old) throw new Error("missing first account");
    await act(async () => old.setMessages([message("before-logout")]));
    await act(async () => revokeChatStorageScope("user-a"));
    expect(container.textContent).toBe("");
    await switchAccount(null);
    await switchAccount("user-a");
    const fresh = accounts.get("user-a");
    expect(fresh?.scope).not.toBe(old.scope);
    expect(fresh?.scope.active).toBe(true);
    await act(async () => old.setMessages([message("late-after-login")]));
    expect(container.textContent).toBe("user-a:");
  });
});
