"use client";

/** 侧栏主导航的 Next Link 包装，集中管理本场景的预取策略，保留原软导航与子树。 */
import Link from "next/link";
import {
  type MouseEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const HOVER_PREFETCH_DELAY_MS = 100;

type SidebarNavigationLinkProps = {
  href: string;
  isActive: boolean;
  hasVisited: boolean;
  title?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children?: ReactNode;
};

type VisitedHrefState = {
  userId: string | undefined;
  navigationHrefs: ReadonlySet<string>;
  hrefs: Set<string>;
};

/**
 * 稳定侧栏层只登记已提交且属于有限导航集合的路径，不缓存页面或权限数据。
 * navigationHrefs 由父级按 locale/角色 memo；账号或集合作用域变化时不复用旧标记。
 * ref 更新不额外重渲：当前链接由 isActive 保证 AUTO，后续切页或 Sheet 打开会读取新记录。
 */
export function useSidebarVisitedHrefs(
  userId: string | undefined,
  pathname: string,
  navigationHrefs: ReadonlySet<string>
) {
  const visited = useRef<VisitedHrefState | null>(null);

  useEffect(() => {
    let state = visited.current;
    if (
      !state ||
      state.userId !== userId ||
      state.navigationHrefs !== navigationHrefs
    ) {
      state = { userId, navigationHrefs, hrefs: new Set() };
      visited.current = state;
    }
    if (userId && navigationHrefs.has(pathname)) state.hrefs.add(pathname);
  }, [userId, pathname, navigationHrefs]);

  return useCallback(
    (href: string) => {
      const state = visited.current;
      // 在 effect 清理旧记录前也先核对身份与作用域，避免切账号/语言的首个 render 沿用。
      if (
        !userId ||
        !state ||
        state.userId !== userId ||
        state.navigationHrefs !== navigationHrefs
      ) {
        return false;
      }
      return navigationHrefs.has(href) && state.hrefs.has(href);
    },
    [userId, navigationHrefs]
  );
}

/** 精确 href 变化时重建交互状态，避免沿用旧悬停意图与 timer；曾访由稳定父级管理。 */
export function SidebarNavigationLink(props: SidebarNavigationLinkProps) {
  return <SidebarNavigationLinkState key={props.href} {...props} />;
}

/**
 * 当前/已实际访问的链接保留 AUTO 壳预取；其余只在用户表达意图后启用。
 * 不启用 FULL；原导航与 Link 状态上下文仍交由 Next 处理，loading 边界保持。
 */
function SidebarNavigationLinkState({
  href,
  isActive,
  hasVisited,
  title,
  className,
  onClick,
  children,
}: SidebarNavigationLinkProps) {
  const [hasIntent, setHasIntent] = useState(false);
  const hoverTimer = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current === null) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const enablePrefetch = () => {
    clearHoverTimer();
    setHasIntent(true);
  };
  const disablePrefetch = () => {
    clearHoverTimer();
    setHasIntent(false);
  };
  const scheduleHoverPrefetch = () => {
    clearHoverTimer();
    // 忽略鼠标短暂扫过，避免整列可见链接在真实导航期间继续占用弱网带宽。
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      setHasIntent(true);
    }, HOVER_PREFETCH_DELAY_MS);
  };

  return (
    <Link
      href={href}
      title={title}
      className={className}
      onClick={onClick}
      prefetch={isActive || hasVisited || hasIntent ? null : false}
      onMouseEnter={scheduleHoverPrefetch}
      onMouseLeave={disablePrefetch}
      onFocus={enablePrefetch}
      onBlur={disablePrefetch}
      onTouchStart={enablePrefetch}
    >
      {children}
    </Link>
  );
}
