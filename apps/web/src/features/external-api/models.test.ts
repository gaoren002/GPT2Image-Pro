/** 套餐模型目录的权限、覆盖配置和 /v1/models 响应回归测试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserPlan: vi.fn(),
  getPlanCapabilitySnapshot: vi.fn(),
}));

vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: mocks.getUserPlan,
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  getPlanCapabilitySnapshot: mocks.getPlanCapabilitySnapshot,
}));

import type { SubscriptionPlan } from "@repo/shared/config/subscription-plan";

/** 加载真实目录实现，用户套餐和能力读取由 mock 隔离，不连接数据库。 */
async function loadModels() {
  const [models, config] = await Promise.all([
    import("./models"),
    import("@repo/shared/config/subscription-plan"),
  ]);
  return {
    ...models,
    GPT55_CHAT_MODEL: config.GPT55_CHAT_MODEL,
    PREMIUM_CHAT_MODELS: config.PREMIUM_CHAT_MODELS,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserPlan.mockResolvedValue({ plan: "pro" });
  mocks.getPlanCapabilitySnapshot.mockResolvedValue({
    features: {
      "externalApi.images.generate": true,
      "externalApi.chat.completions": true,
      "externalApi.responses": true,
      "models.premium": false,
    },
  });
});

describe("getExternalResponsesImageModels", () => {
  it("returns an empty list when the responses capability is disabled", async () => {
    const { getExternalResponsesImageModels } = await loadModels();
    expect(
      getExternalResponsesImageModels("ultra", { responsesAllowed: false })
    ).toEqual([]);
  });

  it("exposes only GPT-5.5 to ordinary plans and adds all four premium models to Ultra", async () => {
    const {
      getExternalResponsesImageModels,
      GPT55_CHAT_MODEL,
      PREMIUM_CHAT_MODELS,
    } = await loadModels();
    for (const plan of ["free", "starter", "pro"] as SubscriptionPlan[]) {
      expect(getExternalResponsesImageModels(plan)).toEqual([GPT55_CHAT_MODEL]);
    }
    for (const plan of ["ultra", "enterprise"] as SubscriptionPlan[]) {
      expect(getExternalResponsesImageModels(plan)).toEqual([
        GPT55_CHAT_MODEL,
        ...PREMIUM_CHAT_MODELS,
      ]);
    }
  });

  it("honors a premium capability override without removing GPT-5.5", async () => {
    const {
      getExternalResponsesImageModels,
      GPT55_CHAT_MODEL,
      PREMIUM_CHAT_MODELS,
    } = await loadModels();
    expect(
      getExternalResponsesImageModels("pro", { premiumModelsAllowed: true })
    ).toEqual([GPT55_CHAT_MODEL, ...PREMIUM_CHAT_MODELS]);
    expect(
      getExternalResponsesImageModels("ultra", { premiumModelsAllowed: false })
    ).toEqual([GPT55_CHAT_MODEL]);
  });
});

describe("getExternalModelsForUser image model exposure", () => {
  it("exposes the gpt-image-2.5 flagship duo ahead of the default model", async () => {
    const { getExternalModelsForUser } = await loadModels();
    const list = await getExternalModelsForUser("user-1");
    const ids = list.data.map((model) => model.id);
    // 2.5 旗舰双档必须暴露,且排在默认模型之前(旗舰门面)。
    expect(ids.indexOf("gpt-image-2.5-sunburst")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("gpt-image-2.5-flare")).toBeGreaterThan(
      ids.indexOf("gpt-image-2.5-sunburst")
    );
    expect(ids.indexOf("gpt-image-2.5-sunburst")).toBeLessThan(
      ids.indexOf("gpt-image-2")
    );
    // 去重:2.5 双档不应与既有模型 id 重叠。
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getExternalFireflyModels", () => {
  it("returns an empty list when image generation is disabled", async () => {
    const { getExternalFireflyModels } = await loadModels();
    expect(getExternalFireflyModels({ imageGenerateAllowed: false })).toEqual(
      []
    );
    expect(getExternalFireflyModels()).toEqual([]);
  });

  it("includes firefly image family ids and full video ids when allowed", async () => {
    const { getExternalFireflyModels } = await loadModels();
    const models = getExternalFireflyModels({ imageGenerateAllowed: true });
    // 图像族级 id。
    expect(models).toContain("firefly-gpt-image-2");
    expect(models).toContain("firefly-nano-banana-pro");
    // 视频全量 id(参数编码在 id 内)。
    expect(models).toContain("firefly-sora2-8s-16x9");
    // 不应混入分辨率/宽高比展开的图像全组合(图像只列族级)。
    expect(models).not.toContain("firefly-gpt-image-2-2k-1x1");
    expect(models.length).toBeGreaterThan(10);
  });
});

describe("getExternalChatCompletionModels", () => {
  it("returns an empty list when chat completions are disabled", async () => {
    const { getExternalChatCompletionModels } = await loadModels();
    expect(
      getExternalChatCompletionModels("ultra", {
        chatCompletionsAllowed: false,
      })
    ).toEqual([]);
  });

  it("reuses the responses model set when allowed", async () => {
    const { getExternalChatCompletionModels, getExternalResponsesImageModels } =
      await loadModels();
    expect(
      getExternalChatCompletionModels("ultra", { premiumModelsAllowed: true })
    ).toEqual(
      getExternalResponsesImageModels("ultra", {
        responsesAllowed: true,
        premiumModelsAllowed: true,
      })
    );
  });
});

describe("external model access and listing", () => {
  it("lists all 2.5 options, preserves Image 2, and hides premium text models", async () => {
    const { getExternalModelsForUser, PREMIUM_CHAT_MODELS } =
      await loadModels();
    const result = await getExternalModelsForUser("user_1");
    const ids = result.data.map((model) => model.id);
    expect(result.object).toBe("list");
    expect(ids.slice(0, 4)).toEqual([
      "gpt-image-2.5",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2",
    ]);
    expect(ids).toContain("gpt-5.5");
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of [...PREMIUM_CHAT_MODELS, "gpt-5.4", "gpt-5.4-mini"]) {
      expect(ids).not.toContain(model);
    }
  });

  it("checks current capabilities when authorizing Responses models", async () => {
    const { isExternalResponsesImageModelAllowed, PREMIUM_CHAT_MODELS } =
      await loadModels();
    expect(await isExternalResponsesImageModelAllowed("gpt-5.5", "pro")).toBe(
      true
    );
    expect(await isExternalResponsesImageModelAllowed(undefined, "pro")).toBe(
      true
    );
    expect(await isExternalResponsesImageModelAllowed("gpt-5.4", "pro")).toBe(
      false
    );
    for (const model of PREMIUM_CHAT_MODELS) {
      expect(await isExternalResponsesImageModelAllowed(model, "pro")).toBe(
        false
      );
    }
    mocks.getPlanCapabilitySnapshot.mockResolvedValue({
      features: {
        "externalApi.responses": true,
        "models.premium": true,
      },
    });
    for (const model of PREMIUM_CHAT_MODELS) {
      expect(await isExternalResponsesImageModelAllowed(model, "ultra")).toBe(
        true
      );
    }
    mocks.getPlanCapabilitySnapshot.mockResolvedValue({
      features: {
        "externalApi.responses": false,
        "models.premium": true,
      },
    });
    expect(await isExternalResponsesImageModelAllowed(undefined, "ultra")).toBe(
      false
    );
    expect(await isExternalResponsesImageModelAllowed("gpt-5.5", "ultra")).toBe(
      false
    );
  });
});
