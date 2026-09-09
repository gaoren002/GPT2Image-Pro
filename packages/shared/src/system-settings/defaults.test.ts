import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PLAN_CAPABILITY_MATRIX } from "../subscription/services/plan-capabilities";
import {
  CREDIT_PACKAGE_MATRIX_SETTING_KEY,
  getRuntimeCreditPackages,
} from "../credits/packages";
import {
  clearSystemSettingsCache,
  getRuntimeSettingNumber,
  initializeMissingSystemSettingsDefaults,
} from "./index";

type StoredSetting = {
  key: string;
  value: unknown;
  isSecret?: boolean;
  updatedBy?: string | null;
  updatedAt?: Date | null;
};

const store = vi.hoisted(() => new Map<string, StoredSetting>());

const dbMock = vi.hoisted(() => {
  const readRows = () =>
    [...store.values()].map((row) => ({
      key: row.key,
      value: row.value,
    }));
  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(async () => readRows()),
    // biome-ignore lint/suspicious/noThenProperty: 故意实现 thenable，模拟 drizzle 查询构造器被 await 时的行为
    then: vi.fn((resolve, reject) =>
      Promise.resolve(readRows()).then(resolve, reject)
    ),
  };
  const insertBuilder = {
    values: vi.fn((values: StoredSetting | StoredSetting[]) => {
      for (const value of Array.isArray(values) ? values : [values]) {
        if (!store.has(value.key)) {
          store.set(value.key, { ...value });
        }
      }
      return insertBuilder;
    }),
    onConflictDoNothing: vi.fn(async () => undefined),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  const deleteBuilder = {
    where: vi.fn(async (keys: unknown) => {
      if (!Array.isArray(keys)) return;
      for (const key of keys) {
        store.delete(String(key));
      }
    }),
  };

  return {
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => insertBuilder),
    delete: vi.fn(() => deleteBuilder),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        insert: vi.fn(() => insertBuilder),
        delete: vi.fn(() => deleteBuilder),
      })
    ),
    selectBuilder,
    insertBuilder,
    deleteBuilder,
  };
});

vi.mock("@repo/database", () => ({
  db: dbMock,
}));

vi.mock("@repo/database/schema", () => ({
  systemSetting: {
    key: "key",
    value: "value",
    isSecret: "is_secret",
    updatedBy: "updated_by",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  inArray: vi.fn((_field: unknown, values: unknown[]) => values),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

describe("system setting default initialization", () => {
  beforeEach(() => {
    store.clear();
    clearSystemSettingsCache();
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.delete.mockClear();
    dbMock.transaction.mockClear();
    dbMock.selectBuilder.from.mockClear();
    dbMock.selectBuilder.where.mockClear();
    dbMock.selectBuilder.then.mockClear();
    dbMock.insertBuilder.values.mockClear();
    dbMock.insertBuilder.onConflictDoNothing.mockClear();
    dbMock.insertBuilder.onConflictDoUpdate.mockClear();
    dbMock.deleteBuilder.where.mockClear();
  });

  it("persists missing non-secret defaults for a fresh database", async () => {
    const initializedKeys = await initializeMissingSystemSettingsDefaults({
      updatedBy: "admin-1",
    });

    expect(initializedKeys).toContain("PLAN_CAPABILITY_MATRIX");
    expect(initializedKeys).toContain(CREDIT_PACKAGE_MATRIX_SETTING_KEY);
    expect(initializedKeys).toContain("BILLING_YEARLY_ENABLED");
    expect(initializedKeys).toContain("APP_TIME_ZONE");
    expect(initializedKeys).toContain("MARKETING_SLA_STATUS_ENABLED");
    expect(initializedKeys).toContain("SELF_USE_MODE_ENABLED");
    expect(initializedKeys).toContain("REGISTRATION_EMAIL_ALLOWED_DOMAINS");
    expect(initializedKeys).toContain("REGISTRATION_EMAIL_BLOCK_PLUS_ALIASES");
    expect(initializedKeys).toContain(
      "REGISTRATION_EMAIL_BLOCK_DOTTED_LOCAL_PARTS"
    );
    expect(initializedKeys).toContain("GENERATION_IMAGE_RETENTION_HOURS");
    expect(initializedKeys).toContain("GENERATION_IMAGE_RETENTION_MODE");
    expect(initializedKeys).toContain("GENERATION_IMAGE_MAX_COUNT");
    expect(initializedKeys).toContain("IMAGE_GENERATION_GLOBAL_CONCURRENCY");
    expect(initializedKeys).toContain("IMAGE_BASE_CREDITS_1024");
    expect(initializedKeys).toContain("IMAGE_BASE_CREDITS_4K");
    expect(initializedKeys).toContain("RATE_LIMIT_AI_REQUESTS_PER_MINUTE");
    expect(initializedKeys).not.toContain("BETTER_AUTH_SECRET");
    expect(initializedKeys).not.toContain("CREEM_API_KEY");

    expect(store.get("PLAN_CAPABILITY_MATRIX")?.value).toEqual(
      DEFAULT_PLAN_CAPABILITY_MATRIX
    );
    expect(store.get("BILLING_YEARLY_ENABLED")?.value).toBe(true);
    expect(store.get("APP_TIME_ZONE")?.value).toBe("UTC");
    expect(store.get("MARKETING_SLA_STATUS_ENABLED")?.value).toBe(true);
    expect(store.get("SELF_USE_MODE_ENABLED")?.value).toBe(true);
    expect(store.get("REGISTRATION_EMAIL_ALLOWED_DOMAINS")?.value).toBe(
      "163.com,126.com,qq.com,gmail.com"
    );
    expect(store.get("REGISTRATION_EMAIL_BLOCK_PLUS_ALIASES")?.value).toBe(
      false
    );
    expect(
      store.get("REGISTRATION_EMAIL_BLOCK_DOTTED_LOCAL_PARTS")?.value
    ).toBe(false);
    expect(store.get("GENERATION_IMAGE_RETENTION_HOURS")?.value).toBe(0);
    // 默认清理模式 off=永久保存（fail-safe）；最大张数默认 10000。
    expect(store.get("GENERATION_IMAGE_RETENTION_MODE")?.value).toBe("off");
    expect(store.get("GENERATION_IMAGE_MAX_COUNT")?.value).toBe(10000);
    expect(store.get("CREDITS_EXPIRY_DAYS")?.value).toBe(0);
    // 管理员自助充值默认放开(修复:管理员无法设置自己余额);站长可在面板关闭。
    expect(store.get("ADMIN_SELF_CREDITS_GRANT_ENABLED")?.value).toBe(true);
    expect(store.get("IMAGE_GENERATION_GLOBAL_CONCURRENCY")?.value).toBe(500);
    expect(store.get("IMAGE_BASE_CREDITS_1024")?.value).toBe(1.27);
    expect(store.get("IMAGE_BASE_CREDITS_4K")?.value).toBe(10);
    expect(store.get("RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE")?.value).toBe(100);
    expect(store.get("RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE")?.value).toBe(5);
    expect(store.get("RATE_LIMIT_AI_REQUESTS_PER_MINUTE")?.value).toBe(20);
    expect(store.get("RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE")?.value).toBe(10);
    expect(store.get("RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE")?.value).toBe(30);
    expect(store.get("RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE")?.value).toBe(3);
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(20);
    expect(store.get("BETTER_AUTH_SECRET")).toBeUndefined();
    expect(store.get("CREEM_API_KEY")).toBeUndefined();
  });

  it("migrates legacy moderation public URL and removes legacy Aliyun controls", async () => {
    store.set("ALIYUN_MODERATION_PUBLIC_BASE_URL", {
      key: "ALIYUN_MODERATION_PUBLIC_BASE_URL",
      value: "https://images.example.com",
    });
    store.set("ALIYUN_MODERATION_BLOCK_RISK_LEVEL", {
      key: "ALIYUN_MODERATION_BLOCK_RISK_LEVEL",
      value: "medium",
    });

    await initializeMissingSystemSettingsDefaults();

    expect(store.get("CONTENT_MODERATION_PUBLIC_BASE_URL")?.value).toBe(
      "https://images.example.com"
    );
    expect(store.get("ALIYUN_MODERATION_PUBLIC_BASE_URL")).toBeUndefined();
    expect(store.get("ALIYUN_MODERATION_BLOCK_RISK_LEVEL")).toBeUndefined();
  });

  it("migrates legacy Sub2API auto-sync settings into a managed task", async () => {
    store.set("SUB2API_AUTO_SYNC_ENABLED", {
      key: "SUB2API_AUTO_SYNC_ENABLED",
      value: true,
    });
    store.set("SUB2API_AUTO_SYNC_INTERVAL_MINUTES", {
      key: "SUB2API_AUTO_SYNC_INTERVAL_MINUTES",
      value: 60,
    });
    store.set("SUB2API_AUTO_SYNC_SOURCE_GROUP_ID", {
      key: "SUB2API_AUTO_SYNC_SOURCE_GROUP_ID",
      value: "team",
    });
    store.set("SUB2API_AUTO_SYNC_MODE", {
      key: "SUB2API_AUTO_SYNC_MODE",
      value: "both",
    });
    store.set("SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT", {
      key: "SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT",
      value: true,
    });
    store.set("SUB2API_AUTO_SYNC_PLAN_FILTER", {
      key: "SUB2API_AUTO_SYNC_PLAN_FILTER",
      value: "non_free",
    });

    await initializeMissingSystemSettingsDefaults();

    const tasks = store.get("SUB2API_AUTO_SYNC_TASKS")?.value as Array<{
      enabled: boolean;
      intervalMinutes: number;
      sourceGroupId: string | null;
      syncMode: string;
      allowMobileRtImport: boolean;
      planFilter: string;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      sourceGroupId: "team",
      syncMode: "both",
      allowMobileRtImport: true,
      planFilter: "non_free",
    });
    expect(store.get("SUB2API_AUTO_SYNC_INTERVAL_MINUTES")).toBeUndefined();
    expect(store.get("SUB2API_AUTO_SYNC_SOURCE_GROUP_ID")).toBeUndefined();
    expect(store.get("SUB2API_AUTO_SYNC_MODE")).toBeUndefined();
    expect(store.get("SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT")).toBeUndefined();
    expect(store.get("SUB2API_AUTO_SYNC_PLAN_FILTER")).toBeUndefined();
  });

  it("forces Sub2API syncMode=responses when mobile RT import is disabled even if legacy mode=both (C-L28)", async () => {
    store.set("SUB2API_AUTO_SYNC_MODE", {
      key: "SUB2API_AUTO_SYNC_MODE",
      value: "both",
    });
    store.set("SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT", {
      key: "SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT",
      value: false,
    });

    await initializeMissingSystemSettingsDefaults();

    const tasks = store.get("SUB2API_AUTO_SYNC_TASKS")?.value as Array<{
      syncMode: string;
      allowMobileRtImport: boolean;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      syncMode: "responses",
      allowMobileRtImport: false,
    });
  });

  it("falls back invalid Sub2API legacy interval/plan filter to defaults (C-L28)", async () => {
    store.set("SUB2API_AUTO_SYNC_ENABLED", {
      key: "SUB2API_AUTO_SYNC_ENABLED",
      value: true,
    });
    store.set("SUB2API_AUTO_SYNC_INTERVAL_MINUTES", {
      key: "SUB2API_AUTO_SYNC_INTERVAL_MINUTES",
      value: "not-a-number",
    });
    store.set("SUB2API_AUTO_SYNC_PLAN_FILTER", {
      key: "SUB2API_AUTO_SYNC_PLAN_FILTER",
      value: "bogus-filter",
    });

    await initializeMissingSystemSettingsDefaults();

    const tasks = store.get("SUB2API_AUTO_SYNC_TASKS")?.value as Array<{
      intervalMinutes: number;
      planFilter: string;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      intervalMinutes: 720,
      planFilter: "non_free",
    });
  });

  it("does not overwrite existing stored settings", async () => {
    store.set("PLAN_STARTER_MONTHLY_AMOUNT", {
      key: "PLAN_STARTER_MONTHLY_AMOUNT",
      value: 99,
    });
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: {
        version: 1,
        features: {
          ...DEFAULT_PLAN_CAPABILITY_MATRIX.features,
          "imageGeneration.chat": "starter",
        },
        limits: DEFAULT_PLAN_CAPABILITY_MATRIX.limits,
        moderation: DEFAULT_PLAN_CAPABILITY_MATRIX.moderation,
        billing: DEFAULT_PLAN_CAPABILITY_MATRIX.billing,
      },
    });

    const initializedKeys = await initializeMissingSystemSettingsDefaults();

    expect(initializedKeys).not.toContain("PLAN_STARTER_MONTHLY_AMOUNT");
    expect(initializedKeys).not.toContain("PLAN_CAPABILITY_MATRIX");
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(99);
    expect(
      (
        store.get("PLAN_CAPABILITY_MATRIX")
          ?.value as typeof DEFAULT_PLAN_CAPABILITY_MATRIX
      ).features["imageGeneration.chat"]
    ).toBe("starter");
  });

  it("stores the credit package matrix without changing runtime fallback behavior", async () => {
    await initializeMissingSystemSettingsDefaults();
    clearSystemSettingsCache();

    const packages = await getRuntimeCreditPackages({ includeHidden: true });
    const payg = packages.find((pkg) => pkg.id === "payg_starter");
    const enterprise = packages.find((pkg) => pkg.id === "enterprise_resource");

    expect(payg).toMatchObject({
      name: "Pay as you go",
      nameZh: "按量付费",
      description: "One-time credits priced like Starter",
      descriptionZh: "与入门版同价同积分的一次性积分包",
      credits: 5000,
      price: 20,
      visible: true,
      pricesByPlan: {
        free: 20,
        starter: 20,
        pro: 20,
        ultra: 20,
        enterprise: 20,
      },
    });
    expect(payg?.creemProductIdsByPlan).toBeUndefined();
    expect(enterprise).toMatchObject({
      name: "Enterprise Resource Pack",
      nameZh: "企业资源包",
      descriptionZh: "企业版专属资源包，可按数量购买",
      credits: 5000,
      price: 15,
      visible: false,
      requiresPlan: "enterprise",
      pricesByPlan: {
        enterprise: 15,
      },
    });
    expect(enterprise?.creemProductId).toBeUndefined();
  });

  it("allows zero for non-negative runtime number settings", async () => {
    const previousEnvValue = process.env.CREDITS_EXPIRY_DAYS;
    delete process.env.CREDITS_EXPIRY_DAYS;
    store.set("CREDITS_EXPIRY_DAYS", {
      key: "CREDITS_EXPIRY_DAYS",
      value: 0,
    });

    try {
      await expect(
        getRuntimeSettingNumber("CREDITS_EXPIRY_DAYS", 365, {
          nonNegative: true,
        })
      ).resolves.toBe(0);

      await expect(
        getRuntimeSettingNumber("CREDITS_EXPIRY_DAYS", 365, {
          positive: true,
        })
      ).resolves.toBe(365);
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env.CREDITS_EXPIRY_DAYS;
      } else {
        process.env.CREDITS_EXPIRY_DAYS = previousEnvValue;
      }
    }
  });
});
