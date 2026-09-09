import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAN_PRIVILEGES,
  PLAN_RANK,
  SUBSCRIPTION_PLANS,
} from "../../config/subscription-plan";
import { SYSTEM_SETTING_DEFINITIONS } from "../../system-settings/definitions";
import {
  DEFAULT_PLAN_CAPABILITY_MATRIX,
  PLAN_CAPABILITY_KEYS,
  canUsePlanCapability,
  getAllowedPlanModerationBlockRiskLevels,
  getDefaultPlanModerationBlockRiskLevel,
  getMaxPlanModerationBlockRiskLevel,
  getPlanBillingConfig,
  getPlanCapabilityMatrix,
  getPlanCapabilitySnapshot,
  getPlanLimits,
  getPlanModerationConfig,
  getPlanMonthlyCredits,
  getPlanPrivilegesFromCapabilities,
  getPlanQueueSettings,
  MAX_PLAN_BATCH_COUNT,
  MAX_PLAN_IMAGE_COUNT,
  megabytesToBytes,
  normalizePlanCapabilityMatrix,
  normalizePlanModerationBlockRiskLevel,
  type PlanLimitConfig,
} from "./plan-capabilities";

const runtimeSettingsMock = vi.hoisted(() => ({
  getRuntimeSettingJson: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
}));

vi.mock("../../system-settings", () => runtimeSettingsMock);

const higherThan = (plan: (typeof SUBSCRIPTION_PLANS)[number]) =>
  SUBSCRIPTION_PLANS.filter((candidate) => PLAN_RANK[candidate] > PLAN_RANK[plan]);

describe("plan capability matrix defaults", () => {
  beforeEach(() => {
    runtimeSettingsMock.getRuntimeSettingJson.mockReset();
    runtimeSettingsMock.getRuntimeSettingNumber.mockReset();
  });

  it("normalizes an empty value to the complete default matrix", () => {
    const matrix = normalizePlanCapabilityMatrix(undefined);

    expect(matrix).toEqual(DEFAULT_PLAN_CAPABILITY_MATRIX);
    expect(Object.keys(matrix.features).sort()).toEqual(
      [...PLAN_CAPABILITY_KEYS].sort()
    );
    expect(matrix.features["externalApi.streaming"]).toBe("starter");
    expect(matrix.features["externalApi.responses"]).toBe("pro");
    expect(matrix.features["externalApi.agent"]).toBe("ultra");
    expect(matrix.features["imageGeneration.chat"]).toBe("pro");
    expect(matrix.features["imageGeneration.agent"]).toBe("pro");
    expect(matrix.features["imageGeneration.waterfall"]).toBe("pro");
    expect(matrix.features["export.ppt"]).toBe("free");
    expect(matrix.features["export.psd"]).toBe("free");
    expect(matrix.features["moderation.onlyFailureSettlement"]).toBe("ultra");
    expect(matrix.limits.ultra).toMatchObject({
      maxFileMb: 100,
      maxUploadMb: 100,
      imageGenerationConcurrency: 50,
      monthlyCredits: 80_000,
      queuePriority: "highest",
    });
    expect(matrix.limits.enterprise.monthlyCredits).toBe(320_000);
    expect(matrix.billing.free).toEqual({
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    });
    expect(matrix.billing.enterprise).toEqual({
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    });
  });

  it("keeps the system settings example in sync with every matrix field", () => {
    const setting = SYSTEM_SETTING_DEFINITIONS.find(
      (definition) => definition.key === "PLAN_CAPABILITY_MATRIX"
    );

    expect(setting?.exampleValue).toEqual(DEFAULT_PLAN_CAPABILITY_MATRIX);
  });

  it("accepts custom feature thresholds and ignores invalid capability values", () => {
    const matrix = normalizePlanCapabilityMatrix({
      features: {
        "externalApi.streaming": "ultra",
        "externalApi.agent": "enterprise",
        "promptOptimization.control": "free",
        "imageGeneration.chat": "starter",
        "imageGeneration.agent": "ultra",
        "imageGeneration.waterfall": "pro",
        "externalApi.responses": "not-a-plan",
        "unknown.feature": "enterprise",
      },
    });

    expect(matrix.features["externalApi.streaming"]).toBe("ultra");
    expect(matrix.features["externalApi.agent"]).toBe("enterprise");
    expect(matrix.features["promptOptimization.control"]).toBe("free");
    expect(matrix.features["imageGeneration.chat"]).toBe("starter");
    expect(matrix.features["imageGeneration.agent"]).toBe("ultra");
    expect(matrix.features["imageGeneration.waterfall"]).toBe("pro");
    expect(matrix.features["externalApi.responses"]).toBe(
      DEFAULT_PLAN_CAPABILITY_MATRIX.features["externalApi.responses"]
    );
    expect(Object.keys(matrix.features).sort()).toEqual(
      [...PLAN_CAPABILITY_KEYS].sort()
    );
  });

  it("migrates the old flagship threshold and lets explicit premium settings win", () => {
    expect(
      normalizePlanCapabilityMatrix({
        features: { "models.gpt55": "enterprise" },
      }).features["models.premium"]
    ).toBe("enterprise");
    expect(
      normalizePlanCapabilityMatrix({
        features: { "models.gpt55": "enterprise", "models.premium": "ultra" },
      }).features["models.premium"]
    ).toBe("ultra");
    expect(DEFAULT_PLAN_CAPABILITY_MATRIX.features["models.premium"]).toBe(
      "ultra"
    );
  });

  it("merges partial limits with defaults and preserves Ultra-specific settings", () => {
    const matrix = normalizePlanCapabilityMatrix({
      limits: {
        ultra: {
          maxFileMb: 150,
          maxUploadMb: 300,
          queuePriority: "highest",
          imageGenerationConcurrency: 88,
          monthlyCredits: 123_456,
          maxBatchCount: 20,
          maxEditImages: 32,
          maxChatImages: 24,
          maxChatContextChars: 99_999,
        },
      },
    });

    expect(matrix.limits.pro).toEqual(DEFAULT_PLAN_CAPABILITY_MATRIX.limits.pro);
    expect(matrix.limits.ultra).toMatchObject({
      maxFileMb: 150,
      maxUploadMb: 300,
      queuePriority: "highest",
      imageGenerationConcurrency: 88,
      monthlyCredits: 123_456,
      maxBatchCount: 20,
      maxEditImages: 32,
      maxChatImages: 24,
      maxChatContextChars: 99_999,
    });
    expect(matrix.limits.enterprise).toMatchObject({
      maxUploadMb: 300,
      maxBatchCount: 20,
      maxEditImages: 32,
      maxChatImages: 24,
      maxChatContextChars: 99_999,
    });
  });

  it("enforces higher plans to inherit at least lower-plan numeric limits", () => {
    const freeLimits: PlanLimitConfig = {
      maxFileMb: 500,
      maxUploadMb: 600,
      queuePriority: "highest",
      imageGenerationConcurrency: 25,
      monthlyCredits: 900_000,
      maxBatchCount: 42,
      maxEditImages: 41,
      maxChatImages: 40,
      maxChatContextChars: 150_000,
    };
    const matrix = normalizePlanCapabilityMatrix({
      limits: {
        free: freeLimits,
        starter: {
          maxFileMb: 1,
          maxUploadMb: 1,
          queuePriority: "normal",
          imageGenerationConcurrency: 1,
          monthlyCredits: 1,
          maxBatchCount: 1,
          maxEditImages: 1,
          maxChatImages: 1,
          maxChatContextChars: 1,
        },
      },
    });

    expect(matrix.limits.free).toEqual(freeLimits);
    for (const plan of higherThan("free")) {
      expect(matrix.limits[plan].maxFileMb).toBeGreaterThanOrEqual(500);
      expect(matrix.limits[plan].maxUploadMb).toBeGreaterThanOrEqual(600);
      expect(matrix.limits[plan].queuePriority).toBe("highest");
      expect(matrix.limits[plan].imageGenerationConcurrency).toBeGreaterThanOrEqual(
        25
      );
      expect(matrix.limits[plan].monthlyCredits).toBeGreaterThanOrEqual(900_000);
      expect(matrix.limits[plan].maxBatchCount).toBeGreaterThanOrEqual(42);
      expect(matrix.limits[plan].maxEditImages).toBeGreaterThanOrEqual(41);
      expect(matrix.limits[plan].maxChatImages).toBeGreaterThanOrEqual(40);
      expect(matrix.limits[plan].maxChatContextChars).toBeGreaterThanOrEqual(
        150_000
      );
    }
  });

  it("falls back for invalid limits and clamps bounded request counts", () => {
    const matrix = normalizePlanCapabilityMatrix({
      limits: {
        free: {
          maxFileMb: 0,
          maxUploadMb: -1,
          queuePriority: "urgent",
          imageGenerationConcurrency: 20_000,
          monthlyCredits: "invalid",
          maxBatchCount: MAX_PLAN_BATCH_COUNT + 1.9,
          maxEditImages: MAX_PLAN_IMAGE_COUNT + 50,
          maxChatImages: String(MAX_PLAN_IMAGE_COUNT + 200),
          maxChatContextChars: 999_999,
        },
      },
    });

    expect(matrix.limits.free).toMatchObject({
      maxFileMb: DEFAULT_PLAN_CAPABILITY_MATRIX.limits.free.maxFileMb,
      maxUploadMb: DEFAULT_PLAN_CAPABILITY_MATRIX.limits.free.maxUploadMb,
      queuePriority: DEFAULT_PLAN_CAPABILITY_MATRIX.limits.free.queuePriority,
      imageGenerationConcurrency: 10_000,
      monthlyCredits: DEFAULT_PLAN_CAPABILITY_MATRIX.limits.free.monthlyCredits,
      maxBatchCount: MAX_PLAN_BATCH_COUNT,
      maxEditImages: MAX_PLAN_IMAGE_COUNT,
      maxChatImages: MAX_PLAN_IMAGE_COUNT,
      maxChatContextChars: 200_000,
    });
  });

  it("allows enterprise batch and reference-image limits above 100", () => {
    const matrix = normalizePlanCapabilityMatrix({
      limits: {
        enterprise: {
          maxBatchCount: 500,
          maxEditImages: 256,
          maxChatImages: 300,
        },
      },
    });

    expect(matrix.limits.enterprise).toMatchObject({
      maxBatchCount: 500,
      maxEditImages: 256,
      maxChatImages: 300,
    });
  });

  it("clamps moderation defaults and lets higher plans inherit lower-plan max levels", () => {
    const matrix = normalizePlanCapabilityMatrix({
      moderation: {
        free: {
          defaultBlockRiskLevel: "high",
          maxBlockRiskLevel: "medium",
        },
        starter: {
          defaultBlockRiskLevel: "invalid",
          maxBlockRiskLevel: "low",
        },
        pro: {
          defaultBlockRiskLevel: "low",
          maxBlockRiskLevel: "low",
        },
        ultra: {
          defaultBlockRiskLevel: "low",
          maxBlockRiskLevel: "low",
        },
        enterprise: {
          defaultBlockRiskLevel: "medium",
          maxBlockRiskLevel: "invalid",
        },
      },
    });

    expect(matrix.moderation.free).toEqual({
      defaultBlockRiskLevel: "medium",
      maxBlockRiskLevel: "medium",
    });
    for (const plan of ["starter", "pro", "ultra"] as const) {
      expect(matrix.moderation[plan].maxBlockRiskLevel).toBe("medium");
      expect(matrix.moderation[plan].defaultBlockRiskLevel).toBe("low");
    }
    expect(matrix.moderation.enterprise).toEqual({
      defaultBlockRiskLevel: "medium",
      maxBlockRiskLevel: "high",
    });
  });

  it("accepts custom chat and agent round billing per plan", () => {
    const matrix = normalizePlanCapabilityMatrix({
      billing: {
        pro: {
          chatRoundCredits: 2,
          agentRoundCredits: 5.5,
        },
        ultra: {
          chatRoundCredits: "0",
          agentRoundCredits: "invalid",
        },
      },
    });

    expect(matrix.billing.pro).toEqual({
      chatRoundCredits: 2,
      agentRoundCredits: 5.5,
    });
    expect(matrix.billing.ultra).toEqual(
      DEFAULT_PLAN_CAPABILITY_MATRIX.billing.ultra
    );
  });
});

describe("plan capability matrix runtime accessors", () => {
  beforeEach(() => {
    runtimeSettingsMock.getRuntimeSettingJson.mockReset();
    runtimeSettingsMock.getRuntimeSettingNumber.mockReset();
  });

  it("uses a configured matrix directly without reading legacy upload or credit settings", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue({
      features: {
        "externalApi.streaming": "ultra",
        "externalApi.agent": "ultra",
      },
      limits: {
        free: {
          maxUploadMb: 11,
        },
      },
    });
    runtimeSettingsMock.getRuntimeSettingNumber.mockResolvedValue(999);

    const matrix = await getPlanCapabilityMatrix();

    expect(matrix.features["externalApi.streaming"]).toBe("ultra");
    expect(matrix.features["externalApi.agent"]).toBe("ultra");
    expect(matrix.limits.free.maxUploadMb).toBe(11);
    expect(runtimeSettingsMock.getRuntimeSettingNumber).not.toHaveBeenCalled();
  });

  it("keeps legacy upload and monthly-credit settings compatible when no matrix is configured", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue(undefined);
    runtimeSettingsMock.getRuntimeSettingNumber.mockImplementation(
      async (key: string, fallback: number) => {
        if (key === "PLAN_ULTRA_MAX_FILE_MB") return 111;
        if (key === "PLAN_ULTRA_MAX_UPLOAD_MB") return 222;
        if (key === "PLAN_PRO_MONTHLY_CREDITS") return 33_333;
        return fallback;
      }
    );

    const matrix = await getPlanCapabilityMatrix();

    expect(matrix.limits.pro.monthlyCredits).toBe(33_333);
    expect(matrix.limits.ultra.maxFileMb).toBe(111);
    expect(matrix.limits.ultra.maxUploadMb).toBe(222);
    expect(matrix.limits.enterprise.maxUploadMb).toBe(222);
    expect(runtimeSettingsMock.getRuntimeSettingNumber).toHaveBeenCalledTimes(14);
  });

  it("drives feature gates, limits, queue settings, snapshots, and moderation helpers", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue({
      features: {
        "externalApi.streaming": "ultra",
        "externalApi.agent": "ultra",
        "imageGeneration.chat": "starter",
        "imageGeneration.agent": "ultra",
        "imageGeneration.waterfall": "pro",
      },
      limits: {
        ultra: {
          maxFileMb: 150,
          maxUploadMb: 180,
          queuePriority: "highest",
          imageGenerationConcurrency: 77,
          monthlyCredits: 88_000,
          maxBatchCount: 22,
          maxEditImages: 33,
          maxChatImages: 44,
          maxChatContextChars: 55_000,
        },
      },
      billing: {
        ultra: {
          chatRoundCredits: 2,
          agentRoundCredits: 6,
        },
      },
      moderation: {
        ultra: {
          defaultBlockRiskLevel: "medium",
          maxBlockRiskLevel: "medium",
        },
      },
    });

    await expect(
      canUsePlanCapability("pro", "externalApi.streaming")
    ).resolves.toBe(false);
    await expect(
      canUsePlanCapability("ultra", "externalApi.streaming")
    ).resolves.toBe(true);
    await expect(canUsePlanCapability("pro", "externalApi.agent")).resolves.toBe(
      false
    );
    await expect(
      canUsePlanCapability("ultra", "externalApi.agent")
    ).resolves.toBe(true);
    await expect(canUsePlanCapability("starter", "imageGeneration.chat")).resolves.toBe(
      true
    );
    await expect(canUsePlanCapability("pro", "imageGeneration.agent")).resolves.toBe(
      false
    );
    await expect(canUsePlanCapability("ultra", "imageGeneration.agent")).resolves.toBe(
      true
    );
    await expect(
      canUsePlanCapability("pro", "imageGeneration.waterfall")
    ).resolves.toBe(true);

    await expect(getPlanLimits("ultra")).resolves.toMatchObject({
      maxFileMb: 150,
      maxUploadMb: 180,
      imageGenerationConcurrency: 77,
      monthlyCredits: 88_000,
    });
    await expect(getPlanMonthlyCredits("ultra")).resolves.toBe(88_000);
    await expect(getPlanQueueSettings("ultra")).resolves.toEqual({
      priority: "highest",
      userConcurrency: 77,
    });
    await expect(getPlanBillingConfig("ultra")).resolves.toEqual({
      chatRoundCredits: 2,
      agentRoundCredits: 6,
    });
    await expect(getAllowedPlanModerationBlockRiskLevels("ultra")).resolves.toEqual(
      ["low", "medium"]
    );
    await expect(normalizePlanModerationBlockRiskLevel("ultra", "high")).resolves.toBe(
      "medium"
    );

    const snapshot = await getPlanCapabilitySnapshot("ultra");
    expect(snapshot.features["externalApi.streaming"]).toBe(true);
    expect(snapshot.features["externalApi.agent"]).toBe(true);
    expect(snapshot.features["models.premium"]).toBe(true);
    expect(snapshot.limits.maxFileSizeBytes).toBe(megabytesToBytes(150));
    expect(snapshot.limits.maxUploadBytes).toBe(megabytesToBytes(180));
    expect(snapshot.billing).toEqual({
      chatRoundCredits: 2,
      agentRoundCredits: 6,
    });
    expect(snapshot.moderation.allowedBlockRiskLevels).toEqual([
      "low",
      "medium",
    ]);
  });
});

describe("plan capability privilege and moderation accessors", () => {
  beforeEach(() => {
    runtimeSettingsMock.getRuntimeSettingJson.mockReset();
    runtimeSettingsMock.getRuntimeSettingNumber.mockReset();
  });

  it("merges static privileges with runtime byte limits", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue({
      limits: {
        pro: {
          maxFileMb: 64,
          maxUploadMb: 128,
          imageGenerationConcurrency: 21,
          monthlyCredits: 42_000,
        },
      },
    });

    const privileges = await getPlanPrivilegesFromCapabilities("pro");

    expect(privileges.name).toBe(PLAN_PRIVILEGES.pro.name);
    expect(privileges.maxFileSizeBytes).toBe(megabytesToBytes(64));
    expect(privileges.maxUploadBytes).toBe(megabytesToBytes(128));
    expect(privileges.imageGenerationConcurrency).toBe(21);
    expect(privileges.monthlyCredits).toBe(42_000);
  });

  it("returns the plan moderation row from the configured matrix", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue({
      moderation: {
        ultra: {
          defaultBlockRiskLevel: "medium",
          maxBlockRiskLevel: "medium",
        },
      },
    });

    await expect(getPlanModerationConfig("ultra")).resolves.toEqual({
      defaultBlockRiskLevel: "medium",
      maxBlockRiskLevel: "medium",
    });
  });

  it("exposes default and max moderation block risk levels", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue(undefined);
    runtimeSettingsMock.getRuntimeSettingNumber.mockImplementation(
      async (_key: string, fallback: number) => fallback
    );

    await expect(
      getDefaultPlanModerationBlockRiskLevel("enterprise")
    ).resolves.toBe("high");
    await expect(getMaxPlanModerationBlockRiskLevel("enterprise")).resolves.toBe(
      "high"
    );
    await expect(getDefaultPlanModerationBlockRiskLevel("free")).resolves.toBe(
      "low"
    );
    await expect(getMaxPlanModerationBlockRiskLevel("free")).resolves.toBe(
      "low"
    );
  });
});
