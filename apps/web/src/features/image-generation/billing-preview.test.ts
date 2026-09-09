/**
 * 创作页积分报价路由回归测试。
 *
 * 覆盖 Web-first 像素判定、mixed 父组到子组的预测，以及父子倍率相乘后的
 * 最终展示金额，防止页面再次只展示父组基础价而低报实际扣费。
 */
import { describe, expect, it } from "vitest";

import {
  applyBillingPreviewMultiplier,
  predictImageBillingRoute,
  shouldPreferWebImageRoute,
  type ImageBillingPreviewGroup,
} from "./billing-preview";

const DEFAULT_PIXEL_RANGE = {
  minPixels: 660_000,
  maxPixels: 2_000_000,
};

const MIXED_GROUP: ImageBillingPreviewGroup = {
  id: "mixed",
  name: "Mixed",
  backendType: "mixed",
  billingMultiplier: 1,
  childGroupIds: ["web", "responses"],
};
const WEB_GROUP: ImageBillingPreviewGroup = {
  id: "web",
  name: "Web",
  backendType: "web",
  billingMultiplier: 0.65,
  childGroupIds: [],
};
const RESPONSES_GROUP: ImageBillingPreviewGroup = {
  id: "responses",
  name: "Codex",
  backendType: "responses",
  billingMultiplier: 1.4,
  childGroupIds: [],
};
const MIXED_GROUPS = [MIXED_GROUP, WEB_GROUP, RESPONSES_GROUP];

describe("image generation billing preview", () => {
  it("quotes the predicted Codex child multiplier for the reported 2048x1152 edit", () => {
    const preferWeb = shouldPreferWebImageRoute({
      size: "2048x1152",
      webFirst: true,
      pixelRange: DEFAULT_PIXEL_RANGE,
    });
    const route = predictImageBillingRoute({
      selectedGroup: MIXED_GROUP,
      groups: MIXED_GROUPS,
      preferredBackendType: preferWeb ? "web" : "responses",
    });

    expect(preferWeb).toBe(false);
    expect(route).toMatchObject({
      groupId: "responses",
      backendType: "responses",
      billingMultiplier: 1.4,
    });
    expect(applyBillingPreviewMultiplier(8, route.billingMultiplier)).toBe(
      11.2
    );
  });

  it("quotes the Web child while a request is inside the Web-first range", () => {
    const preferWeb = shouldPreferWebImageRoute({
      size: "1024x1024",
      webFirst: true,
      pixelRange: DEFAULT_PIXEL_RANGE,
    });
    const route = predictImageBillingRoute({
      selectedGroup: MIXED_GROUP,
      groups: MIXED_GROUPS,
      preferredBackendType: preferWeb ? "web" : "responses",
    });

    expect(preferWeb).toBe(true);
    expect(route).toMatchObject({
      groupId: "web",
      backendType: "web",
      billingMultiplier: 0.65,
    });
    expect(applyBillingPreviewMultiplier(8, route.billingMultiplier)).toBe(5.2);
  });

  it("uses the same default Web-first behavior as the server for auto size", () => {
    expect(
      shouldPreferWebImageRoute({
        size: "auto",
        webFirst: true,
        pixelRange: DEFAULT_PIXEL_RANGE,
      })
    ).toBe(true);
  });

  it("predicts Responses when Web-first is explicitly disabled", () => {
    expect(
      shouldPreferWebImageRoute({
        size: "1024x1024",
        webFirst: false,
        pixelRange: DEFAULT_PIXEL_RANGE,
      })
    ).toBe(false);
  });

  it("lets a required Responses route override Web-first", () => {
    expect(
      shouldPreferWebImageRoute({
        size: "1024x1024",
        webFirst: true,
        requiresResponsesBackend: true,
        pixelRange: DEFAULT_PIXEL_RANGE,
      })
    ).toBe(false);
  });

  it.each([
    "gpt-image-2.5",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
  ])("按 Web 优先开关为 %s 使用 Web 子组报价", (imageModel) => {
    const request = {
      size: "1024x1024",
      webFirst: true,
      imageModel,
      pixelRange: DEFAULT_PIXEL_RANGE,
    };
    const preferWeb = shouldPreferWebImageRoute(request);
    expect(preferWeb).toBe(true);
    const route = predictImageBillingRoute({
      selectedGroup: MIXED_GROUP,
      groups: MIXED_GROUPS,
      preferredBackendType: preferWeb ? "web" : "responses",
    });
    expect(route.groupId).toBe(WEB_GROUP.id);
    expect(route.billingMultiplier).toBe(
      MIXED_GROUP.billingMultiplier * WEB_GROUP.billingMultiplier
    );
  });

  it("multiplies parent and predicted child group rates", () => {
    const parentGroup = { ...MIXED_GROUP, billingMultiplier: 1.5 };
    const groups = [parentGroup, WEB_GROUP, RESPONSES_GROUP];
    const route = predictImageBillingRoute({
      selectedGroup: parentGroup,
      groups,
      preferredBackendType: "responses",
    });

    expect(route.billingMultiplier).toBe(2.1);
  });

  it("keeps a directly selected leaf group on its own multiplier", () => {
    const route = predictImageBillingRoute({
      selectedGroup: RESPONSES_GROUP,
      groups: MIXED_GROUPS,
      preferredBackendType: "web",
    });

    expect(route).toMatchObject({
      groupId: "responses",
      backendType: "responses",
      billingMultiplier: 1.4,
    });
  });
});
