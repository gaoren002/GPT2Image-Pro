"use client";

/**
 * 客户端会话状态，供侧栏与营销页使用。
 * SSR 初值用于首次展示；显式刷新及回前台仍请求服务端校验，未提供初值时保留切页刷新。
 */

import { usePathname } from "next/navigation";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import type { AppUserRole } from "@repo/shared/auth/roles";

export type CurrentSession = {
  user?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    role?: AppUserRole;
  };
} | null;

type CurrentSessionState = {
  data: CurrentSession;
  isPending: boolean;
  reload: () => void;
};

const CurrentSessionContext = createContext<CurrentSessionState | null>(null);

/** 合并同一轮回前台的多个浏览器事件，仅等待 50ms，不缓存会话校验结果。 */
const FOREGROUND_REFRESH_COALESCE_MS = 50;

/** 管理单个会话请求；disabled 用于共享 provider 下的消费者，避免重复订阅与请求。 */
function useCurrentSessionState(
  initialData?: CurrentSession,
  disabled = false
): CurrentSessionState {
  const pathname = usePathname();
  const hasInitialData = initialData !== undefined;
  // 有 SSR 初值的共享布局不会随软导航重新挂载；回前台刷新后也不应恢复按路径请求。
  // 将路径依赖只留给无初值的旧调用方，避免导航取消正在进行的失效校验。
  const navigationRefreshPathname = hasInitialData ? null : pathname;
  const [data, setData] = useState<CurrentSession>(initialData ?? null);
  const [isPending, setIsPending] = useState(!hasInitialData);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (disabled || (hasInitialData && reloadToken === 0)) return;
    const controller = new AbortController();

    async function loadSession() {
      setIsPending(true);

      try {
        const requestTag = `${Date.now().toString(36)}-${reloadToken}-${encodeURIComponent(navigationRefreshPathname ?? "")}`;
        const response = await fetch(`/api/session/current?t=${requestTag}`, {
          cache: "no-store",
          credentials: "include",
          method: "POST",
          headers: {
            "Cache-Control": "no-store",
          },
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;
        if (!response.ok) {
          setData(null);
          return;
        }

        const refreshedSession = (await response.json()) as CurrentSession;
        // fetch 或 JSON 解析可能在取消后才完成，旧账号响应不能覆盖新一轮校验结果。
        if (!controller.signal.aborted) setData(refreshedSession);
      } catch {
        if (!controller.signal.aborted) {
          setData((current) => current ?? null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsPending(false);
        }
      }
    }

    loadSession();

    return () => controller.abort();
  }, [disabled, hasInitialData, navigationRefreshPathname, reloadToken]);

  useEffect(() => {
    if (disabled) return;
    let foregroundRefreshTimer: number | undefined;
    const scheduleForegroundRefresh = () => {
      if (
        document.visibilityState !== "visible" ||
        foregroundRefreshTimer !== undefined
      ) {
        return;
      }
      // focus、visibilitychange、pageshow 通常成组触发；只合并尚未开始的本轮校验。
      // 下一轮回前台仍会发新请求，不以时间缓存代替会话撤销或切账号检查。
      foregroundRefreshTimer = window.setTimeout(() => {
        foregroundRefreshTimer = undefined;
        if (document.visibilityState === "visible") reload();
      }, FOREGROUND_REFRESH_COALESCE_MS);
    };
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") scheduleForegroundRefresh();
    };
    const refreshFromBfcache = (event: PageTransitionEvent) => {
      if (event.persisted) scheduleForegroundRefresh();
    };

    window.addEventListener("focus", scheduleForegroundRefresh);
    window.addEventListener("pageshow", refreshFromBfcache);
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      window.removeEventListener("focus", scheduleForegroundRefresh);
      window.removeEventListener("pageshow", refreshFromBfcache);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      if (foregroundRefreshTimer !== undefined) {
        window.clearTimeout(foregroundRefreshTimer);
      }
    };
  }, [disabled, reload]);

  return { data, isPending, reload };
}

/** 在同一布局内共享会话状态，所有消费者复用同一组服务端校验。 */
export function CurrentSessionProvider({
  children,
  initialData,
}: {
  children: ReactNode;
  initialData: CurrentSession;
}) {
  const value = useCurrentSessionState(initialData);
  return createElement(CurrentSessionContext.Provider, { value }, children);
}

/** 优先消费共享 provider；独立调用可用 SSR 初值跳过首次请求。 */
export function useCurrentSession(initialData?: CurrentSession) {
  const shared = useContext(CurrentSessionContext);
  const standalone = useCurrentSessionState(initialData, shared !== null);
  return shared ?? standalone;
}
