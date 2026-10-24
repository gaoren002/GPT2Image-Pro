/** observer 集成回归：真实注册表、网关及 credits.freeze，阻止写入并保留原访问级别的纯读。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AccessRequirement, OperationDefinition } from "../types";
import type { Principal } from "../principal";

const effects = vi.hoisted(() => ({ freeze: vi.fn(), read: vi.fn() }));
vi.mock("../../credits/core", () => ({ freezeCreditsAccount: effects.freeze }));
vi.mock("../../generation-maintenance", () => ({
  refundGenerationCredits: vi.fn(),
}));
vi.mock("../../system-settings", () => ({ getRuntimeSettingNumber: vi.fn() }));

import { freeze } from "../operations/credits";
import { invokeOperation } from "../invoke";
import { clearRegistry, defineOperation } from "../registry";

const observer: Principal = {
  type: "user",
  userId: "observer-1",
  role: "observer_admin",
};
const readPolicy = { readOnly: true, destructive: false, sideEffects: [] };

/** 注册可观察执行次数的操作，元数据按用例覆盖；不连接任何外部服务。 */
function registerProbe(
  access: AccessRequirement,
  policy: Partial<
    Pick<
      OperationDefinition,
      "readOnly" | "destructive" | "hasMaintenanceWrite"
    >
  > = {}
) {
  return defineOperation({
    name: "regression.observer",
    domain: "support",
    title: "观察员权限回归",
    description: "验证执行前权限断言",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    access,
    ...readPolicy,
    ...policy,
    idempotency: { kind: "natural" },
    execute: async () => {
      effects.read();
      return { ok: true };
    },
  });
}

beforeEach(() => {
  clearRegistry();
  vi.clearAllMocks();
  defineOperation(freeze);
});

describe("observer_admin 只读约束", () => {
  it("真实 credits.freeze 在执行前拒绝观察员", async () => {
    await expect(
      invokeOperation(freeze.name, { userId: "target-1" }, observer)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects.freeze).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"])("保留 %s 的真实冻结操作", async (role) => {
    await expect(
      invokeOperation(
        freeze.name,
        { userId: "target-1" },
        {
          type: "user",
          userId: "admin-1",
          role: role as "admin" | "super_admin",
        }
      )
    ).resolves.toEqual({ success: true });
    expect(effects.freeze).toHaveBeenCalledWith("target-1");
  });

  it.each([
    "public",
    "protected",
    "admin",
    "imageBackendPoolViewer",
  ] as const)("按既有 %s 访问级别放行明确纯读操作", async (kind) => {
    registerProbe({ kind });
    await expect(
      invokeOperation("regression.observer", {}, observer)
    ).resolves.toEqual({ ok: true });
    expect(effects.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    "public",
    "protected",
    "admin",
    "imageBackendPoolViewer",
  ] as const)("%s 级别不能绕过观察员只读约束", async (kind) => {
    registerProbe({ kind }, { readOnly: false });
    await expect(
      invokeOperation("regression.observer", {}, observer)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects.read).not.toHaveBeenCalled();
  });

  it.each([
    { destructive: true },
    { hasMaintenanceWrite: true },
  ])("拒绝带冲突声明的只读操作 %j", async (policy) => {
    registerProbe({ kind: "imageBackendPoolViewer" }, policy);
    await expect(
      invokeOperation("regression.observer", {}, observer)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects.read).not.toHaveBeenCalled();
  });

  it.each([
    "superAdmin",
    "system",
  ] as const)("只读不会授予 %s 访问级别", async (kind) => {
    registerProbe({ kind });
    await expect(
      invokeOperation("regression.observer", {}, observer)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects.read).not.toHaveBeenCalled();
  });
});
