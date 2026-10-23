import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSystemSettingsCache,
  getAdminSystemSettingsSnapshot,
  getRuntimeSettingBoolean,
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
  getRuntimeSettingSelect,
  getRuntimeSettingString,
  importSystemSettingsFromEnv,
  setSettingsCacheInvalidator,
  setSystemSettings,
} from "./index";

// DB-free 单测：用内存 store 模拟 systemSetting 表，覆盖 setSystemSettings
// 的写入主入口、coerceValue 校验门、importSystemSettingsFromEnv 的 overwrite
// 语义、getAdminSystemSettingsSnapshot 的密钥脱敏，以及运行时取值器的
// stored↔env 回退路径。所有逻辑不触达真实 @repo/database。

type StoredSetting = {
  key: string;
  value: unknown;
  isSecret?: boolean;
  updatedBy?: string | null;
  updatedAt?: Date | null;
};

const store = vi.hoisted(() => new Map<string, StoredSetting>());

// 记录最近一次 delete 命中的 key，用于校验 eq(key) 删除分支。
const deletedKeys = vi.hoisted(() => ({ value: [] as string[] }));

// select 故障注入：非 null 时 select 链（await/where）抛错，
// 模拟 DB 抖动/不可达，供 loadSystemSettingsMap 失败兜底用例使用。
const selectFailure = vi.hoisted(() => ({ error: null as Error | null }));

// 可控的在途查询快照，供并发读和“写入时旧查询尚未完成”的交错回归使用。
const selectResponses = vi.hoisted(() => {
  const responses: Array<{
    result: Promise<StoredSetting[]>;
    start: () => void;
  }> = [];
  return responses;
});

const dbMock = vi.hoisted(() => {
  const readRows = () =>
    [...store.values()].map((row) => ({
      key: row.key,
      value: row.value,
      isSecret: row.isSecret ?? false,
      updatedAt: row.updatedAt ?? null,
    }));

  const readResult = () => {
    const pending = selectResponses.shift();
    if (pending) {
      pending.start();
      return pending.result;
    }
    return selectFailure.error
      ? Promise.reject(selectFailure.error)
      : Promise.resolve(readRows());
  };

  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(() => readResult()),
    // biome-ignore lint/suspicious/noThenProperty: 刻意暴露 then 模拟 drizzle 查询构造器的 thenable(await 直接消费)
    then: vi.fn((resolve, reject) => readResult().then(resolve, reject)),
  };

  // upsert 语义：onConflictDoUpdate 时覆盖既有行，模拟 setSystemSettings/
  // importSystemSettingsFromEnv 的写入；onConflictDoNothing 时仅插入缺失行。
  const makeInsertBuilder = () => {
    let pending: StoredSetting[] = [];
    const insertBuilder = {
      values: vi.fn((values: StoredSetting | StoredSetting[]) => {
        pending = Array.isArray(values) ? values : [values];
        for (const value of pending) {
          if (!store.has(value.key)) {
            store.set(value.key, { ...value });
          }
        }
        return insertBuilder;
      }),
      onConflictDoNothing: vi.fn(async () => undefined),
      onConflictDoUpdate: vi.fn(async () => {
        for (const value of pending) {
          store.set(value.key, { ...value });
        }
      }),
    };
    return insertBuilder;
  };

  const deleteBuilder = {
    where: vi.fn(async (target: unknown) => {
      // setSystemSettings 用 eq(key) 删除：mock 的 eq 返回 { key }。
      if (
        target &&
        typeof target === "object" &&
        "key" in target &&
        typeof (target as { key: unknown }).key === "string"
      ) {
        const key = (target as { key: string }).key;
        deletedKeys.value.push(key);
        store.delete(key);
        return;
      }
      // 迁移逻辑用 inArray(...)：mock 的 inArray 返回 key 数组。
      if (Array.isArray(target)) {
        for (const key of target) {
          store.delete(String(key));
        }
      }
    }),
  };

  return {
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => makeInsertBuilder()),
    delete: vi.fn(() => deleteBuilder),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        insert: vi.fn(() => makeInsertBuilder()),
        delete: vi.fn(() => deleteBuilder),
      })
    ),
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
  // eq 返回 { 列: 值 }，便于 deleteBuilder 识别 key 删除分支。
  eq: vi.fn((field: unknown, value: unknown) => ({ [String(field)]: value })),
  inArray: vi.fn((_field: unknown, values: unknown[]) => values),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

describe("setSystemSettings", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
  });

  it("rejects unknown setting key throwing 未知配置项", async () => {
    await expect(
      setSystemSettings([{ key: "NOT_A_REAL_KEY", value: "x" }], "admin")
    ).rejects.toThrow("未知配置项: NOT_A_REAL_KEY");
  });

  it("clear entry deletes stored setting", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "Asia/Shanghai",
    });

    const changed = await setSystemSettings(
      [{ key: "APP_TIME_ZONE", value: "", clear: true }],
      "admin"
    );

    expect(changed).toEqual(["APP_TIME_ZONE"]);
    expect(store.has("APP_TIME_ZONE")).toBe(false);
    expect(deletedKeys.value).toContain("APP_TIME_ZONE");
  });

  it("skips blank secret to avoid wiping stored secret", async () => {
    store.set("BETTER_AUTH_SECRET", {
      key: "BETTER_AUTH_SECRET",
      value: "existing-secret",
      isSecret: true,
    });

    const changed = await setSystemSettings(
      [{ key: "BETTER_AUTH_SECRET", value: "   " }],
      "admin"
    );

    // 空白 secret 被跳过：既不写入也不计入 changedKeys，旧值保留。
    expect(changed).toEqual([]);
    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("existing-secret");
  });

  it("empty coerced string deletes the row", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Old Name",
    });

    const changed = await setSystemSettings(
      [{ key: "NEXT_PUBLIC_APP_NAME", value: "   " }],
      "admin"
    );

    expect(changed).toEqual(["NEXT_PUBLIC_APP_NAME"]);
    expect(store.has("NEXT_PUBLIC_APP_NAME")).toBe(false);
    expect(deletedKeys.value).toContain("NEXT_PUBLIC_APP_NAME");
  });

  it("upsert always stamps isSecret from definition not input", async () => {
    // BETTER_AUTH_SECRET 是 secret 定义项，写入时 isSecret 必须取自定义。
    await setSystemSettings(
      [{ key: "BETTER_AUTH_SECRET", value: "fresh-secret" }],
      "admin"
    );
    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("fresh-secret");
    expect(store.get("BETTER_AUTH_SECRET")?.isSecret).toBe(true);

    // APP_TIME_ZONE 非 secret，isSecret 必为 false。
    await setSystemSettings([{ key: "APP_TIME_ZONE", value: "UTC" }], "admin");
    expect(store.get("APP_TIME_ZONE")?.value).toBe("UTC");
    expect(store.get("APP_TIME_ZONE")?.isSecret).toBe(false);
  });

  it("coerces number values and rejects non-numeric (coerceValue, C-L25)", async () => {
    await setSystemSettings(
      [{ key: "IMAGE_BASE_CREDITS_1024", value: "2.5" }],
      "admin"
    );
    expect(store.get("IMAGE_BASE_CREDITS_1024")?.value).toBe(2.5);

    await expect(
      setSystemSettings(
        [{ key: "IMAGE_BASE_CREDITS_1024", value: "not-a-number" }],
        "admin"
      )
    ).rejects.toThrow(/必须是有效数字/);
  });

  it("enforces per-key number range bounds (coerceValue, S-M8)", async () => {
    // 经济键：价格 min=0.01 拒绝 0 与负数，max=1_000_000 拒绝异常巨大值。
    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "0" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "-5" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "2000000" }],
        "admin"
      )
    ).rejects.toThrow(/不能大于/);

    // 边界：恰好等于下界/上界应通过（闭区间）。
    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "0.01" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(0.01);

    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "1000000" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(1_000_000);

    // 正常区间内的值原样写入。
    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "20" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(20);
  });

  it("allows registration bonus 0 but rejects negative (coerceValue, S-M8)", async () => {
    // 注册奖励积分 min=0：允许 0（关闭赠送），拒绝负数（会发负积分）。
    await setSystemSettings(
      [{ key: "REGISTRATION_BONUS_CREDITS", value: "0" }],
      "admin"
    );
    expect(store.get("REGISTRATION_BONUS_CREDITS")?.value).toBe(0);

    await expect(
      setSystemSettings(
        [{ key: "REGISTRATION_BONUS_CREDITS", value: "-1" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);
  });

  it("rejects non-positive moderation timeout (coerceValue, S-M8)", async () => {
    // 审核超时 min=1：0 或负数会让审核请求立即超时，破坏 fail-closed/open 语义。
    await expect(
      setSystemSettings(
        [{ key: "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS", value: "0" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await setSystemSettings(
      [{ key: "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS", value: "1" }],
      "admin"
    );
    expect(store.get("CONTENT_MODERATION_PROVIDER_TIMEOUT_MS")?.value).toBe(1);
  });

  it("blank number input clears the row instead of coercing to 0 (S-M8)", async () => {
    store.set("PLAN_PRO_MONTHLY_AMOUNT", {
      key: "PLAN_PRO_MONTHLY_AMOUNT",
      value: 60,
    });

    // 空白数值视为清空：删除行回退默认值，且不被 min 范围误判。
    const changed = await setSystemSettings(
      [{ key: "PLAN_PRO_MONTHLY_AMOUNT", value: "   " }],
      "admin"
    );
    expect(changed).toEqual(["PLAN_PRO_MONTHLY_AMOUNT"]);
    expect(store.has("PLAN_PRO_MONTHLY_AMOUNT")).toBe(false);
    expect(deletedKeys.value).toContain("PLAN_PRO_MONTHLY_AMOUNT");
  });

  it("number key without declared range keeps coercion unchanged (S-M8)", async () => {
    // 未声明 min/max 的数值键（如全局并发）行为不变：任意有限数原样写入。
    await setSystemSettings(
      [{ key: "IMAGE_GENERATION_GLOBAL_CONCURRENCY", value: "999999" }],
      "admin"
    );
    expect(store.get("IMAGE_GENERATION_GLOBAL_CONCURRENCY")?.value).toBe(
      999999
    );
  });

  it("rejects malformed json and value not in select options (coerceValue, C-L25)", async () => {
    await expect(
      setSystemSettings(
        [{ key: "PLAN_CAPABILITY_MATRIX", value: "{not json" }],
        "admin"
      )
    ).rejects.toThrow(/必须是有效 JSON/);

    await expect(
      setSystemSettings(
        [{ key: "PAYMENT_PROVIDER", value: "definitely-not-an-option" }],
        "admin"
      )
    ).rejects.toThrow(/取值无效/);
  });
});

describe("importSystemSettingsFromEnv", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
  });

  afterEach(() => {
    delete process.env.APP_TIME_ZONE;
    delete process.env.BETTER_AUTH_SECRET;
  });

  it("overwrite=false (importMissing) keeps existing stored value", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "Asia/Shanghai",
    });
    process.env.APP_TIME_ZONE = "UTC";

    await importSystemSettingsFromEnv({ overwrite: false });

    expect(store.get("APP_TIME_ZONE")?.value).toBe("Asia/Shanghai");
  });

  it("overwrite=true replaces stored value with env-derived value", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "Asia/Shanghai",
    });
    process.env.APP_TIME_ZONE = "UTC";

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("APP_TIME_ZONE")?.value).toBe("UTC");
  });

  it("flags isSecret true for secret-defined keys", async () => {
    process.env.BETTER_AUTH_SECRET = "env-secret";

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("env-secret");
    expect(store.get("BETTER_AUTH_SECRET")?.isSecret).toBe(true);
  });
});

describe("getAdminSystemSettingsSnapshot", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
  });

  afterEach(() => {
    delete process.env.APP_TIME_ZONE;
  });

  it("masks secret values to empty string even when stored", async () => {
    store.set("BETTER_AUTH_SECRET", {
      key: "BETTER_AUTH_SECRET",
      value: "super-secret-value",
      isSecret: true,
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const secret = snapshot.find((item) => item.key === "BETTER_AUTH_SECRET");

    expect(secret?.value).toBe("");
    // 密钥已存储，但展示值脱敏；configured/stored 仍如实标记。
    expect(secret?.stored).toBe(true);
    expect(secret?.configured).toBe(true);
  });

  it("returns non-secret stored value verbatim", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "Asia/Tokyo",
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const tz = snapshot.find((item) => item.key === "APP_TIME_ZONE");

    expect(tz?.value).toBe("Asia/Tokyo");
    expect(tz?.stored).toBe(true);
    expect(tz?.fromEnv).toBe(false);
  });

  it("falls back to trimmed env value when not stored and sets fromEnv=true", async () => {
    process.env.APP_TIME_ZONE = "  UTC  ";

    const snapshot = await getAdminSystemSettingsSnapshot();
    const tz = snapshot.find((item) => item.key === "APP_TIME_ZONE");

    expect(tz?.value).toBe("UTC");
    expect(tz?.stored).toBe(false);
    expect(tz?.fromEnv).toBe(true);
  });

  it("JSON.stringifies an object stored value for display", async () => {
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: { version: 1 },
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const matrix = snapshot.find(
      (item) => item.key === "PLAN_CAPABILITY_MATRIX"
    );

    expect(matrix?.value).toBe(JSON.stringify({ version: 1 }, null, 2));
  });
});

describe("runtime setting getters stored/env fallback (C-L29)", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
  });

  afterEach(() => {
    delete process.env.SELF_USE_MODE_ENABLED;
    delete process.env.APP_TIME_ZONE;
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.PLAN_CAPABILITY_MATRIX;
  });

  it("getRuntimeSettingBoolean reads stored boolean, then env truthy string, else fallback", async () => {
    store.set("SELF_USE_MODE_ENABLED", {
      key: "SELF_USE_MODE_ENABLED",
      value: true,
    });
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED")
    ).resolves.toBe(true);

    store.clear();
    clearSystemSettingsCache();
    process.env.SELF_USE_MODE_ENABLED = "yes";
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED")
    ).resolves.toBe(true);

    delete process.env.SELF_USE_MODE_ENABLED;
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED", true)
    ).resolves.toBe(true);
  });

  it("getRuntimeSettingString prefers stored over env and trims", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "  Asia/Shanghai  ",
    });
    process.env.APP_TIME_ZONE = "UTC";

    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );

    store.clear();
    clearSystemSettingsCache();
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe("UTC");
  });

  it("getRuntimeSettingSelect returns fallback when value not in allowed list", async () => {
    store.set("PAYMENT_PROVIDER", {
      key: "PAYMENT_PROVIDER",
      value: "unknown-provider",
    });

    await expect(
      getRuntimeSettingSelect(
        "PAYMENT_PROVIDER",
        ["creem", "epay"] as const,
        "creem"
      )
    ).resolves.toBe("creem");

    store.set("PAYMENT_PROVIDER", {
      key: "PAYMENT_PROVIDER",
      value: "epay",
    });
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingSelect(
        "PAYMENT_PROVIDER",
        ["creem", "epay"] as const,
        "creem"
      )
    ).resolves.toBe("epay");
  });

  it("getRuntimeSettingJson parses stored string JSON and returns object directly", async () => {
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: '{"version":2}',
    });
    await expect(
      getRuntimeSettingJson("PLAN_CAPABILITY_MATRIX")
    ).resolves.toEqual({ version: 2 });

    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: { version: 3 },
    });
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingJson("PLAN_CAPABILITY_MATRIX")
    ).resolves.toEqual({ version: 3 });
  });
});

describe("loadSystemSettingsMap 查询失败兜底(空设置 + 负缓存 5s)", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
    selectFailure.error = null;
    dbMock.select.mockClear();
    vi.useFakeTimers();
    // 失败路径会打错误日志:静默掉,保持测试输出干净,并据以断言留证行为。
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    selectFailure.error = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("查询失败时按空设置处理:落代码默认值、不抛出、留错误日志", async () => {
    selectFailure.error = new Error("db down");

    await expect(
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7)
    ).resolves.toBe(7);
    expect(console.error).toHaveBeenCalledWith(
      "[system-settings] 设置查询失败,按空设置处理(负缓存 5s)",
      selectFailure.error
    );
  });

  it("负缓存 5s 内不重复查询(失败只触库一次)", async () => {
    selectFailure.error = new Error("db down");

    await getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7);
    await getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7);
    // 边界:负缓存到期前 1ms 仍命中,不重试。
    vi.advanceTimersByTime(4_999);
    await getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7);

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("负缓存过期后重试:再次失败计数 2,DB 恢复后返回真实值", async () => {
    selectFailure.error = new Error("db down");

    await expect(
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7)
    ).resolves.toBe(7);

    // 边界:负缓存刚过 1ms,重试并再次失败(负缓存随之续期)。
    vi.advanceTimersByTime(5_001);
    await expect(
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7)
    ).resolves.toBe(7);
    expect(dbMock.select).toHaveBeenCalledTimes(2);

    selectFailure.error = null;
    store.set("IMAGE_BASE_CREDITS_1024", {
      key: "IMAGE_BASE_CREDITS_1024",
      value: 3,
    });
    vi.advanceTimersByTime(5_001);
    await expect(
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7)
    ).resolves.toBe(3);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
  });

  it("已有正常缓存时注入故障:10s TTL 内仍返回真值、不触库", async () => {
    store.set("APP_TIME_ZONE", {
      key: "APP_TIME_ZONE",
      value: "Asia/Shanghai",
    });
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );
    expect(dbMock.select).toHaveBeenCalledTimes(1);

    // 正常缓存 TTL(10s)到期前 1ms:命中缓存,故障不影响已缓存真值。
    selectFailure.error = new Error("db down");
    vi.advanceTimersByTime(9_999);
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });
});

/** 构造可控 DB 响应；started 确保测试先观测到查询开始，再安排写入或返回。 */
function createPendingSelect() {
  let start: () => void = () => undefined;
  let resolve: (rows: StoredSetting[]) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const started = new Promise<void>((done) => {
    start = done;
  });
  const result = new Promise<StoredSetting[]>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { response: { result, start }, started, resolve, reject };
}

describe("运行时配置并发读取与写入失效", () => {
  beforeEach(() => {
    store.clear();
    selectResponses.length = 0;
    selectFailure.error = null;
    clearSystemSettingsCache();
    dbMock.select.mockClear();
    delete process.env.APP_TIME_ZONE;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    selectFailure.error = null;
    vi.restoreAllMocks();
  });

  it("冷缓存下的不同配置键共享一次查询", async () => {
    const rows = [
      { key: "APP_TIME_ZONE", value: "Asia/Shanghai" },
      { key: "IMAGE_BASE_CREDITS_1024", value: 3 },
    ];
    for (const row of rows) store.set(row.key, row);
    const pending = createPendingSelect();
    selectResponses.push(pending.response);
    const values = Promise.all([
      getRuntimeSettingString("APP_TIME_ZONE"),
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7),
      getRuntimeSettingString("APP_TIME_ZONE"),
    ]);
    await pending.started;
    pending.resolve(rows);

    await expect(values).resolves.toEqual([
      "Asia/Shanghai",
      3,
      "Asia/Shanghai",
    ]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("并发故障只记录一次日志并共享原有负缓存", async () => {
    const pending = createPendingSelect();
    selectResponses.push(pending.response);
    selectFailure.error = new Error("db down");
    const values = Promise.all([
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_1024", 7),
      getRuntimeSettingString("APP_TIME_ZONE"),
      getRuntimeSettingNumber("IMAGE_BASE_CREDITS_4K", 11),
    ]);
    await pending.started;
    pending.reject(selectFailure.error);

    await expect(values).resolves.toEqual([7, undefined, 11]);
    await expect(
      getRuntimeSettingString("APP_TIME_ZONE")
    ).resolves.toBeUndefined();
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("写入后启动新查询，旧查询完成也不能回填缓存或拆散新查询", async () => {
    const previous = createPendingSelect();
    selectResponses.push(previous.response);
    const oldRead = getRuntimeSettingString("APP_TIME_ZONE");
    await previous.started;

    await setSystemSettings(
      [{ key: "APP_TIME_ZONE", value: "Asia/Shanghai" }],
      "tester"
    );
    const current = createPendingSelect();
    selectResponses.push(current.response);
    const freshRead = getRuntimeSettingString("APP_TIME_ZONE");
    await current.started;

    previous.resolve([{ key: "APP_TIME_ZONE", value: "UTC" }]);
    await expect(oldRead).resolves.toBe("UTC");
    const joinedRead = getRuntimeSettingString("APP_TIME_ZONE");
    current.resolve([{ key: "APP_TIME_ZONE", value: "Asia/Shanghai" }]);

    await expect(freshRead).resolves.toBe("Asia/Shanghai");
    await expect(joinedRead).resolves.toBe("Asia/Shanghai");
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it("写入前的查询稍后失败，不能覆盖已经刷新的正常缓存", async () => {
    const previous = createPendingSelect();
    selectResponses.push(previous.response);
    const oldRead = getRuntimeSettingString("APP_TIME_ZONE");
    await previous.started;
    await setSystemSettings(
      [{ key: "APP_TIME_ZONE", value: "Asia/Shanghai" }],
      "tester"
    );
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );

    previous.reject(new Error("old query failed"));
    await expect(oldRead).resolves.toBeUndefined();
    await expect(getRuntimeSettingString("APP_TIME_ZONE")).resolves.toBe(
      "Asia/Shanghai"
    );
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
});

describe("setSettingsCacheInvalidator 级联失效", () => {
  it("clearSystemSettingsCache 触发已注册的下游失效回调", async () => {
    const calls: number[] = [];
    setSettingsCacheInvalidator(() => {
      calls.push(1);
    });
    try {
      // 写路径(setSystemSettings)内部会调 clearSystemSettingsCache
      await setSystemSettings(
        [{ key: "APP_TIME_ZONE", value: "UTC" }],
        "tester"
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      setSettingsCacheInvalidator(null);
    }
  });

  it("未注册回调时 clearSystemSettingsCache 不抛", () => {
    setSettingsCacheInvalidator(null);
    expect(() => clearSystemSettingsCache()).not.toThrow();
  });
});
