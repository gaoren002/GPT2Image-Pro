// @vitest-environment jsdom

/** 外接 API 首屏回归：SSR 摘要不重复查询，刷新与无快照兜底继续走原受保护 action。 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import type { ExternalApiKeyInitialSnapshot } from "../external-api-key-snapshot";
import { ExternalApiKeySection } from "./external-api-key-section";

const queries = vi.hoisted(() => ({ keys: vi.fn(), plan: vi.fn() }));
vi.mock("../actions", () => ({
  getExternalApiKeys: queries.keys,
  createExternalApiKey: vi.fn(),
  deleteExternalApiKey: vi.fn(),
  revokeExternalApiKey: vi.fn(),
  updateExternalApiKeyGroup: vi.fn(),
  updateExternalApiKeyModeration: vi.fn(),
  updateExternalApiKeyQuota: vi.fn(),
  updateExternalApiKeyRelay: vi.fn(),
}));
vi.mock("@repo/shared/subscription/actions/get-user-plan", () => ({
  getMyPlanAction: queries.plan,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "zh",
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: async () => undefined,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
}));

const snapshot: ExternalApiKeyInitialSnapshot = {
  keys: [
    {
      id: "key-1",
      name: "Snapshot key",
      keyPrefix: "g2i_prefix",
      lastFour: "1234",
      moderationBlockRiskLevel: "high",
      generationGroupId: null,
      creditLimit: 100,
      creditsUsed: 20,
      relayOnly: false,
      lastUsedAt: null,
      isActive: true,
      createdAt: "2026-10-23T00:00:00Z",
    },
  ],
  groups: [],
  plan: "pro",
  capabilities: null,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queries.keys.mockReset().mockResolvedValue({
    data: {
      keys: [{ ...snapshot.keys[0], name: "Reloaded key" }],
      groups: [],
    },
  });
  queries.plan.mockReset().mockResolvedValue({
    data: { plan: "pro", capabilities: null },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** 实际挂载组件并等待 effect 和 action hooks 提交状态。 */
async function renderSection(initialSnapshot?: ExternalApiKeyInitialSnapshot) {
  await act(async () => {
    root.render(
      createElement(ExternalApiKeySection, {
        timeZone: "UTC",
        initialSnapshot,
      })
    );
  });
}

describe("ExternalApiKeySection SSR snapshot", () => {
  it("首屏直接展示摘要和套餐权限，挂载不重复请求两个 action", async () => {
    await renderSection(snapshot);
    expect(container.textContent).toContain("Snapshot key");
    expect(container.textContent).not.toContain("requiresStarter");
    expect(queries.keys).not.toHaveBeenCalled();
    expect(queries.plan).not.toHaveBeenCalled();
    const quota = container.querySelector<HTMLInputElement>(
      'input[id="external-key-quota-key-1"]'
    );
    expect(quota?.value).toBe("100");
  });

  it("带快照的页面仍可用原刷新入口更新列表", async () => {
    await renderSection(snapshot);
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="refresh"]'
    );
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());
    expect(queries.keys).toHaveBeenCalledTimes(1);
    expect(queries.plan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reloaded key");
  });

  it("SSR 查询失败未提供快照时，保留原挂载查询兜底", async () => {
    await renderSection();
    expect(queries.keys).toHaveBeenCalledTimes(1);
    expect(queries.plan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Reloaded key");
  });

  it("首屏以服务端能力位为准，不用套餐名称覆盖禁止管理 Key 的配置", async () => {
    const capabilities = await getPlanCapabilitySnapshot("pro");
    await renderSection({
      ...snapshot,
      capabilities: {
        ...capabilities,
        features: {
          ...capabilities.features,
          "externalApi.keys.manage": false,
        },
      },
    });
    expect(container.textContent).toContain("requiresStarter");
    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "create"
    );
    expect(create?.disabled).toBe(true);
    expect(queries.plan).not.toHaveBeenCalled();
  });
});
