// @vitest-environment jsdom

/** 侧栏真实事件回归：身份发布、登出成功/失败和迟到的旧会话响应。 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentSession } from "@/features/auth/hooks/use-current-session";
import { beginChatStorageScope } from "@/features/image-generation/components/chat-persistence";
import {
  CreateRuntimeProvider,
  useCreateRuntimeState,
} from "@/features/image-generation/create-runtime-store";
import { DashboardSidebar } from "./sidebar";

const state = vi.hoisted(() => ({
  session: null as CurrentSession,
  pending: false,
  push: vi.fn(),
  execute: vi.fn(),
  signOut:
    vi.fn<
      (options: { fetchOptions: { onSuccess: () => void } }) => Promise<void>
    >(),
}));
vi.mock("@/features/auth/hooks/use-current-session", () => ({
  useCurrentSession: () => ({ data: state.session, isPending: state.pending }),
}));
vi.mock("@repo/shared/auth/client", () => ({ signOut: state.signOut }));
vi.mock("@repo/shared/announcements/actions", () => ({
  getMyUnreadAnnouncementCountAction: vi.fn(),
}));
vi.mock("@repo/shared/subscription/actions/get-user-plan", () => ({
  getMyPlanAction: vi.fn(),
}));
vi.mock("@repo/shared/support/actions/ticket", () => ({
  getMyUnreadTicketCountAction: vi.fn(),
}));
vi.mock("@repo/shared/config", () => ({ dashboardConfig: { sidebarNav: [] } }));
vi.mock("@repo/shared/components", () => ({ ModeToggle: () => null }));
vi.mock("@repo/shared/credits/components", () => ({
  CreditBalanceBadge: () => null,
}));
vi.mock("@repo/shared/subscription/components/plan-badge", () => ({
  PlanBadge: () => null,
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: state.execute, result: {} }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/zh/dashboard/create",
  useRouter: () => ({ push: state.push }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "zh",
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => children,
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("@/features/dashboard/context", () => ({
  useSidebar: () => ({
    isCollapsed: false,
    isMobileOpen: false,
    setMobileOpen: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));
vi.mock("@repo/ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@repo/ui/components/sheet", () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let accountUserId: string | null | undefined;

/** 读取与聊天边界相同的共享身份 key。 */
function IdentityProbe() {
  [accountUserId] = useCreateRuntimeState<string | null | undefined>(
    "chatAccountUserId",
    undefined
  );
  return null;
}

/** 保留同一布局实例，模拟会话刷新后的侧栏更新。 */
async function renderSidebar() {
  await act(async () =>
    root.render(
      createElement(
        CreateRuntimeProvider,
        null,
        createElement(DashboardSidebar, {
          initialSession: state.session,
          prefetch: {
            balance: 0,
            plan: "free",
            unreadTickets: 0,
            unreadAnnouncements: 0,
          },
        }),
        createElement(IdentityProbe)
      )
    )
  );
}

/** 提交真实按钮事件，让组件自行调用登出 SDK 回调。 */
async function logout() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === "sidebar.logout"
  );
  if (!button) throw new Error("missing logout button");
  await act(async () => button.click());
}

/** 创建当前用户样本，不访问任何认证端点。 */
function session(userId: string): CurrentSession {
  return { user: { id: userId, name: userId, email: `${userId}@example.com` } };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.session = session("user-a");
  state.pending = false;
  state.push.mockClear();
  state.signOut.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("侧栏聊天账号同步", () => {
  it("复用 SSR 账号，确认切换 B 时撤销 A 的 scope", async () => {
    const old = beginChatStorageScope("user-a");
    await renderSidebar();
    expect(accountUserId).toBe("user-a");
    expect(old.active).toBe(true);
    state.session = session("user-b");
    await renderSidebar();
    expect(accountUserId).toBe("user-b");
    expect(old.active).toBe(false);
  });

  it("登出未成功时保留当前聊天账号和写入资格", async () => {
    const old = beginChatStorageScope("user-a");
    await renderSidebar();
    await logout();
    expect(state.signOut).toHaveBeenCalledOnce();
    expect(old.active).toBe(true);
    expect(accountUserId).toBe("user-a");
    expect(state.push).not.toHaveBeenCalled();
  });

  it("登出成功才撤销旧 scope、清空共享身份并导航", async () => {
    const old = beginChatStorageScope("user-a");
    state.signOut.mockImplementation(async (options) =>
      options.fetchOptions.onSuccess()
    );
    await renderSidebar();
    await logout();
    expect(old.active).toBe(false);
    expect(accountUserId).toBeNull();
    expect(state.push).toHaveBeenCalledExactlyOnceWith("/");
    state.session = session("user-a");
    state.pending = true;
    await renderSidebar();
    expect(accountUserId).toBeNull();
    expect(old.active).toBe(false);
  });
});
