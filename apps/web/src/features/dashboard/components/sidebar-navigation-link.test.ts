/** 薄包装回归：只核对原属性/子树透传及真实导航回调，不模拟 Next 内部导航规则。 */
import Link from "next/link";
import { createElement, isValidElement, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNavigationLink } from "./sidebar-navigation-link";

const preload = vi.hoisted(() => vi.fn<(href: string) => Promise<unknown>>());
vi.mock("@/features/dashboard/sidebar-page-module-preload", () => ({
  preloadSidebarPageModule: preload,
}));
vi.mock("next/link", () => ({ default: () => null }));

/** 读取包装器交给真实 Link 的属性；不执行或替代 Link 自身逻辑。 */
function renderLink(props: ComponentProps<typeof SidebarNavigationLink>) {
  const element = SidebarNavigationLink(props);
  if (!isValidElement<ComponentProps<typeof Link>>(element)) {
    throw new Error("SidebarNavigationLink did not return a Link element");
  }
  expect(element.type).toBe(Link);
  return element.props;
}

beforeEach(() => {
  preload.mockReset().mockResolvedValue({ status: "loaded" });
});

describe("SidebarNavigationLink", () => {
  it("原 href/title/className/onClick/children 保持透传", () => {
    const onClick = vi.fn();
    const child = createElement(
      "span",
      { "data-link-child": "status" },
      "History"
    );
    const props = renderLink({
      href: "/zh/dashboard/history",
      title: "History",
      className: "nav-item",
      onClick,
      children: child,
    });
    expect(props.href).toBe("/zh/dashboard/history");
    expect(props.prefetch).toBeUndefined();
    expect(props.title).toBe("History");
    expect(props.className).toBe("nav-item");
    expect(props.onClick).toBe(onClick);
    expect(props.children).toBe(child);
  });

  it.each([
    "/zh/dashboard/history?page=2#records",
    "/en/dashboard/admin/users",
    "/zh/dashboard/external-api",
  ])("onNavigate 使用精确 href 且不等待模块：%s", (href) => {
    let complete: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    preload.mockReturnValue(pending);
    const props = renderLink({ href });
    if (!props.onNavigate) throw new Error("missing onNavigate callback");

    const result = props.onNavigate({ preventDefault: vi.fn() });

    expect(preload).toHaveBeenCalledExactlyOnceWith(href);
    expect(result).toBeUndefined();
    complete();
  });

  it("单纯渲染链接不启动模块预热", () => {
    renderLink({ href: "/zh/dashboard/history" });
    renderLink({ href: "/zh/dashboard/admin/users" });
    expect(preload).not.toHaveBeenCalled();
  });
});
