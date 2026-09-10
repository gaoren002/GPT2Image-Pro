import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const schemaMock = vi.hoisted(() => {
  const column = (tableName: string, columnName: string) => ({
    __columnName: columnName,
    __tableName: tableName,
  });
  const table = <T extends readonly string[]>(tableName: string, columns: T) =>
    Object.fromEntries([
      ["__tableName", tableName],
      ...columns.map((name) => [name, column(tableName, name)]),
    ]);

  return {
    externalApiKey: table("external_api_key", ["id", "generationGroupId"]),
    imageBackendAccount: table("image_backend_account", [
      "id",
      "groupId",
      "name",
      "accessToken",
      "model",
      "implementationMode",
      "contentSafetyEnabled",
      "isEnabled",
      "priority",
      "concurrency",
      "successCount",
      "failCount",
      "status",
      "lastUsedAt",
      "lastAcquiredAt",
      "cooldownUntil",
      "lastError",
      "lastErrorAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendAccountGroup: table("image_backend_account_group", [
      "accountId",
      "groupId",
    ]),
    imageBackendApiGroup: table("image_backend_api_group", [
      "apiId",
      "groupId",
    ]),
    imageBackendApi: table("image_backend_api", [
      "id",
      "groupId",
      "name",
      "baseUrl",
      "apiKey",
      "model",
      "interfaceMode",
      "chatCompletionsUpstreamMode",
      "imageUpstreamMode",
      "useStream",
      "contentSafetyEnabled",
      "isEnabled",
      "alwaysActive",
      "priority",
      "concurrency",
      "failureCooldownEnabled",
      "successCount",
      "failCount",
      "status",
      "lastUsedAt",
      "lastAcquiredAt",
      "cooldownUntil",
      "lastError",
      "lastErrorAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendAdobe: table("image_backend_adobe", [
      "id",
      "groupId",
      "name",
      "baseUrl",
      "apiKey",
      "enabledModels",
      "defaultRatio",
      "defaultResolution",
      "gptImageQuality",
      "billingMultiplier",
      "supportsVideo",
      "contentSafetyEnabled",
      "isEnabled",
      "alwaysActive",
      "priority",
      "concurrency",
      "failureCooldownEnabled",
      "successCount",
      "failCount",
      "status",
      "lastUsedAt",
      "lastAcquiredAt",
      "cooldownUntil",
      "lastError",
      "lastErrorAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendAdobeGroup: table("image_backend_adobe_group", [
      "adobeId",
      "groupId",
    ]),
    imageBackendGroup: table("image_backend_group", [
      "id",
      "name",
      "description",
      "isEnabled",
      "isDefault",
      "isUserSelectable",
      "contentSafetyEnabled",
      "priority",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendInflightLease: table("image_backend_inflight_lease", [
      "id",
      "memberType",
      "memberId",
      "expiresAt",
      "createdAt",
    ]),
    imageBackendStickyBinding: table("image_backend_sticky_binding", [
      "id",
      "scope",
      "bindingKey",
      "memberType",
      "memberId",
      "groupId",
      "accountBackend",
      "expiresAt",
      "lastHitAt",
      "hitCount",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendSchedulerMetric: table("image_backend_scheduler_metric", [
      "id",
      "bucketStartedAt",
      "requestKind",
      "selectedLayer",
      "memberType",
      "memberId",
      "groupId",
      "selectCount",
      "stickyPreviousHitCount",
      "stickySessionHitCount",
      "loadBalanceCount",
      "switchCount",
      "candidateCountTotal",
      "latencyMsTotal",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    systemSetting: table("system_setting", ["key", "value"]),
    userImageBackendPreference: table("user_image_backend_preference", [
      "userId",
      "groupId",
    ]),
  };
});

const dbMock = vi.hoisted(() => {
  const state = {
    groups: [] as Row[],
    accounts: [] as Row[],
    apis: [] as Row[],
    adobes: [] as Row[],
    userPreferences: [] as Row[],
    externalApiKeys: [] as Row[],
    stickyBindings: [] as Row[],
    schedulerMetrics: [] as Row[],
    leases: [] as Row[],
    lockedLastAcquiredAtById: new Map<string, Date | null>(),
    limitCalls: [] as { tableName: string; limit: number }[],
    updates: [] as { tableName: string; values: Row }[],
    inserts: [] as { tableName: string; values: Row }[],
    executeCalls: [] as unknown[],
  };

  const tableNameOf = (table: unknown) =>
    typeof table === "object" && table && "__tableName" in table
      ? String((table as { __tableName: string }).__tableName)
      : "";

  const rowsForTable = (tableName: string) => {
    switch (tableName) {
      case "external_api_key":
        return state.externalApiKeys;
      case "image_backend_account":
        return state.accounts;
      case "image_backend_api":
        return state.apis;
      case "image_backend_adobe":
        return state.adobes;
      case "image_backend_group":
        return state.groups;
      case "image_backend_sticky_binding":
        return state.stickyBindings;
      case "image_backend_scheduler_metric":
        return state.schedulerMetrics;
      case "image_backend_inflight_lease":
        return state.leases;
      case "user_image_backend_preference":
        return state.userPreferences;
      default:
        return [];
    }
  };

  const simplePredicateValue = (predicate: unknown, columnName: string) => {
    if (
      typeof predicate !== "object" ||
      !predicate ||
      !("kind" in predicate) ||
      !("values" in predicate) ||
      (predicate as { kind: unknown }).kind !== "eq"
    ) {
      return undefined;
    }
    const values = (predicate as { values: unknown[] }).values;
    const column = values[0];
    if (
      typeof column === "object" &&
      column &&
      "__columnName" in column &&
      (column as { __columnName: string }).__columnName === columnName
    ) {
      return values[1];
    }
    return undefined;
  };

  const findPredicateValue = (
    predicate: unknown,
    columnName: string
  ): unknown => {
    const value = simplePredicateValue(predicate, columnName);
    if (value !== undefined) return value;
    if (
      typeof predicate === "object" &&
      predicate &&
      "values" in predicate &&
      Array.isArray((predicate as { values: unknown[] }).values)
    ) {
      for (const child of (predicate as { values: unknown[] }).values) {
        const childValue = findPredicateValue(child, columnName);
        if (childValue !== undefined) return childValue;
      }
    }
    return undefined;
  };

  const createSelectBuilder = (options?: { filterByWhere?: boolean }) => {
    let tableName = "";
    let limitValue: number | null = null;
    let wherePredicate: unknown;
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn((table: unknown) => {
      tableName = tableNameOf(table);
      return builder;
    });
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn((predicate: unknown) => {
      wherePredicate = predicate;
      return builder;
    });
    builder.orderBy = vi.fn(() => builder);
    builder.groupBy = vi.fn(() => builder);
    builder.for = vi.fn(() => builder);
    builder.limit = vi.fn((limit: number) => {
      limitValue = limit;
      state.limitCalls.push({ tableName, limit });
      return builder;
    });
    // biome-ignore lint/suspicious/noThenProperty: drizzle query mocks need to be awaitable.
    builder.then = (
      resolve: (value: Row[]) => unknown,
      reject?: (reason: unknown) => unknown
    ) => {
      let rows = rowsForTable(tableName);
      if (options?.filterByWhere) {
        const id = findPredicateValue(wherePredicate, "id");
        const memberType = findPredicateValue(wherePredicate, "memberType");
        const memberId = findPredicateValue(wherePredicate, "memberId");
        rows = rows.filter((row) => {
          if (id !== undefined && row.id !== id) return false;
          if (memberType !== undefined && row.memberType !== memberType) {
            return false;
          }
          if (memberId !== undefined && row.memberId !== memberId) {
            return false;
          }
          return true;
        });
        if (
          id !== undefined &&
          (tableName === "image_backend_account" ||
            tableName === "image_backend_api") &&
          state.lockedLastAcquiredAtById.has(String(id))
        ) {
          const lockedLastAcquiredAt = state.lockedLastAcquiredAtById.get(
            String(id)
          );
          for (const row of rowsForTable(tableName)) {
            if (row.id === id) {
              row.lastAcquiredAt = lockedLastAcquiredAt;
            }
          }
          rows = rows.map((row) =>
            row.id === id
              ? { ...row, lastAcquiredAt: lockedLastAcquiredAt }
              : row
          );
        }
      }
      rows = limitValue === null ? rows : rows.slice(0, limitValue);
      return Promise.resolve(rows).then(resolve, reject);
    };
    return builder;
  };

  const createUpdateBuilder = (table: unknown) => {
    const tableName = tableNameOf(table);
    let updateValues: Row = {};
    const builder: Record<string, unknown> = {};
    builder.set = vi.fn((values: Row) => {
      updateValues = values;
      state.updates.push({ tableName, values });
      return builder;
    });
    builder.where = vi.fn(async (predicate: unknown) => {
      const rows = rowsForTable(tableName);
      const id = findPredicateValue(predicate, "id");
      for (const row of rows) {
        if (id !== undefined && row.id !== id) continue;
        Object.assign(row, updateValues);
      }
      return undefined;
    });
    return builder;
  };

  const createInsertBuilder = (table: unknown) => {
    const tableName = tableNameOf(table);
    const builder: Record<string, unknown> = {};
    builder.values = vi.fn((values: Row) => {
      state.inserts.push({ tableName, values });
      if (tableName === "image_backend_inflight_lease") {
        state.leases.push(values);
      }
      return builder;
    });
    builder.onConflictDoUpdate = vi.fn(async () => undefined);
    return builder;
  };

  return {
    state,
    db: {
      select: vi.fn(() => createSelectBuilder()),
      update: vi.fn((table: unknown) => createUpdateBuilder(table)),
      insert: vi.fn((table: unknown) => createInsertBuilder(table)),
      execute: vi.fn(async (query: unknown) => {
        state.executeCalls.push(query);
        return [];
      }),
      transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn(() => createSelectBuilder({ filterByWhere: true })),
          update: vi.fn((table: unknown) => createUpdateBuilder(table)),
          insert: vi.fn((table: unknown) => createInsertBuilder(table)),
          delete: vi.fn((table: unknown) => ({
            where: vi.fn(async (predicate: unknown) => {
              const tableName = tableNameOf(table);
              if (tableName === "image_backend_inflight_lease") {
                const memberType = findPredicateValue(predicate, "memberType");
                const memberId = findPredicateValue(predicate, "memberId");
                state.leases = state.leases.filter((lease) => {
                  if (
                    memberType !== undefined &&
                    lease.memberType !== memberType
                  ) {
                    return true;
                  }
                  if (memberId !== undefined && lease.memberId !== memberId) {
                    return true;
                  }
                  return false;
                });
              }
            }),
          })),
          execute: vi.fn(async (query: unknown) => {
            state.executeCalls.push(query);
            return [];
          }),
        };
        return await callback(tx);
      }),
    },
  };
});

vi.mock("@repo/database", () => ({
  db: dbMock.db,
}));

vi.mock("@repo/database/schema", () => schemaMock);

vi.mock("drizzle-orm", () => {
  const predicate = (kind: string, values: unknown[]) => ({ kind, values });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    strings,
    values,
  });
  return {
    and: (...values: unknown[]) => predicate("and", values),
    asc: (...values: unknown[]) => predicate("asc", values),
    count: (...values: unknown[]) => predicate("count", values),
    desc: (...values: unknown[]) => predicate("desc", values),
    eq: (...values: unknown[]) => predicate("eq", values),
    gt: (...values: unknown[]) => predicate("gt", values),
    ilike: (...values: unknown[]) => predicate("ilike", values),
    inArray: (...values: unknown[]) => predicate("inArray", values),
    isNull: (...values: unknown[]) => predicate("isNull", values),
    lt: (...values: unknown[]) => predicate("lt", values),
    notInArray: (...values: unknown[]) => predicate("notInArray", values),
    or: (...values: unknown[]) => predicate("or", values),
    sql,
  };
});

vi.mock("@repo/shared/config/subscription-plan", () => ({
  isPlanAtLeast: vi.fn(() => true),
  normalizeSubscriptionPlan: vi.fn(
    (_value: unknown, fallback: string) => fallback
  ),
}));

vi.mock("@repo/shared/image-backend/nested-groups", () => ({
  validateNestedGroupConfig: vi.fn(() => ({ ok: true })),
}));

vi.mock("@repo/shared/logger", () => ({
  logWarn: vi.fn(),
}));

vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: vi.fn(() => true),
}));

vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(async () => ({ plan: "ultra" })),
}));

vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: vi.fn(),
  getRuntimeSettingBoolean: vi.fn(
    async (_key: string, fallback = false) => fallback
  ),
  getRuntimeSettingJson: vi.fn(async () => undefined),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingSelect: vi.fn(
    async (_key: string, fallback: string) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

vi.mock("@/features/image-generation/chatgpt-web", () => ({
  getChatGptWebAccountInfo: vi.fn(),
}));

import { getRuntimeSettingBoolean } from "@repo/shared/system-settings";
import {
  reportImageBackendResult,
  resetImageBackendInflightForTests,
  resolveImageBackendPoolConfig,
} from "./service";

function testJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

function makeAccount(index: number) {
  return {
    matchedGroupId: "group-a",
    id: `acct-${index}`,
    groupId: null,
    name: `Account ${index}`,
    accessToken: `token-${index}`,
    model: null,
    implementationMode: "responses",
    contentSafetyEnabled: true,
    priority: 10,
    concurrency: 1,
    lastUsedAt: null,
    lastAcquiredAt: null,
    createdAt: new Date(2026, 0, index),
    metadata: null,
  };
}

function makeAdobe(index: number, overrides: Row = {}) {
  return {
    matchedGroupId: "group-a",
    id: `adobe-${index}`,
    groupId: null,
    name: `Adobe ${index}`,
    mode: "direct",
    baseUrl: "https://firefly.example.test",
    apiKey: "adobe-key",
    enabledModels: null,
    defaultRatio: "1x1",
    defaultResolution: "2k",
    gptImageQuality: "high",
    billingMultiplier: 1,
    supportsVideo: false,
    contentSafetyEnabled: true,
    priority: 10,
    concurrency: 10,
    lastUsedAt: null,
    lastAcquiredAt: null,
    createdAt: new Date(2026, 0, index),
    metadata: null,
    ...overrides,
  };
}

describe("image backend pool scheduler selection", () => {
  beforeEach(() => {
    resetImageBackendInflightForTests();
    dbMock.state.groups = [
      {
        id: "group-a",
        name: "Codex group",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
    ];
    dbMock.state.accounts = Array.from({ length: 55 }, (_, index) =>
      makeAccount(index + 1)
    );
    dbMock.state.apis = [];
    dbMock.state.adobes = [];
    dbMock.state.userPreferences = [];
    dbMock.state.externalApiKeys = [];
    dbMock.state.stickyBindings = [];
    dbMock.state.schedulerMetrics = [];
    dbMock.state.leases = [];
    dbMock.state.lockedLastAcquiredAtById.clear();
    dbMock.state.limitCalls = [];
    dbMock.state.updates = [];
    dbMock.state.inserts = [];
    dbMock.state.executeCalls = [];
    vi.clearAllMocks();
    vi.mocked(getRuntimeSettingBoolean).mockImplementation(
      async (_key: string, fallback = false) => fallback
    );
  });

  it("does not truncate runtime backend candidates at 50", async () => {
    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
      excludedMemberKeys: Array.from(
        { length: 50 },
        (_, index) => `account:acct-${index + 1}`
      ),
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-51");
    expect(dbMock.state.limitCalls.filter((call) => call.limit === 50)).toEqual(
      []
    );
  });

  it("propagates the imported ChatGPT workspace id to Web requests", async () => {
    dbMock.state.groups[0] = {
      ...dbMock.state.groups[0],
      metadata: { backendType: "web" },
    };
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        implementationMode: "web",
        metadata: { chatgptAccountId: "workspace-1" },
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.config.headers).toEqual({
      "ChatGPT-Account-Id": "workspace-1",
    });
  });

  it("prefers the Web access token workspace claim for existing accounts", async () => {
    dbMock.state.groups[0] = {
      ...dbMock.state.groups[0],
      metadata: { backendType: "web" },
    };
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        accessToken: testJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace-jwt",
          },
        }),
        implementationMode: "web",
        metadata: { chatgptAccountId: "workspace-stale" },
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.config.headers).toEqual({
      "ChatGPT-Account-Id": "workspace-jwt",
    });
  });

  it("reserves backend capacity during selection and skips saturated members", async () => {
    dbMock.state.accounts = [makeAccount(1), makeAccount(2)];

    const first = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });
    const second = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });
    const third = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(first?.memberId).toBe("acct-1");
    expect(second?.memberId).toBe("acct-2");
    expect(third).toBeNull();
  });

  it("respects the configured API concurrency instead of a hardcoded 1", async () => {
    dbMock.state.accounts = [];
    dbMock.state.apis = [
      {
        id: "api-cc",
        groupId: "group-a",
        name: "Concurrent API",
        baseUrl: "https://api.example.test/v1",
        apiKey: "key",
        model: null,
        interfaceMode: "responses",
        chatCompletionsUpstreamMode: "responses",
        imageUpstreamMode: "responses",
        useStream: false,
        contentSafetyEnabled: true,
        alwaysActive: false,
        priority: 1,
        concurrency: 3,
        lastUsedAt: null,
        createdAt: new Date(2026, 0, 1),
      },
    ];

    // 并发数 3：前三次都能选中（租约不释放，累计在飞 1/2/3），第四次饱和返回 null。
    // 修复前 API 并发写死 1，第二次即 null。
    const picks: (string | undefined)[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      picks.push(result?.memberId);
    }
    expect(picks).toEqual(["api-cc", "api-cc", "api-cc", undefined]);
  });

  it("round-robins across equal healthy accounts instead of filling high-concurrency accounts first", async () => {
    dbMock.state.accounts = Array.from({ length: 10 }, (_, index) => ({
      ...makeAccount(index + 1),
      concurrency: 50,
    }));

    const selected: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      if (result?.memberId) selected.push(result.memberId);
    }

    expect(new Set(selected).size).toBe(10);
    expect(selected).toEqual([
      "acct-1",
      "acct-2",
      "acct-3",
      "acct-4",
      "acct-5",
      "acct-6",
      "acct-7",
      "acct-8",
      "acct-9",
      "acct-10",
    ]);
  });

  it("skips a candidate when its last acquired time changed before row lock", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        concurrency: 50,
        lastAcquiredAt: null,
      },
      {
        ...makeAccount(2),
        concurrency: 50,
        lastAcquiredAt: new Date(2026, 0, 1, 0, 0, 0),
      },
    ];
    dbMock.state.lockedLastAcquiredAtById.set(
      "acct-1",
      new Date(2026, 0, 1, 0, 0, 1)
    );

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.memberId).toBe("acct-2");
  });

  it("reselects when every candidate in the first snapshot is stale", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        concurrency: 50,
        lastAcquiredAt: null,
      },
      {
        ...makeAccount(2),
        concurrency: 50,
        lastAcquiredAt: null,
      },
    ];
    dbMock.state.lockedLastAcquiredAtById.set(
      "acct-1",
      new Date(2026, 0, 1, 0, 0, 1)
    );
    dbMock.state.lockedLastAcquiredAtById.set(
      "acct-2",
      new Date(2026, 0, 1, 0, 0, 2)
    );

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.memberId).toBe("acct-1");
  });

  it("tries the sticky previous-response backend before normal scheduling", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        priority: 1,
        createdAt: new Date(2026, 0, 1),
      },
      {
        ...makeAccount(2),
        priority: 99,
        createdAt: new Date(2026, 0, 2),
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
      preferredMemberId: "acct-2",
      preferredMemberType: "account",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-2");
  });

  it("uses persisted previous-response sticky bindings before request preferences", async () => {
    dbMock.state.accounts = [makeAccount(1), makeAccount(2)];
    dbMock.state.stickyBindings = [
      {
        memberType: "account",
        memberId: "acct-2",
        groupId: "group-a",
        accountBackend: "responses",
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
      stickyPreviousResponseId: "resp-a",
      preferredMemberId: "acct-1",
      preferredMemberType: "account",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-2");
    expect(result?.schedulerLayer).toBe("previous_response_id");
  });

  it("records scheduler selection metrics", async () => {
    dbMock.state.accounts = [makeAccount(1)];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
    });

    expect(result?.memberId).toBe("acct-1");
    const metricInsert = dbMock.state.inserts.find(
      (item) => item.tableName === "image_backend_scheduler_metric"
    );
    expect(metricInsert?.values).toMatchObject({
      requestKind: "responses",
      selectedLayer: "load_balance",
      memberType: "account",
      memberId: "acct-1",
      selectCount: 1,
    });
  });

  it("uses scheduler health metadata to demote unhealthy peers at the same priority", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        priority: 10,
        metadata: {
          scheduler: {
            errorEwma: 0.9,
            durationMsEwma: 180_000,
            failStreak: 5,
          },
        },
      },
      {
        ...makeAccount(2),
        priority: 10,
        metadata: {
          scheduler: {
            errorEwma: 0.05,
            durationMsEwma: 20_000,
            successStreak: 3,
          },
        },
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-2");
  });

  it("uses the platform default group for API keys without an explicit group", async () => {
    dbMock.state.groups = [
      {
        id: "default-group",
        name: "Default",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "api-group",
        name: "API",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: false,
        contentSafetyEnabled: true,
        priority: 10,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.externalApiKeys = [{ id: "key-a", generationGroupId: null }];
    dbMock.state.userPreferences = [{ userId: "user-a", groupId: "api-group" }];
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        matchedGroupId: "default-group",
        groupId: "default-group",
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      apiKeyId: "key-a",
      requestKind: "image_generation",
    });

    expect(result?.groupId).toBe("default-group");
    expect(result?.config.backend?.billingGroupId).toBe("default-group");
  });

  it("ignores stale user preferences that point to non-selectable groups", async () => {
    dbMock.state.groups = [
      {
        id: "default-group",
        name: "Default",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "api-group",
        name: "API",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: false,
        contentSafetyEnabled: true,
        priority: 10,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.userPreferences = [{ userId: "user-a", groupId: "api-group" }];
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        matchedGroupId: "default-group",
        groupId: "default-group",
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.groupId).toBe("default-group");
    expect(result?.config.backend?.billingGroupId).toBe("default-group");
  });

  it("uses the images upstream switch for responses-only API image requests", async () => {
    const baseApi = {
      id: "api-1",
      groupId: "group-a",
      name: "External Responses",
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      model: "external-chat-model",
      interfaceMode: "responses",
      chatCompletionsUpstreamMode: "responses",
      useStream: false,
      contentSafetyEnabled: true,
      priority: 1,
      concurrency: 1,
      lastUsedAt: null,
      createdAt: new Date(2026, 0, 1),
    };
    dbMock.state.accounts = [];
    dbMock.state.apis = [{ ...baseApi, imageUpstreamMode: "images" }];

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      })
    ).resolves.toBeNull();

    dbMock.state.apis = [{ ...baseApi, imageUpstreamMode: "responses" }];
    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.memberType).toBe("api");
    expect(result?.memberId).toBe("api-1");
    expect(result?.config.backend).toMatchObject({
      apiInterfaceMode: "responses",
      imagesUpstreamMode: "responses",
    });
  });

  it("can borrow any Responses backend when the requested group is Web-only", async () => {
    dbMock.state.groups = [
      {
        id: "web-group",
        name: "Web only",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "web" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "codex-group",
        name: "Codex repair",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 2,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        matchedGroupId: "codex-group",
        groupId: "codex-group",
      },
    ];

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "responses",
      })
    ).resolves.toBeNull();

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
      accountBackendPreference: "responses",
      allowAnyResponsesBackend: true,
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-1");
    expect(result?.groupId).toBe("codex-group");
  });

  it("continues within the same group after a non-Web member when spanning groups", async () => {
    dbMock.state.groups = [
      {
        ...dbMock.state.groups[0],
        name: "Web prompt repair",
        metadata: { backendType: "web" },
      },
    ];
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        implementationMode: "web",
        priority: 2,
        metadata: {
          webAccount: { type: "plus", quota: 3, status: "active" },
        },
      },
    ];
    dbMock.state.apis = [
      {
        id: "api-first",
        matchedGroupId: "group-a",
        groupId: "group-a",
        name: "Web group API",
        baseUrl: "https://api.example.test/v1",
        apiKey: "key",
        model: null,
        interfaceMode: "mixed",
        chatCompletionsUpstreamMode: "responses",
        imageUpstreamMode: "responses",
        useStream: false,
        adobeSourced: false,
        billingMultiplier: 1,
        contentSafetyEnabled: true,
        alwaysActive: false,
        priority: 1,
        concurrency: 1,
        lastUsedAt: null,
        lastAcquiredAt: null,
        createdAt: new Date(2026, 0, 1),
        metadata: null,
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "chat",
      spanGroupsForWeb: true,
      webRequestMode: "text",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-1");
  });

  it("lets Web text requests use an image-quota-limited account", async () => {
    dbMock.state.groups = [
      {
        ...dbMock.state.groups[0],
        name: "Web prompt repair",
        metadata: { backendType: "web" },
      },
    ];
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        implementationMode: "web",
        status: "limited",
        cooldownUntil: new Date(Date.now() + 60_000),
        metadata: {
          webAccount: {
            type: "plus",
            quota: 0,
            status: "limited",
            restoreAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    ];

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "chat",
        spanGroupsForWeb: true,
      })
    ).resolves.toBeNull();

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "chat",
      spanGroupsForWeb: true,
      webRequestMode: "text",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-1");
    const leaseTouch = dbMock.state.updates.find(
      (item) =>
        item.tableName === "image_backend_account" &&
        "lastAcquiredAt" in item.values
    );
    expect(leaseTouch?.values).not.toHaveProperty("status");
    expect(leaseTouch?.values).not.toHaveProperty("cooldownUntil");
    expect(dbMock.state.accounts[0]).toMatchObject({
      status: "limited",
      cooldownUntil: expect.any(Date),
    });
  });

  it("does not consume cached Web image quota after a text-only success", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        implementationMode: "web",
        status: "limited",
        cooldownUntil: new Date(Date.now() + 60_000),
        lastError:
          "ChatGPTAgentToolRateLimitException image_gen.text2im rate limit",
        metadata: {
          webAccount: { type: "plus", quota: 3, status: "active" },
        },
      },
    ];

    await reportImageBackendResult({
      memberType: "account",
      memberId: "acct-1",
      success: true,
      consumeWebImageQuota: false,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_account"
    );
    expect(update?.values.metadata).toMatchObject({
      webAccount: {
        type: "plus",
        quota: 3,
        status: "active",
      },
    });
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("cooldownUntil");
    expect(update?.values).not.toHaveProperty("lastError");
    expect(dbMock.state.accounts[0]).toMatchObject({
      status: "limited",
      cooldownUntil: expect.any(Date),
      lastError:
        "ChatGPTAgentToolRateLimitException image_gen.text2im rate limit",
    });
  });

  it("reactivates limited accounts after a successful retry", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        status: "limited",
        cooldownUntil: new Date(2026, 0, 1),
      },
    ];

    await reportImageBackendResult({
      memberType: "account",
      memberId: "acct-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_account"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      metadata: expect.objectContaining({
        scheduler: expect.objectContaining({
          errorEwma: 0,
          successStreak: 1,
          failStreak: 0,
        }),
      }),
    });
  });

  it("updates scheduler EWMA metadata after failures", async () => {
    dbMock.state.accounts = [
      {
        ...makeAccount(1),
        metadata: {
          source: "sub2api_postgres",
          scheduler: {
            errorEwma: 0.25,
            durationMsEwma: 10_000,
            successStreak: 2,
          },
        },
      },
    ];

    await reportImageBackendResult({
      memberType: "account",
      memberId: "acct-1",
      success: false,
      error: "HTTP 500 upstream error",
      durationMs: 20_000,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_account"
    );
    expect(update?.values.metadata).toMatchObject({
      source: "sub2api_postgres",
      scheduler: {
        // EWMA alpha=0.4:0.25*0.6 + 1*0.4 = 0.55;10000*0.6 + 20000*0.4 = 14000。
        errorEwma: 0.55,
        durationMsEwma: 14_000,
        successStreak: 0,
        failStreak: 1,
        lastObservedAt: expect.any(String),
      },
    });
  });

  it("健康惩罚按 lastObservedAt 时间衰减:久未观测的旧故障号让位给刚失败的号之外、并随时间淡出复探", async () => {
    const now = Date.now();
    dbMock.state.accounts = [
      {
        // 刚刚失败(惩罚全额)→ 应被降级。
        ...makeAccount(1),
        priority: 10,
        metadata: {
          scheduler: {
            errorEwma: 0.9,
            failStreak: 5,
            lastObservedAt: new Date(now).toISOString(),
          },
        },
      },
      {
        // 同样的高错误率,但一小时前才观测到 → 惩罚已指数衰减趋 0 → 应被优先复探。
        ...makeAccount(2),
        priority: 10,
        metadata: {
          scheduler: {
            errorEwma: 0.9,
            failStreak: 5,
            lastObservedAt: new Date(now - 60 * 60_000).toISOString(),
          },
        },
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "responses",
    });

    expect(result?.memberType).toBe("account");
    expect(result?.memberId).toBe("acct-2");
  });

  it("reactivates limited API backends after a successful retry", async () => {
    dbMock.state.apis = [
      {
        id: "api-1",
        groupId: "group-a",
        status: "limited",
        cooldownUntil: new Date(2026, 0, 1),
      },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
    });
  });

  it("does not cool down external API backends after transient failures by default", async () => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("cooldownUntil");
  });

  it("cools down external API backends when the per-backend toggle is on", async () => {
    // 每后端开关(failureCooldownEnabled)取代旧全局 flag。
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", failureCooldownEnabled: true },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: expect.any(Date),
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
  });

  it("still marks external API backends as error for unrecoverable failures", async () => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "invalid api key authentication failed",
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "error",
      cooldownUntil: null,
      lastError: "invalid api key authentication failed",
      lastErrorAt: expect.any(Date),
    });
  });

  it.each([
    [
      "Upstream Responses API returned HTTP 500: 没有可用token | invalid_request_error",
    ],
    ["Upstream Responses API returned HTTP 502: HTML response body. Check ..."],
  ])("marks dead-relay errors as error (sticky out): %s", async (errText) => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: errText,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "error",
      cooldownUntil: null,
    });
  });

  it("keeps an errored API out: a later success does not reactivate it", async () => {
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", status: "error", alwaysActive: false },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    // 粘性：成功只记 successCount，不把 status 翻回 active、不清 error。
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("lastError");
  });

  it("always_active errored API still reactivates on success", async () => {
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", status: "error", alwaysActive: true },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({ status: "active", lastError: null });
  });

  it("selects a multi-group API from each of its groups", async () => {
    // 同一个 API 经 image_backend_api_group 同时挂在 group-a 与 group-b 两个分组。
    // 分别以两个分组为活动分组发起请求，都应能选中该 API，且 result.groupId 命中
    // 当前活动分组（matchedGroupId）。镜像账号多分组：DB-free 下 innerJoin 为 no-op，
    // 故由 matchedGroupId 表征本次命中的分组。
    dbMock.state.groups = [
      {
        id: "group-a",
        name: "Group A",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "group-b",
        name: "Group B",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 2,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.accounts = [];
    const baseApi = {
      id: "api-multi",
      groupId: "group-a",
      name: "Multi-group API",
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      model: null,
      interfaceMode: "mixed",
      chatCompletionsUpstreamMode: "responses",
      imageUpstreamMode: "images",
      useStream: false,
      contentSafetyEnabled: true,
      alwaysActive: false,
      priority: 1,
      concurrency: 10,
      lastUsedAt: null,
      lastAcquiredAt: null,
      createdAt: new Date(2026, 0, 1),
      metadata: null,
    };

    dbMock.state.apis = [{ ...baseApi, matchedGroupId: "group-a" }];
    const fromGroupA = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });
    expect(fromGroupA?.memberType).toBe("api");
    expect(fromGroupA?.memberId).toBe("api-multi");
    expect(fromGroupA?.groupId).toBe("group-a");

    dbMock.state.userPreferences = [{ userId: "user-a", groupId: "group-b" }];
    dbMock.state.apis = [{ ...baseApi, matchedGroupId: "group-b" }];
    const fromGroupB = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });
    expect(fromGroupB?.memberType).toBe("api");
    expect(fromGroupB?.memberId).toBe("api-multi");
    expect(fromGroupB?.groupId).toBe("group-b");
  });

  it("keeps account backend cooldown behavior unchanged", async () => {
    await reportImageBackendResult({
      memberType: "account",
      memberId: "acct-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_account"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: expect.any(Date),
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
  });

  it("always_active account does not cooldown or change status on failure", async () => {
    dbMock.state.accounts = [{ ...makeAccount(1), alwaysActive: true }];

    await reportImageBackendResult({
      memberType: "account",
      memberId: "acct-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_account"
    );
    // 常驻账号:失败只记 failCount/lastError,不改 status、不进冷却。
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("cooldownUntil");
    expect(update?.values).toMatchObject({
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
  });

  // adobe 作为特殊 firefly account 成员参与分组调度的路由语义。
  describe("adobe firefly group-based routing", () => {
    beforeEach(() => {
      // 用 responses 分组：responses 账号与 adobe 同组,普通 image_generation 请求两者皆候选。
      dbMock.state.accounts = [makeAccount(1)];
      dbMock.state.adobes = [makeAdobe(1)];
    });

    it("普通图像请求同组含 adobe 与 account 时,二者都是候选(adobe 不被排除)", async () => {
      // account priority=10、adobe priority=10 同层；两者同 createdAt 排序,account 在前
      // (apiMembers→accountMembers→adobeMembers 拼接顺序),故首选 account,但 adobe 仍在候选池。
      const first = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      const second = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });

      const picked = [first, second].map(
        (r) => `${r?.memberType}:${r?.memberId}`
      );
      // 两个候选都被选中(并发各 1),证明 adobe 与 account 同池参与,adobe 未被排除。
      expect(picked).toContain("account:acct-1");
      expect(picked).toContain("adobe:adobe-1");
    });

    it("低优先级 adobe 仅作兜底:account 优先,account 饱和后才落 adobe", async () => {
      dbMock.state.accounts = [
        { ...makeAccount(1), priority: 1, concurrency: 1 },
      ];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const first = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      const second = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });

      expect(first?.memberType).toBe("account");
      expect(first?.memberId).toBe("acct-1");
      // account 并发饱和后,低优先级 adobe 兜底入选。
      expect(second?.memberType).toBe("adobe");
      expect(second?.memberId).toBe("adobe-1");
    });

    it("force_firefly 时只有 adobe 是候选(account 被排除)", async () => {
      dbMock.state.accounts = [{ ...makeAccount(1), priority: 1 }];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        forceFirefly: true,
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
    });

    it("force_firefly 但同组无 adobe 时无可用后端(不回落 account)", async () => {
      dbMock.state.accounts = [makeAccount(1)];
      dbMock.state.adobes = [];

      await expect(
        resolveImageBackendPoolConfig({
          userId: "user-a",
          requestKind: "image_generation",
          forceFirefly: true,
        })
      ).resolves.toBeNull();
    });

    it("firefly-* 模型只有 adobe 是候选(account 被排除)", async () => {
      dbMock.state.accounts = [{ ...makeAccount(1), priority: 1 }];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-nano-banana-pro",
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
    });

    it("把 fireflyOnly 盖在解析结果 config 上(供换号重试保持只走 Adobe)", async () => {
      dbMock.state.accounts = [{ ...makeAccount(1), priority: 1 }];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      // firefly-* 模型:fireflyOnly 盖 true,且只选到 adobe。
      const firefly = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-nano-banana-pro",
      });
      expect(firefly?.memberType).toBe("adobe");
      expect(firefly?.config.backend?.fireflyOnly).toBe(true);

      // force_firefly 同样盖 true。
      const forced = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        forceFirefly: true,
      });
      expect(forced?.config.backend?.fireflyOnly).toBe(true);

      // 普通请求不盖(undefined/false)。
      dbMock.state.accounts = [makeAccount(1)];
      dbMock.state.adobes = [];
      const normal = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      expect(normal?.config.backend?.fireflyOnly).toBeFalsy();
    });
  });
});
