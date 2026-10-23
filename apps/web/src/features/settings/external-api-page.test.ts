/** 外接 API 服务端页回归：沿原鉴权查询提供快照，错误与匿名访问不直出数据。 */
import { Children, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExternalApiPage from "@/app/[locale]/(dashboard)/dashboard/external-api/page";
import { ExternalApiKeySection } from "./components/external-api-key-section";
import type { ExternalApiKeyInitialSnapshot } from "./external-api-key-snapshot";

const queries = vi.hoisted(() => ({
  session: vi.fn(),
  keys: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: queries.session,
}));
vi.mock("@repo/shared/subscription/actions/get-user-plan", () => ({
  getMyPlanAction: queries.plan,
}));
vi.mock("@/features/settings/actions/external-api-key", () => ({
  getExternalApiKeys: queries.keys,
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: async () => "UTC",
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "zh",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("./components/external-api-key-section", () => ({
  ExternalApiKeySection: () => null,
}));

beforeEach(() => {
  queries.session.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  queries.keys.mockReset().mockResolvedValue({
    data: { keys: [], groups: [], canUseRelay: false },
  });
  queries.plan.mockReset().mockResolvedValue({
    data: { plan: "pro", capabilities: null },
  });
});

/** 提取页面实际构造的客户端元素，不复制页面的查询或快照逻辑。 */
async function renderedSection() {
  const page = await ExternalApiPage();
  const section = Children.toArray(page.props.children).find(
    (child) => isValidElement(child) && child.type === ExternalApiKeySection
  );
  if (
    !isValidElement<{
      timeZone: string;
      initialSnapshot?: ExternalApiKeyInitialSnapshot;
    }>(section)
  ) {
    throw new Error("ExternalApiPage did not render ExternalApiKeySection");
  }
  return section.props;
}

describe("ExternalApiPage", () => {
  it("完成会话检查后直接调用原受保护查询，首屏携带套餐快照", async () => {
    const props = await renderedSection();
    expect(queries.keys).toHaveBeenCalledExactlyOnceWith();
    expect(queries.plan).toHaveBeenCalledExactlyOnceWith();
    expect(props).toMatchObject({
      timeZone: "UTC",
      initialSnapshot: { keys: [], groups: [], plan: "pro" },
    });
  });

  it("查询失败不保留错误快照，下一次渲染继续校验并重试", async () => {
    queries.keys.mockResolvedValueOnce({ serverError: "access denied" });
    expect((await renderedSection()).initialSnapshot).toBeUndefined();
    expect((await renderedSection()).initialSnapshot?.plan).toBe("pro");
    expect(queries.keys).toHaveBeenCalledTimes(2);
  });

  it("匿名访问先重定向，不执行 Key 或套餐查询", async () => {
    queries.session.mockResolvedValue(null);
    await expect(ExternalApiPage()).rejects.toThrow("redirect:/zh/sign-in");
    expect(queries.keys).not.toHaveBeenCalled();
    expect(queries.plan).not.toHaveBeenCalled();
  });
});
