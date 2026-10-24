/**
 * Dashboard Server Components 的单次渲染共享读取；React cache 不在请求之间留存。
 * API、扣费和支付服务继续调用原始函数，不能使用这里的展示快照做结算或授权。
 */
import "server-only";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getSidebarCreditsBalance } from "@repo/shared/credits/core";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { cache } from "react";

/** 共享角色读取及本地管理员惰性 bootstrap，仅限本次 RSC 渲染。 */
export const getDashboardUserRole = cache(getUserRoleById);

/** 套餐读取前完成角色 bootstrap，避免首进页面与 layout 对本地超管显示不同套餐。 */
export const getDashboardUserPlan = cache(async (userId: string) => {
  await getDashboardUserRole(userId);
  return getUserPlan(userId);
});

/** 注册奖励与过期清扫只执行一次，layout 和创建页共享同一个最终余额快照。 */
export const getDashboardCreditsBalance = cache(getSidebarCreditsBalance);
