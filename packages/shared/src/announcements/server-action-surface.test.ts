/**
 * "use server" 模块导出面的防回归测试（纯静态读取源码，DB-free）。
 *
 * 约束：Next 会把 "use server" 文件的**每一个导出**注册成可远程调用的 Server Action。
 * 因此这些模块只允许导出带 protectedAction / adminAction / superAdminAction 包装的入口；
 * 无鉴权的服务函数必须放在不带 "use server" 的服务模块（如 ./service.ts、
 * ../support/services/ticket-unread.ts）。
 *
 * 2026-10-24 审查发现公告与工单共 5 个无鉴权 helper 被注册（本机真实构建的 manifest
 * 实测，动作数 99 → 87），取得当次 Action ID 即可绕过管理员入口读未发布公告、
 * 或替任意用户写已读。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 鉴权包装器：直接用它们，或用本文件内由它们派生的工厂。 */
const GUARDED_WRAPPERS = [
  "protectedAction",
  "adminAction",
  "superAdminAction",
];

const ACTION_MODULES = [
  new URL("./actions.ts", import.meta.url),
  new URL("../support/actions/ticket.ts", import.meta.url),
];

/**
 * 收集本文件内由鉴权包装器派生的工厂名（如 `const withTicketAction = (name) =>
 * protectedAction.metadata(...)`）。
 */
function collectGuardedFactories(source: string): string[] {
  const factories: string[] = [];
  for (const match of source.matchAll(
    /^const (\w+) =[\s\S]{0,200}?;$/gm
  )) {
    const [declaration, name] = match;
    if (
      name &&
      GUARDED_WRAPPERS.some((wrapper) => declaration.includes(wrapper))
    ) {
      factories.push(name);
    }
  }
  return factories;
}

/** 提取 `export const X = <初始化片段>` 与 `export [async] function X`。 */
function collectExports(source: string) {
  const items: Array<{ name: string; initializer: string | null }> = [];
  for (const match of source.matchAll(/^export const (\w+)\s*=([\s\S]*?)^\);?$/gm)) {
    items.push({ name: match[1] as string, initializer: match[2] as string });
  }
  for (const match of source.matchAll(
    /^export (?:async )?function (\w+)\s*\(/gm
  )) {
    items.push({ name: match[1] as string, initializer: null });
  }
  return items;
}

describe('"use server" 模块只导出带鉴权的入口', () => {
  for (const moduleUrl of ACTION_MODULES) {
    const path = moduleUrl.pathname;
    const label = path.slice(path.indexOf("/src/") + 1);

    it(`${label} 不导出裸服务函数`, () => {
      const source = readFileSync(moduleUrl, "utf8");
      expect(source.startsWith('"use server"')).toBe(true);

      const allowed = [...GUARDED_WRAPPERS, ...collectGuardedFactories(source)];
      expect(allowed.length).toBeGreaterThan(GUARDED_WRAPPERS.length);

      const exported = collectExports(source);
      expect(exported.length).toBeGreaterThan(0);

      for (const item of exported) {
        // 函数式导出一律不允许：Server Action 入口在本仓统一用 const + 包装器声明。
        expect(
          item.initializer,
          `${item.name} 是函数式导出，应移入服务模块`
        ).not.toBeNull();
        const guarded = allowed.some((wrapper) =>
          (item.initializer as string).includes(wrapper)
        );
        expect(guarded, `${item.name} 缺少鉴权包装`).toBe(true);
      }
    });
  }
});
