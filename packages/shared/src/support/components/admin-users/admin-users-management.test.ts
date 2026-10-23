// @vitest-environment jsdom

/** 用户管理首屏与后续操作回归：真实 React 状态/effect，替换网络 action 与下拉控件。 */
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsersManagement } from "./admin-users-management";

const actions = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../actions/admin-users", () => ({
  getAllUsersAction: actions.load,
  getUserDetailAction: vi.fn(),
  adminAdjustCreditsAction: vi.fn(),
  adminGrantCreditsAction: vi.fn(),
  banUserAction: vi.fn(),
  createUserAction: vi.fn(),
  setExternalApiKeyStatusAction: vi.fn(),
  setUserCreditsStatusAction: vi.fn(),
  setUserPasswordAction: vi.fn(),
  setUserPlanAction: vi.fn(),
  updateUserProfileAction: vi.fn(),
  updateUserRoleAction: vi.fn(),
}));
vi.mock("@repo/ui/components/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) =>
    createElement(
      "select",
      {
        value,
        onChange: (event: { target: { value: string } }) =>
          onValueChange(event.target.value),
      },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) =>
    createElement("option", { value }, children),
}));

/** 与现有列表 action 完全相同的安全投影，不包含密码、会话或 API Key 明文。 */
function snapshot(name = "首屏用户", page = 1) {
  return {
    users: [
      {
        id: `user-${name}`,
        name,
        email: "user@example.com",
        image: null,
        role: "user" as const,
        banned: false,
        bannedReason: null,
        emailVerified: true,
        createdAt: new Date("2026-10-22T00:00:00Z"),
        updatedAt: new Date("2026-10-22T00:00:00Z"),
        creditsBalance: 12,
        creditsTotalEarned: 12,
        creditsTotalSpent: 0,
        creditsStatus: "active" as const,
        subscriptionStatus: null,
        subscriptionPriceId: null,
        subscriptionCurrentPeriodEnd: null,
        plan: "free" as const,
        generationCount: 2,
        failedGenerationCount: 0,
        apiKeyCount: 1,
        activeApiKeyCount: 1,
      },
    ],
    pagination: { page, pageSize: 20, total: 21 },
    stats: { totalUsers: 21, admins: 1, banned: 0, activeSubscriptions: 0 },
  };
}

let root: Root;
let container: HTMLDivElement;

/** 以真实点击触发刷新或翻页，不直接调用组件内部函数。 */
async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`缺少按钮 ${label}`);
  await act(async () => button.click());
}

/** 以用户更改下拉框的事件触发状态筛选。 */
async function changeStatus(value: string) {
  const select = container.querySelector("select");
  if (!select) throw new Error("缺少用户状态筛选");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  actions.load.mockReset();
  actions.load.mockResolvedValue({ data: snapshot("重新加载") });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AdminUsersManagement 首屏预取", () => {
  it("服务端 HTML 直接包含初始用户和分页统计", () => {
    const props = { initialData: snapshot(), timeZone: "UTC" };
    const html = renderToStaticMarkup(
      createElement(AdminUsersManagement, props)
    );
    expect(html).toContain("首屏用户");
    expect(html).toContain("user@example.com");
    expect(html).toContain("显示 1-20 / 共 21 位");
    expect(actions.load).not.toHaveBeenCalled();
  });

  it("带初值挂载时即使 StrictMode 重放 effect 也不重复取数", async () => {
    const props = { initialData: snapshot(), timeZone: "UTC" };
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AdminUsersManagement, props)
        )
      )
    );
    expect(actions.load).not.toHaveBeenCalled();
    expect(container.textContent).toContain("首屏用户");
  });

  it("空列表也是有效的首屏快照", async () => {
    const props = {
      initialData: {
        ...snapshot(),
        users: [],
        pagination: { page: 1, pageSize: 20, total: 0 },
      },
    };
    await act(async () =>
      root.render(createElement(AdminUsersManagement, props))
    );
    expect(actions.load).not.toHaveBeenCalled();
    expect(container.textContent).toContain("没有找到匹配的用户");
  });

  it("不提供预取数据时保留挂载加载", async () => {
    await act(async () => root.render(createElement(AdminUsersManagement)));
    expect(actions.load).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: 1, pageSize: 20, status: "all" })
    );
    expect(container.textContent).toContain("重新加载");
  });

  it("初始数据不抑制之后的筛选、翻页和手动刷新", async () => {
    const props = { initialData: snapshot() };
    await act(async () =>
      root.render(createElement(AdminUsersManagement, props))
    );
    await changeStatus("banned");
    expect(actions.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "banned", page: 1 })
    );
    actions.load.mockResolvedValue({ data: snapshot("第二页", 2) });
    await clickButton("下一页");
    expect(actions.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "banned", page: 2 })
    );
    await clickButton("刷新");
    expect(actions.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "banned", page: 2 })
    );
  });

  it("旧筛选请求迟到时不能覆盖新筛选结果", async () => {
    const props = { initialData: snapshot() };
    await act(async () =>
      root.render(createElement(AdminUsersManagement, props))
    );
    let resolveOlder: (value: { data: ReturnType<typeof snapshot> }) => void =
      () => undefined;
    let resolveNewer: typeof resolveOlder = () => undefined;
    actions.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        })
    );
    actions.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNewer = resolve;
        })
    );
    await changeStatus("banned");
    await changeStatus("active");
    await act(async () => resolveNewer({ data: snapshot("最新筛选") }));
    await act(async () => resolveOlder({ data: snapshot("过期筛选") }));
    expect(container.textContent).toContain("最新筛选");
    expect(container.textContent).not.toContain("过期筛选");
  });

  it("修改每页数量后读取第一页，返回默认筛选也会重新查询", async () => {
    const props = { initialData: snapshot() };
    await act(async () =>
      root.render(createElement(AdminUsersManagement, props))
    );
    const data = snapshot("每页五十条");
    data.pagination.pageSize = 50;
    actions.load.mockResolvedValue({ data });
    const selects = container.querySelectorAll("select");
    const pageSizeSelect = selects[selects.length - 1];
    if (!pageSizeSelect) throw new Error("缺少每页数量控件");
    await act(async () => {
      pageSizeSelect.value = "50";
      pageSizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(actions.load).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: 1, pageSize: 50, status: "all" })
    );
    await changeStatus("banned");
    await changeStatus("all");
    expect(actions.load).toHaveBeenCalledTimes(3);
    expect(actions.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50, status: "all" })
    );
  });
});
