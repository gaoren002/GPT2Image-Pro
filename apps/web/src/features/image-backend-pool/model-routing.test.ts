/**
 * 目标主组的模型路由回归测试，覆盖纯 Web 固定图片型号、Firefly 标志与重试一致性。
 * 只验证纯策略，不依赖数据库、账号或租约。
 */
import { describe, expect, it } from "vitest";
import { resolvePoolModelRouting } from "./model-routing";

describe("pool model routing for the selected primary group", () => {
  it.each([
    "image_generation",
    "image_edit",
  ] as const)("routes every %s model to GPT Image 2.5 for a Web group", (requestKind) => {
    for (const requestedModel of [
      undefined,
      "gpt-image-1.5",
      "gpt-image-2.5-flare",
      "firefly-nano-banana",
      "custom-model",
    ]) {
      for (const forceFirefly of [false, true]) {
        expect(
          resolvePoolModelRouting({
            groupBackendType: "web",
            requestKind,
            requestedModel,
            forceFirefly,
          })
        ).toEqual({
          requestedModel: "gpt-image-2.5",
          forceFirefly: false,
          fireflyOnly: false,
          excludeAdobeBackends: true,
        });
      }
    }
  });

  it("preserves a Web chat text model while clearing Adobe routing", () => {
    for (const requestedModel of [
      "gpt-5.5",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "custom-chat-model",
    ]) {
      expect(
        resolvePoolModelRouting({
          groupBackendType: "web",
          requestKind: "chat",
          requestedModel,
          forceFirefly: true,
        })
      ).toEqual({
        requestedModel,
        forceFirefly: false,
        fireflyOnly: false,
        excludeAdobeBackends: true,
      });
    }
  });

  it("does not manufacture a default chat model", () => {
    expect(
      resolvePoolModelRouting({ groupBackendType: "web", requestKind: "chat" })
        .requestedModel
    ).toBeUndefined();
  });

  it.each([
    "mixed",
    "responses",
  ] as const)("preserves model and explicit Adobe intent for a %s primary group", (groupBackendType) => {
    expect(
      resolvePoolModelRouting({
        groupBackendType,
        requestKind: "image_generation",
        requestedModel: "gpt-image-2.5-flare",
        forceFirefly: true,
      })
    ).toEqual({
      requestedModel: "gpt-image-2.5-flare",
      forceFirefly: true,
      fireflyOnly: true,
      excludeAdobeBackends: false,
    });
    expect(
      resolvePoolModelRouting({
        groupBackendType,
        requestKind: "image_edit",
        requestedModel: " Firefly-nano-banana ",
      })
    ).toEqual({
      requestedModel: " Firefly-nano-banana ",
      forceFirefly: false,
      fireflyOnly: true,
      excludeAdobeBackends: false,
    });
    expect(
      resolvePoolModelRouting({
        groupBackendType,
        requestKind: "chat",
        requestedModel: "gpt-5.5",
      }).fireflyOnly
    ).toBe(false);
  });

  it("does not turn a mixed main group into fixed Web routing for a Web candidate", () => {
    const routing = resolvePoolModelRouting({
      groupBackendType: "mixed",
      requestedModel: "firefly-gpt-image-2",
    });
    expect(routing.requestedModel).toBe("firefly-gpt-image-2");
    expect(routing.fireflyOnly).toBe(true);
    expect(routing.excludeAdobeBackends).toBe(false);
  });

  it("uses identical routing when stale selection or capacity waiting retries", () => {
    const first = resolvePoolModelRouting({
      groupBackendType: "web",
      requestKind: "image_edit",
      requestedModel: "firefly-gpt-image-2",
      forceFirefly: true,
    });
    const retried = resolvePoolModelRouting({
      groupBackendType: "web",
      requestKind: "image_edit",
      requestedModel: first.requestedModel,
      forceFirefly: first.forceFirefly,
    });
    expect(retried).toEqual(first);
  });

  it("keeps request-type authorization independent from model normalization", () => {
    const routing = resolvePoolModelRouting({
      groupBackendType: "web",
      requestKind: "responses",
      requestedModel: "gpt-6-astra",
    });
    expect(routing.requestedModel).toBe("gpt-6-astra");
    expect(routing.fireflyOnly).toBe(false);
  });
});
