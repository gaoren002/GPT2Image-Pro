/** 侧栏页面客户端模块预热：只加载白名单组件，不预取页面数据或执行 action。 */
type SidebarPageModule = "users" | "externalApi" | "history";
type SidebarPageModuleLoaders = Record<
  SidebarPageModule,
  () => Promise<unknown>
>;
type SidebarPageModulePreloadResult =
  | { status: "ignored" }
  | { status: "loaded"; route: SidebarPageModule }
  | { status: "failed"; route: SidebarPageModule; error: unknown };

/**
 * 仅接受侧栏使用的本地化根路径；不做 URL 归一化，避免把外域或路径别名当成白名单。
 * en/zh 与当前 i18n/routing 一致；查询与锚点不改变所需客户端组件。
 */
function resolvePageModule(href: string): SidebarPageModule | null {
  const pathname = href.split(/[?#]/, 1)[0] ?? "";
  const match =
    /^\/(?:en|zh)(\/dashboard\/(?:admin\/users|external-api|history))\/?$/.exec(
      pathname
    );
  switch (match?.[1]) {
    case "/dashboard/admin/users":
      return "users";
    case "/dashboard/external-api":
      return "externalApi";
    case "/dashboard/history":
      return "history";
    default:
      return null;
  }
}

/**
 * 立即发起已知组件的导入并返回 Promise，调用方无需等待即可交给 Next 正常导航。
 * 同模块并发和已成功调用共用结果；失败记录日志并释放入口，后续点击可重新尝试。
 * 缓存只保存三个客户端模块的加载结果，不保存页面数据或用户状态。
 */
export function createSidebarPageModulePreloader(
  loaders: SidebarPageModuleLoaders
) {
  const requests = new Map<
    SidebarPageModule,
    Promise<SidebarPageModulePreloadResult>
  >();
  return (href: string): Promise<SidebarPageModulePreloadResult> => {
    const route = resolvePageModule(href);
    if (!route) return Promise.resolve({ status: "ignored" });
    const existing = requests.get(route);
    if (existing) return existing;

    let loading: Promise<unknown>;
    try {
      loading = Promise.resolve(loaders[route]());
    } catch (error) {
      loading = Promise.reject(error);
    }
    const pending = loading.then<
      SidebarPageModulePreloadResult,
      SidebarPageModulePreloadResult
    >(
      () => ({ status: "loaded", route }),
      (error: unknown) => {
        requests.delete(route);
        console.warn(
          "[sidebar] 客户端模块预热失败，保留正常导航与后续重试",
          route,
          error
        );
        return { status: "failed", route, error };
      }
    );
    requests.set(route, pending);
    return pending;
  };
}

/** 只导入客户端组件的字面量边界，不导入 page，也不手工构造构建生成的 chunk 地址。 */
export const preloadSidebarPageModule = createSidebarPageModulePreloader({
  users: () => import("@repo/shared/support/components/admin-users-management"),
  externalApi: () =>
    import("@/features/settings/components/external-api-key-section"),
  history: () =>
    import("@/features/image-generation/components/history-client"),
});
