// @vitest-environment jsdom

/** 侧栏意图预取回归：只有明确意图才启用 AUTO，原导航属性与子树保持透传。 */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidebarNavigationLink,
  useSidebarVisitedHrefs,
} from "./sidebar-navigation-link";

const observed = vi.hoisted(() => ({
  prefetch: null as boolean | null,
  renders: [] as Array<boolean | null>,
  onNavigate: undefined as
    | ((event: { preventDefault: () => void }) => void)
    | undefined,
}));
const modulePreload = vi.hoisted(() =>
  vi.fn<(href: string) => Promise<unknown>>()
);
vi.mock("@/features/dashboard/sidebar-page-module-preload", () => ({
  preloadSidebarPageModule: modulePreload,
}));
vi.mock("next/link", () => ({
  default: ({
    prefetch,
    onNavigate,
    ...props
  }: ComponentProps<"a"> & {
    prefetch?: boolean | null;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => {
    observed.prefetch = prefetch ?? null;
    observed.renders.push(observed.prefetch);
    observed.onNavigate = onNavigate;
    return createElement("a", props);
  },
}));

let root: Root;
let container: HTMLDivElement;
let hasVisitedHref: (href: string) => boolean;

const navigationHrefs = {
  zh: new Set([
    "/zh/dashboard/history",
    "/zh/dashboard/settings",
    "/zh/dashboard/support",
  ]),
  en: new Set([
    "/en/dashboard/history",
    "/en/dashboard/settings",
    "/en/dashboard/support",
  ]),
};

type StableSidebarProps = {
  userId: string | undefined;
  pathname: string;
  href: string;
  locale: "zh" | "en";
  isOpen: boolean;
};

/** 稳定父级使用真实 hook；关闭时实际卸载移动子 Link，模拟 SheetContent 的生命周期。 */
function StableSidebar({
  userId,
  pathname,
  href,
  locale,
  isOpen,
}: StableSidebarProps) {
  hasVisitedHref = useSidebarVisitedHrefs(
    userId,
    pathname,
    navigationHrefs[locale]
  );
  return isOpen
    ? createElement(SidebarNavigationLink, {
        href,
        isActive: pathname === href,
        hasVisited: hasVisitedHref(href),
      })
    : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed.prefetch = null;
  observed.renders = [];
  observed.onNavigate = undefined;
  modulePreload.mockReset().mockResolvedValue({ status: "loaded" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 同一个组件实例接受重渲，便于核对属性转发。 */
async function renderLink(
  props: Omit<ComponentProps<typeof SidebarNavigationLink>, "hasVisited"> = {
    href: "/zh/dashboard/history",
    isActive: false,
  }
) {
  await act(async () => {
    root.render(
      createElement(
        SidebarNavigationLink,
        { ...props, hasVisited: false },
        createElement("span", { "data-link-child": "status" }, "History")
      )
    );
  });
}

/** 保持父级实例不变，只切换当前路径、账号、语言与移动菜单开闭。 */
async function renderStableSidebar(props: Partial<StableSidebarProps> = {}) {
  await act(async () => {
    root.render(
      createElement(StableSidebar, {
        userId: "user-a",
        pathname: "/zh/dashboard/settings",
        href: "/zh/dashboard/history",
        locale: "zh",
        isOpen: true,
        ...props,
      })
    );
  });
}

/** 发送实际 DOM 事件，由 React 处理包装组件上的监听器。 */
async function dispatch(type: string) {
  const anchor = container.querySelector("a");
  if (!anchor)
    throw new Error("SidebarNavigationLink did not render an anchor");
  await act(async () => {
    anchor.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

/** 在 React act 中推进定时器，避免未提交状态掩盖预取变化。 */
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("SidebarNavigationLink", () => {
  it("没有用户意图时不做可见区域预取", async () => {
    await renderLink();
    await advance(1000);
    expect(observed.prefetch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不足 100ms 的 hover 离开后不触发预取", async () => {
    await renderLink();
    await dispatch("mouseover");
    await advance(99);
    expect(observed.prefetch).toBe(false);
    await dispatch("mouseout");
    await advance(100);
    expect(observed.prefetch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("持续 hover 到 100ms 才启用 AUTO，离开后关闭", async () => {
    await renderLink();
    await dispatch("mouseover");
    await advance(99);
    expect(observed.prefetch).toBe(false);
    await advance(1);
    expect(observed.prefetch).toBeNull();
    await dispatch("mouseout");
    expect(observed.prefetch).toBe(false);
  });

  it("键盘 focus 立即启用 AUTO，blur 关闭并取消 hover 定时器", async () => {
    await renderLink();
    await dispatch("mouseover");
    expect(vi.getTimerCount()).toBe(1);
    await dispatch("focusin");
    expect(observed.prefetch).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await dispatch("focusout");
    expect(observed.prefetch).toBe(false);
  });

  it("touchstart 立即启用 AUTO，并取消尚未触发的 hover", async () => {
    await renderLink();
    await dispatch("mouseover");
    await dispatch("touchstart");
    expect(observed.prefetch).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await dispatch("focusout");
    expect(observed.prefetch).toBe(false);
  });

  it("卸载会清理未到期的 hover 定时器", async () => {
    await renderLink();
    await dispatch("mouseover");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await advance(100);
    expect(observed.prefetch).toBe(false);
  });

  it("透传语言路径、标题、样式、子树和原点击回调，不拦截导航", async () => {
    const onClick = vi.fn();
    await renderLink({
      href: "/en/dashboard/history?page=2",
      isActive: false,
      title: "History title",
      className: "sidebar-nav-item",
      onClick,
    });
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/en/dashboard/history?page=2");
    expect(anchor?.getAttribute("title")).toBe("History title");
    expect(anchor?.className).toBe("sidebar-nav-item");
    expect(
      anchor?.querySelector('[data-link-child="status"]')?.textContent
    ).toBe("History");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    await act(async () => anchor?.dispatchEvent(event));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(observed.prefetch).toBe(false);
  });

  it("当前页 AUTO，实际访问后即使离开页面、鼠标或焦点也保留壳预取", async () => {
    const href = "/zh/dashboard/history";
    await renderStableSidebar({ href, pathname: href });
    expect(observed.prefetch).toBeNull();
    await renderStableSidebar({ href });
    expect(observed.prefetch).toBeNull();
    await dispatch("mouseover");
    await advance(50);
    await dispatch("mouseout");
    await dispatch("focusout");
    expect(vi.getTimerCount()).toBe(0);
    expect(observed.prefetch).toBeNull();
  });

  it("完整 href 改变时清除曾访与悬停 timer，切回旧 href 也不恢复旧状态", async () => {
    const href = "/zh/dashboard/history";
    await renderStableSidebar({ href, pathname: href });
    await renderStableSidebar({ href });
    await dispatch("mouseover");
    expect(vi.getTimerCount()).toBe(1);
    await renderStableSidebar({
      href: "/en/dashboard/history",
      pathname: "/en/dashboard/settings",
      locale: "en",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(observed.prefetch).toBe(false);
    await advance(100);
    expect(observed.prefetch).toBe(false);
    await renderStableSidebar({ href });
    expect(observed.prefetch).toBe(false);
  });

  it("新 href 不继承旧 href 已开启的 hover 意图", async () => {
    await renderLink();
    await dispatch("mouseover");
    await advance(100);
    expect(observed.prefetch).toBeNull();
    await renderLink({
      href: "/zh/dashboard/history?page=2",
      isActive: false,
    });
    expect(observed.prefetch).toBe(false);
  });

  it("移动子 Link 关闭卸载后，稳定父级保留已提交路径，重新打开仍可 AUTO", async () => {
    const href = "/zh/dashboard/history";
    await renderStableSidebar();
    await renderStableSidebar({ isOpen: false });
    expect(container.querySelector("a")).toBeNull();
    // 真实移动点击先关闭 Sheet，URL 随后才提交；登记不能依赖子 Link 还挂着。
    await renderStableSidebar({ pathname: href, isOpen: false });
    expect(hasVisitedHref(href)).toBe(true);
    await renderStableSidebar({ isOpen: false });
    await renderStableSidebar();
    expect(observed.prefetch).toBeNull();
    expect(hasVisitedHref(href)).toBe(true);
  });

  it("切账号或登出时不继承旧账号曾访，切回原账号也不恢复旧标记", async () => {
    const href = "/zh/dashboard/history";
    await renderStableSidebar({ pathname: href });
    await renderStableSidebar();
    observed.renders = [];
    await renderStableSidebar({ userId: "user-b" });
    expect(hasVisitedHref(href)).toBe(false);
    expect(observed.renders.every((prefetch) => prefetch === false)).toBe(true);
    await renderStableSidebar({ userId: undefined });
    await renderStableSidebar({ userId: "user-a" });
    expect(hasVisitedHref(href)).toBe(false);
    expect(observed.prefetch).toBe(false);
  });

  it("只记录有限导航集合的精确路径，不把工单详情当作已访问列表", async () => {
    const href = "/zh/dashboard/support";
    const detail = `${href}/ticket-1`;
    await renderStableSidebar({ href, pathname: detail });
    expect(hasVisitedHref(detail)).toBe(false);
    expect(hasVisitedHref(href)).toBe(false);
    expect(observed.prefetch).toBe(false);
    await renderStableSidebar({ href, pathname: href });
    await renderStableSidebar({ href, pathname: detail });
    expect(hasVisitedHref(href)).toBe(true);
    expect(observed.prefetch).toBeNull();
  });

  it("只在 Next 确认导航时传递完整 href 预热模块，hover/focus/touch 不预热", async () => {
    const href = "/en/dashboard/history?page=2#details";
    await renderLink({ href, isActive: false });
    await dispatch("mouseover");
    await advance(100);
    await dispatch("focusin");
    await dispatch("touchstart");
    expect(modulePreload).not.toHaveBeenCalled();

    // 只驱动 Link 的公开回调；modifier 与导航判定仍由真实 Next 实现。
    expect(observed.onNavigate).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };
    observed.onNavigate?.(event);
    expect(modulePreload).toHaveBeenCalledExactlyOnceWith(href);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("onNavigate 不等待未结束的模块 Promise，不拦截正常导航返回", async () => {
    const pending = new Promise<unknown>(() => {
      // 模块保持加载中，导航回调仍须立即返回。
    });
    modulePreload.mockReturnValue(pending);
    await renderLink();
    expect(observed.onNavigate).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };
    const result = observed.onNavigate?.(event);
    expect(result).toBeUndefined();
    expect(modulePreload).toHaveBeenCalledExactlyOnceWith(
      "/zh/dashboard/history"
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
