/** PL-06：真实 operations 和 service 编排，仅替换账本、调度和上游，禁止网络外呼。 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./types";

const state = vi.hoisted(() => ({
  initial: {} as ApiConfig,
  debit: vi.fn(),
  refund: vi.fn(),
  web: vi.fn(),
  fetch: vi.fn(),
  resolve: vi.fn(),
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        state.inserts.push(row);
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: row.id }],
          }),
        };
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(row);
          return Object.assign(Promise.resolve([]), {
            returning: async () => [],
          });
        },
      }),
    }),
  },
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@repo/shared/credits/core", () => ({ consumeCredits: state.debit }));
vi.mock("@repo/shared/generation-maintenance", () => ({
  IMAGE_GENERATION_PENDING_TIMEOUT_MS: 1_200_000,
  refundGenerationCredits: state.refund,
  resolveImageGenerationTimeoutError: () => "timeout",
}));
vi.mock("@repo/shared/moderation", () => ({
  isContentModerationEnabled: async () => false,
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({ putObject: vi.fn() }),
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: async () => true,
  getPlanCapabilitySnapshot: async () => ({
    features: new Proxy({}, { get: () => true }),
    limits: { maxBatchCount: 10, maxChatContextChars: 10000 },
    billing: { chatRoundCredits: 1, agentRoundCredits: 2 },
  }),
  getPlanQueueSettings: async () => ({
    priority: "normal",
    userConcurrency: 10,
  }),
  normalizePlanModerationBlockRiskLevel: async () => "low",
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: async () => false,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
  getRuntimeSettingString: async () => "",
}));
vi.mock("@/features/image-backend-pool/service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveImageBackendPoolConfig: state.resolve,
  reportImageBackendResult: vi.fn(async () => ({ switchable: true })),
  releaseImageBackendInflightLease: vi.fn(),
  recordImageBackendSchedulerSwitch: vi.fn(),
}));
vi.mock("@/features/external-api/quota", () => ({
  reserveExternalApiKeyCredits: vi.fn(),
  refundExternalApiKeyCredits: vi.fn(),
}));
vi.mock("./queue", () => ({
  estimateImageGenerationQueueBytes: () => 0,
  withImageGenerationQueue: async (
    _options: unknown,
    run: () => Promise<unknown>
  ) => run(),
}));
vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserApiConfig: async () => null,
  getEffectiveConfig: async () => ({ config: state.initial, useCredits: true }),
}));
vi.mock("./chatgpt-web", () => ({
  generateImageWithChatGptWeb: state.web,
  editImageWithChatGptWeb: state.web,
  chatWithChatGptWeb: state.web,
}));
vi.mock("./generated-image", () => ({
  readGeneratedImage: async () => {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.writeUInt32BE(0x0d0a1a0a, 4);
    buffer.writeUInt32BE(1024, 16);
    buffer.writeUInt32BE(1024, 20);
    return buffer;
  },
}));
vi.mock("./image-restoration", () => ({}));
vi.mock("./resolution-calibration", () => ({}));
vi.mock("./transparent-fallback", () => ({
  isTransparentUnsupportedError: () => false,
}));

import { runImageGenerationForUser } from "./operations";
import { refundExternalApiKeyCredits } from "@/features/external-api/quota";
import { generateImage, editImage, generateChatImage } from "./service";
import {
  getImageCreditCostBreakdown,
  roundCreditAmount,
  roundUpCreditAmount,
} from "./resolution";

/** 固定混合组的已预留成员；伪凭据用于验证快照白名单。 */
function member(
  id: string,
  multiplier: number,
  accountBackend: "web" | "responses" = "web"
): ApiConfig & { backend: NonNullable<ApiConfig["backend"]> } {
  return {
    baseUrl: "https://upstream.invalid/v1",
    apiKey: "secret-test-key",
    backend: {
      type: "pool-account",
      id,
      groupId: `group-${id}`,
      billingGroupId: "mixed-parent",
      groupBackendType: "mixed",
      billingMultiplier: multiplier,
      accountBackend,
      userId: "owner",
      requestKind: "image_generation",
      priority: 50,
      reportResult: true,
      inflightLease: true,
      inflightLeaseId: `private-lease-${id}`,
    },
  };
}
const input = {
  mode: "generate" as const,
  userId: "owner",
  generationId: "billing-task",
  prompt: "circle",
  model: "gpt-image-2",
  size: "1024x1024",
  quality: "high" as const,
};
const baseCredits = getImageCreditCostBreakdown(input.size, {
  textModerationCount: 0,
}).totalCredits;

/** 提取真实 Drizzle JSON 拼接中的最终 metadata，验证实际落库内容。 */
function finalMetadata(): Record<string, unknown> {
  const sql = state.updates.findLast(
    (row) => row.status === "completed" || row.status === "failed"
  )?.metadata as SQL;
  const value = new PgDialect()
    .sqlToQuery(sql)
    .params.find(
      (param) => typeof param === "string" && param.includes("billing")
    );
  return JSON.parse(String(value)) as Record<string, unknown>;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.inserts.length = 0;
  state.updates.length = 0;
  state.initial = member("web", 2);
  state.debit.mockReset().mockResolvedValue({ success: true });
  state.refund
    .mockReset()
    .mockImplementation(
      async (params: {
        amount: number;
        metadata?: { previousCredits?: number };
      }) => ({
        refunded: true,
        amount: params.amount,
        remainingDebited: roundCreditAmount(
          Math.max(0, (params.metadata?.previousCredits ?? 0) - params.amount)
        ),
      })
    );
  state.web
    .mockReset()
    .mockResolvedValue({ error: "HTTP 429: usage_limit_reached" });
  state.resolve.mockReset().mockResolvedValue(null);
  state.fetch.mockReset().mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", state.fetch);
  vi.stubEnv("BETTER_AUTH_SECRET", "billing-test-secret");
});

describe("按最终实际成员计价", () => {
  it("本地原扣 10，其他路径已退 8，本次封顶退 2 后 generation 记录权威净额 0", async () => {
    state.initial = member("origin", 7.87);
    state.resolve.mockResolvedValueOnce({ config: member("cheap", 0.5) });
    state.web
      .mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" })
      .mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    state.refund.mockResolvedValueOnce({
      refunded: true,
      amount: 2,
      remainingDebited: 0,
    });
    const result = await runImageGenerationForUser({
      ...input,
      apiKeyId: "new-key-reservation",
    });
    expect(state.debit.mock.calls[0]?.[0].amount).toBe(10);
    expect(result.creditsConsumed).toBe(0);
    expect(
      state.updates.findLast((row) => row.status === "completed")
        ?.creditsConsumed
    ).toBe(0);
    expect(refundExternalApiKeyCredits).not.toHaveBeenCalled();
  });
  it.each([
    { refunded: false, amount: 0, remainingDebited: 1.2 },
    { refunded: true, amount: 0.5, remainingDebited: 0.1 },
  ])("退款结果为 %o 时按权威净额覆盖本地计数，Key 交给退款事务", async (refund) => {
    state.resolve.mockResolvedValueOnce({ config: member("cheap", 0.5) });
    state.web
      .mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" })
      .mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    state.refund.mockResolvedValueOnce(refund);
    const result = await runImageGenerationForUser({
      ...input,
      apiKeyId: "key-owned",
    });
    expect(result.error).toBeUndefined();
    expect(result.creditsConsumed).toBe(refund.remainingDebited);
    expect(refundExternalApiKeyCredits).not.toHaveBeenCalled();
  });
  it.each([
    4, 0.5,
  ])("Web 回退 Codex 按实际 %s 倍补扣或退差，并记录两份快照", async (multiplier) => {
    state.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce({
      config: member("codex", multiplier, "responses"),
    });
    const result = await runImageGenerationForUser(input);
    expect(result.error).toBeUndefined();
    expect(state.web).toHaveBeenCalledTimes(1);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(result.creditsConsumed).toBe(
      roundUpCreditAmount(baseCredits * multiplier)
    );
    expect(state.debit.mock.calls[0]?.[0].amount).toBe(baseCredits * 2);
    const metadata = finalMetadata();
    expect(metadata.initialBilling).toMatchObject({
      backendId: "web",
      billingMultiplier: 2,
      groupId: "group-web",
    });
    expect(metadata.actualBilling).toMatchObject({
      backendId: "codex",
      accountBackend: "responses",
      billingMultiplier: multiplier,
      billingGroupId: "mixed-parent",
    });
    const ledger =
      multiplier > 2
        ? state.debit.mock.calls[1]?.[0]
        : state.refund.mock.calls[0]?.[0];
    expect(ledger.amount).toBe(
      roundCreditAmount(
        Math.abs(
          roundUpCreditAmount(baseCredits * multiplier) - baseCredits * 2
        )
      )
    );
    expect(ledger.metadata).toMatchObject({
      initialBilling: metadata.initialBilling,
      actualBilling: metadata.actualBilling,
    });
  });

  it.each([
    false,
    true,
  ])("换号后按实际成员和出站模型、原请求质量计价：%s", async (qualityTable) => {
    const actual = member("api", 3);
    actual.modelMapping = [
      { from: "gpt-image-2", to: "upstream-image-high", setQuality: "medium" },
    ];
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      qualityBilling: { high: 9, medium: 7 },
      modelBilling: {
        "upstream-image-high": qualityTable ? { high: 8, medium: 4 } : 2,
      },
    };
    state.resolve.mockResolvedValueOnce({ config: actual });
    const result = await runImageGenerationForUser({
      ...input,
      forceWebBackend: false,
      mixWebFirst: false,
    });
    expect(result.error).toBeUndefined();
    const sent = JSON.parse(state.fetch.mock.calls[0]?.[1].body as string);
    expect(sent).toMatchObject({
      model: "upstream-image-high",
      quality: "medium",
    });
    const multiplier = qualityTable ? 24 : 54;
    expect(result.creditsConsumed).toBe(baseCredits * multiplier);
    expect(finalMetadata().actualBilling).toMatchObject({
      outboundModel: sent.model,
      outboundQuality: sent.quality,
      billingQuality: "high",
      billingMultiplier: multiplier,
      backendBillingMultiplier: 3,
      poolApiModelBillingMultiplier: qualityTable ? 8 : 2,
      qualityBillingMultiplier: qualityTable ? 1 : 9,
      poolApiModelBillingReplacesQuality: qualityTable,
    });
  });

  it.each([
    generateImage,
    (config: ApiConfig, params: typeof input) =>
      editImage(config, { ...params, images: [] }),
    (config: ApiConfig, params: typeof input) =>
      generateChatImage(config, { ...params, model: "gpt-5.5", webChat: true }),
  ])("各服务入口返回白名单快照，不泄露凭据或租约 %#", async (entry) => {
    state.web.mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    const result = await entry(state.initial, input);
    expect(result).toHaveProperty("billingSnapshot");
    const snapshot = (
      result as unknown as { billingSnapshot: Record<string, unknown> }
    ).billingSnapshot;
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "accountBackend",
        "backendId",
        "backendType",
        "billingGroupId",
        "billingMultiplier",
        "billingQuality",
        "groupId",
        "outboundModel",
        "outboundQuality",
        "requestedQuality",
        "backendBillingMultiplier",
        "poolApiModelBillingMultiplier",
        "qualityBillingMultiplier",
        "poolApiModelBillingReplacesQuality",
      ].sort()
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /secret-test-key|private-lease|apiKey|inflight|headers|baseUrl/
    );
  });

  it("纯文字成功沿用原聊天费用", async () => {
    state.web.mockResolvedValueOnce({ responseText: "hello" });
    const result = await runImageGenerationForUser({
      ...input,
      mode: "chat",
      model: "gpt-5.5",
      webChat: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.creditsConsumed).toBe(2);
  });

  it("同价换号也将实际快照回填原扣费账本", async () => {
    state.resolve.mockResolvedValueOnce({ config: member("same-price", 2) });
    state.web
      .mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" })
      .mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    const result = await runImageGenerationForUser(input);
    expect(result.error).toBeUndefined();
    expect(state.debit).toHaveBeenCalledTimes(1);
    expect(state.refund).not.toHaveBeenCalled();
    const audit = state.updates.find((row) => row.metadata && !row.status);
    expect(audit).toBeDefined();
    if (!audit) throw new Error("Missing ledger billing audit");
    const query = new PgDialect().sqlToQuery(audit.metadata as SQL);
    expect(query.sql).toContain("::json)::jsonb");
    expect(JSON.parse(String(query.params[0]))).toMatchObject({
      initialBilling: { backendId: "web" },
      actualBilling: { backendId: "same-price" },
      settledCredits: baseCredits * 2,
    });
  });

  it("聊天出图的轮次费与图片费都按实际成员结算", async () => {
    state.resolve.mockResolvedValueOnce({ config: member("chat", 4) });
    state.web
      .mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" })
      .mockResolvedValueOnce({ imageBase64: "aW1hZ2U=", agentRoundCount: 2 });
    const result = await runImageGenerationForUser({
      ...input,
      mode: "chat",
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
    });
    expect(result.error).toBeUndefined();
    expect(state.debit.mock.calls[0]?.[0].amount).toBe(2);
    expect(result.creditsConsumed).toBe(8 + baseCredits * 4);
  });

  it("更贵后端补扣失败沿现有失败结算，不宣称已预留潜在回退费用", async () => {
    state.resolve.mockResolvedValueOnce({ config: member("expensive", 4) });
    state.web
      .mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" })
      .mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    state.debit
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("Insufficient credits"));
    const result = await runImageGenerationForUser(input);
    expect(result.error).toBe("Insufficient credits");
    expect(result.creditsConsumed).toBe(0);
    expect(state.refund.mock.calls[0]?.[0].amount).toBe(baseCredits * 2);
    expect(finalMetadata().actualBilling).toMatchObject({
      backendId: "expensive",
    });
  });

  it.each([
    "low",
    undefined,
  ] as const)("raw Responses 显式工具质量优先，缺省沿用请求质量：%s", async (toolQuality) => {
    const actual = member("raw", 3, "responses");
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      apiInterfaceMode: "responses",
      modelBilling: { "gpt-image-2": { low: 4, high: 8 } },
      qualityBilling: { low: 9 },
    };
    state.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [{ type: "image_generation_call", result: "aW1hZ2U=" }],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await generateChatImage(actual, {
      prompt: "circle",
      model: "gpt-5.5",
      quality: "high",
      rawResponsesBody: {
        tools: [
          {
            type: "image_generation",
            model: "gpt-image-2",
            quality: toolQuality,
          },
        ],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      billingSnapshot: {
        outboundModel: "gpt-image-2",
        requestedQuality: "high",
        billingQuality: toolQuality ?? "high",
        outboundQuality: toolQuality ?? "high",
        billingMultiplier: toolQuality === "low" ? 12 : 24,
        qualityBillingMultiplier: 1,
      },
    });
  });

  it.each([
    "images",
    "responses",
  ])("API 改图快照取最终 %s 请求体，不能重新猜测映射结果", async (mode) => {
    const actual = member("mapped-edit", 3);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      apiInterfaceMode: mode as "images" | "responses",
      imagesUpstreamMode: mode as "images" | "responses",
      modelBilling: { "gpt-image-2-final": { high: 4, low: 8 } },
    };
    actual.modelMapping = [
      {
        from: "gpt-image-2",
        to: "gpt-image-2-intermediate",
        setQuality: "medium",
      },
      {
        from: "gpt-image-2-intermediate",
        to: "gpt-image-2-final",
        whenQuality: "medium",
        setQuality: "low",
      },
    ];
    if (mode === "responses")
      state.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [{ type: "image_generation_call", result: "aW1hZ2U=" }],
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    const result = await editImage(actual, { ...input, images: [] });
    expect(result.error).toBeUndefined();
    const body = state.fetch.mock.calls[0]?.[1].body;
    const sent =
      mode === "images"
        ? {
            model: (body as FormData).get("model"),
            quality: (body as FormData).get("quality"),
          }
        : JSON.parse(body as string).tools[0];
    expect(result).toMatchObject({
      billingSnapshot: {
        outboundModel: sent.model,
        outboundQuality: sent.quality,
        requestedQuality: "high",
        billingQuality: "high",
        billingMultiplier: 12,
      },
    });
  });

  it("失败及无图沿用原费用政策", async () => {
    state.web.mockResolvedValueOnce({ responseText: "no image" });
    const result = await runImageGenerationForUser(input);
    expect(result.error).toMatch(/no image/i);
    expect(result.creditsConsumed).toBe(0);
    expect(state.refund.mock.calls[0]?.[0].amount).toBe(baseCredits * 2);
  });

  it("初始预扣和实际同成员均只乘一次后端、数字模型和质量分量", async () => {
    const actual = member("same-api", 2);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      modelBilling: { "gpt-image-2": 3 },
      qualityBilling: { high: 5 },
    };
    state.initial = actual;
    const result = await runImageGenerationForUser(input);
    expect(result.error).toBeUndefined();
    expect(result.creditsConsumed).toBe(baseCredits * 30);
    expect(state.debit).toHaveBeenCalledTimes(1);
    expect(
      state.debit.mock.calls[0]?.[0].metadata.initialBilling
    ).toMatchObject({
      backendBillingMultiplier: 2,
      poolApiModelBillingMultiplier: 3,
      qualityBillingMultiplier: 5,
      billingMultiplier: 30,
    });
  });

  it.each([
    { quality: "high", outgoingQuality: "low", qualityTable: false },
    { quality: "low", outgoingQuality: "high", qualityTable: false },
    { quality: "high", outgoingQuality: "low", qualityTable: true },
    { quality: "low", outgoingQuality: "high", qualityTable: true },
  ] as const)("同成员 mapping $quality→$outgoingQuality 不改变请求质量价格，模型表=$qualityTable", async ({
    quality,
    outgoingQuality,
    qualityTable,
  }) => {
    const actual = member("same-api", 2);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      qualityBilling: { high: 5, low: 2 },
      modelBilling: {
        "gpt-image-2": qualityTable ? { high: 8, low: 4 } : 3,
      },
    };
    actual.modelMapping = [
      {
        from: "gpt-image-2",
        to: "gpt-image-2",
        setQuality: outgoingQuality,
      },
    ];
    state.initial = actual;
    const result = await runImageGenerationForUser({ ...input, quality });
    const multiplier = qualityTable
      ? 2 * (quality === "high" ? 8 : 4)
      : 2 * 3 * (quality === "high" ? 5 : 2);
    expect(result.error).toBeUndefined();
    expect(result.creditsConsumed).toBe(baseCredits * multiplier);
    expect(state.debit).toHaveBeenCalledTimes(1);
    expect(state.refund).not.toHaveBeenCalled();
    expect(
      JSON.parse(state.fetch.mock.calls[0]?.[1].body as string)
    ).toMatchObject({
      quality: outgoingQuality,
    });
    expect(finalMetadata().actualBilling).toMatchObject({
      backendId: "same-api",
      requestedQuality: quality,
      billingQuality: quality,
      outboundQuality: outgoingQuality,
      billingMultiplier: multiplier,
    });
  });

  it.each([
    "generate",
    "edit",
    "chat",
  ] as const)("Web %s 按请求 max 质量计价，保留出站质量记录", async (mode) => {
    const actual = member("web", 2);
    actual.backend.qualityBilling = { high: 5, max: 9, low: 2 };
    actual.modelMapping = [
      {
        from: "gpt-image-2",
        to: "gpt-image-2",
        setQuality: "low",
      },
    ];
    state.initial = actual;
    state.web.mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    const params = { ...input, quality: "max" as const };
    const result =
      mode === "generate"
        ? await generateImage(state.initial, params)
        : mode === "edit"
          ? await editImage(state.initial, { ...params, images: [] })
          : await generateChatImage(state.initial, {
              ...params,
              model: "gpt-5.5",
              webChat: true,
            });
    expect(result.error).toBeUndefined();
    expect(result.billingSnapshot).toMatchObject({
      requestedQuality: "max",
      billingQuality: "max",
      outboundQuality: mode === "chat" ? "max" : "low",
      qualityBillingMultiplier: 9,
      billingMultiplier: 18,
    });
  });

  it("Chat Completions 未发送质量字段时仍按请求质量结算", async () => {
    const actual = member("chat-api", 2);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      chatCompletionsUpstreamMode: "chat_completions",
      qualityBilling: { high: 5 },
    };
    state.initial = actual;
    state.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          images: [{ b64_json: "aW1hZ2U=" }],
          choices: [{ message: { content: "image" } }],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await runImageGenerationForUser({
      ...input,
      mode: "chat",
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
    });
    expect(result.error).toBeUndefined();
    expect(result.creditsConsumed).toBe(10 + baseCredits * 10);
    expect(state.debit.mock.calls[0]?.[0].amount).toBe(10);
    expect(state.debit.mock.calls[1]?.[0].amount).toBe(baseCredits * 10);
    expect(finalMetadata().actualBilling).toMatchObject({
      requestedQuality: "high",
      billingQuality: "high",
      outboundQuality: null,
      billingMultiplier: 10,
    });
  });

  it("Responses 生成保留最终工具模型，但 mapping 不改请求质量价格", async () => {
    const actual = member("mapped-response", 3);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      apiInterfaceMode: "responses",
      imagesUpstreamMode: "responses",
      modelBilling: { "gpt-image-2-final": { high: 4, low: 8 } },
    };
    actual.modelMapping = [
      {
        from: "gpt-image-2",
        to: "gpt-image-2-intermediate",
        setQuality: "medium",
      },
      {
        from: "gpt-image-2-intermediate",
        to: "gpt-image-2-final",
        setQuality: "low",
      },
    ];
    state.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [{ type: "image_generation_call", result: "aW1hZ2U=" }],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await generateImage(actual, input);
    expect(result.error).toBeUndefined();
    const tool = JSON.parse(state.fetch.mock.calls[0]?.[1].body as string)
      .tools[0];
    expect(tool).toMatchObject({ model: "gpt-image-2-final", quality: "low" });
    expect(result.billingSnapshot).toMatchObject({
      outboundModel: tool.model,
      outboundQuality: tool.quality,
      requestedQuality: "high",
      billingQuality: "high",
      billingMultiplier: 12,
    });
  });

  it.each([
    { quality: "xhigh", modelMultiplier: 4 },
    { quality: "low", modelMultiplier: 1 },
  ] as const)("模型质量表按 $quality 回退或缺档时仍替代成员表", async ({
    quality,
    modelMultiplier,
  }) => {
    const actual = member("quality-api", 2);
    actual.backend = {
      ...actual.backend,
      type: "pool-api",
      accountBackend: undefined,
      modelBilling: { "gpt-image-2": { high: 4 } },
      qualityBilling: { high: 9, low: 8 },
    };
    const result = await generateImage(actual, { ...input, quality });
    expect(result.error).toBeUndefined();
    expect(result.billingSnapshot).toMatchObject({
      poolApiModelBillingMultiplier: modelMultiplier,
      qualityBillingMultiplier: 1,
      poolApiModelBillingReplacesQuality: true,
      billingMultiplier: 2 * modelMultiplier,
    });
  });
});
