/**
 * AZ5 自定义 API 的保存/测试入口回归。
 * 保留真实 protectedAction、Zod、health-check、generation service 与 DNS pin；
 * 仅替换会话、套餐、DB、DNS 和 Node 传输，不连接数据库或外网。
 */
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  allowed: true,
  existing: false,
  addresses: [{ address: "93.184.216.34", family: 4 }],
  status: 200,
  location: "",
  requests: [] as HttpsRequestOptions[],
  bodies: [] as string[],
  lookup: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  select: vi.fn(),
  set: vi.fn(),
  values: vi.fn(),
  http: vi.fn(),
  https: vi.fn(),
  fetch: vi.fn(),
  capability: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@repo/shared/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        state.authenticated
          ? { user: { id: "starter-1", banned: false } }
          : null,
    },
  },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: vi.fn(),
}));
vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@repo/shared/monitoring", () => ({ captureError: vi.fn() }));
vi.mock("@repo/database", () => ({
  db: {
    select: state.select,
    update: () => ({ set: state.set }),
    insert: () => ({ values: state.values }),
  },
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "starter" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: state.capability,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: async () => false,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
  getRuntimeSettingString: async () => "",
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  bindImageBackendStickyMember: vi.fn(),
  ImageBackendPoolUnavailableError: class extends Error {},
  isImageBackendInfrastructureError: vi.fn(),
  isImageBackendSwitchableError: vi.fn(),
  isUnclassifiedBackendError: vi.fn(),
  recordImageBackendSchedulerSwitch: vi.fn(),
  releaseImageBackendInflightLease: vi.fn(),
  reportImageBackendResult: vi.fn(),
  resolveImageBackendPoolConfig: vi.fn(),
}));
vi.mock("@/features/image-generation/chatgpt-web", () => ({
  chatWithChatGptWeb: vi.fn(),
  editImageWithChatGptWeb: vi.fn(),
  generateImageWithChatGptWeb: vi.fn(),
}));
vi.mock("@/features/image-generation/rehost-input-images", () => ({
  ensureInputImageRehosted: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  lookup: state.lookup,
  resolve4: state.resolve4,
  resolve6: state.resolve6,
}));
vi.mock("node:http", () => ({ default: { request: state.http } }));
vi.mock("node:https", () => ({
  default: { request: state.https, Agent: class {} },
}));

import { checkImageBackendApiHealth } from "@/features/image-backend-pool/health-check";
import { saveApiConfig, testApiConfig } from "./api-config";

/** 模拟上游真实图像响应；返回 body 的解析由真实 generation service 完成。 */
function imageResponse() {
  return JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] });
}

/** 记录 Node 连接目标和请求正文，用真实 Readable 驱动 DNS pin 的响应处理。 */
function mockRequest(
  options: HttpsRequestOptions,
  callback: (response: Readable) => void
) {
  state.requests.push(options);
  const request = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        state.bodies.push(chunk.toString());
        done();
      },
    }),
    { setTimeout: vi.fn() }
  );
  request.on("finish", () => {
    const response = Object.assign(new Readable({ read() {} }), {
      statusCode: state.status,
      statusMessage: state.status === 200 ? "OK" : "Redirect",
      headers: {
        "content-type": "application/json",
        ...(state.location ? { location: state.location } : {}),
      },
    });
    callback(response);
    queueMicrotask(() => {
      response.push(Buffer.from(imageResponse()));
      response.push(null);
    });
  });
  return request;
}

/** 统一输入，避免 schema 缺少其他字段导致安全测试偶然通过。 */
function input(baseUrl: string) {
  return { baseUrl, apiKey: "test-api-key", model: "gpt-image-1" };
}

/** 所有拒绝场景都必须无 DB 访问、无普通 fetch、无 Node 连接。 */
function expectNoSideEffects() {
  expect(state.select).not.toHaveBeenCalled();
  expect(state.values).not.toHaveBeenCalled();
  expect(state.set).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.http).not.toHaveBeenCalled();
  expect(state.https).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  state.authenticated = true;
  state.allowed = true;
  state.existing = false;
  state.status = 200;
  state.location = "";
  state.addresses = [{ address: "93.184.216.34", family: 4 }];
  state.requests.length = 0;
  state.bodies.length = 0;
  state.capability.mockImplementation(async () => state.allowed);
  state.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (state.existing ? [{ id: "c1" }] : []),
      }),
    }),
  }));
  state.set.mockImplementation(() => ({ where: async () => undefined }));
  state.values.mockResolvedValue(undefined);
  state.lookup.mockImplementation(async () => state.addresses);
  state.resolve4.mockImplementation(async () =>
    state.addresses.filter((a) => a.family === 4).map((a) => a.address)
  );
  state.resolve6.mockImplementation(async () =>
    state.addresses.filter((a) => a.family === 6).map((a) => a.address)
  );
  state.http.mockImplementation(mockRequest);
  state.https.mockImplementation(mockRequest);
  // 修复前的普通 fetch 也返回合法图片，使红测明确暴露未走 pin，而非偶然网络失败。
  state.fetch.mockImplementation(
    async () =>
      new Response(imageResponse(), {
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", state.fetch);
  vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each([
  { name: "保存", run: saveApiConfig },
  { name: "测试", run: testApiConfig },
])("自定义 API $name 的公网校验", ({ run }) => {
  it.each([
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://0x7f000001/v1",
    "https://0177.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://169.254.169.254/v1",
    "https://100.64.0.1/v1",
    "https://100.100.100.200/v1",
    "https://100.127.255.254/v1",
    "https://[::]/v1",
    "https://[::1]/v1",
    "https://[fc00::1]/v1",
    "https://[fd00::10]/v1",
    "https://[fe80::1]/v1",
    "https://[fe90::1]/v1",
    "https://[febf::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:7f00:1]/v1",
    "https://[::ffff:6440:1]/v1",
    "https://name:password@93.184.216.34/v1",
    "http://93.184.216.34/v1",
    "ftp://93.184.216.34/v1",
    "https://localhost/v1",
    "https://metadata.google.internal/v1",
  ])("拒绝不安全地址 %s", async (baseUrl) => {
    const result = await run(input(baseUrl));
    expect(result?.data).toBeUndefined();
    expectNoSideEffects();
  });

  it.each([
    [{ address: "10.0.0.5", family: 4 }],
    [{ address: "fd00::10", family: 6 }],
    [{ address: "fe90::1", family: 6 }],
    [{ address: "::ffff:7f00:1", family: 6 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "100.100.100.200", family: 4 },
    ],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ],
    [],
  ])("拒绝私网、混合或空 DNS 结果 %#", async (...addresses) => {
    state.addresses = addresses;
    const result = await run(input("https://provider.example.test/v1"));
    expect(result?.data).toBeUndefined();
    expectNoSideEffects();
  });

  it("DNS 解析失败时关闭入口", async () => {
    state.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    state.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    state.resolve6.mockRejectedValue(new Error("ENOTFOUND"));
    expect(
      (await run(input("https://missing.example.test/v1")))?.data
    ).toBeUndefined();
    expectNoSideEffects();
  });

  it.each([
    "会话",
    "套餐",
  ])("%s 不允许时不解析 DNS、不读写配置、不测活", async (gate) => {
    state.authenticated = gate !== "会话";
    state.allowed = gate !== "套餐";
    expect(
      (await run(input("https://provider.example.test/v1")))?.data
    ).toBeUndefined();
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.resolve4).not.toHaveBeenCalled();
    expect(state.resolve6).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

describe("自定义 API 保存与真实测活", () => {
  it.each([
    false,
    true,
  ])("公网配置可以保存，existing=%s 且保存不发 HTTP", async (existing) => {
    state.existing = existing;
    const result = await saveApiConfig(
      input("  https://provider.example.test/v1  ")
    );
    expect(result?.data).toEqual({ success: true });
    const write = existing ? state.set : state.values;
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        baseUrl: "https://provider.example.test/v1",
        apiKey: "test-api-key",
        isActive: true,
      })
    );
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.http).not.toHaveBeenCalled();
    expect(state.https).not.toHaveBeenCalled();
  });

  it("真实 health-check/generation 请求连接到已校验 IP 并保留 Host/SNI", async () => {
    const result = await testApiConfig(
      input("https://provider.example.test:8443/v1")
    );
    expect(result?.data).toMatchObject({ ok: true, imageReturned: true });
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.https).toHaveBeenCalledTimes(1);
    expect(state.requests[0]).toMatchObject({
      hostname: "93.184.216.34",
      port: 8443,
      servername: "provider.example.test",
      method: "POST",
      path: "/v1/images/generations",
    });
    const headers = new Headers(
      state.requests[0]?.headers as Record<string, string>
    );
    expect(headers.get("host")).toBe("provider.example.test:8443");
    expect(headers.get("authorization")).toBe("Bearer test-api-key");
    expect(JSON.parse(state.bodies[0] ?? "{}")).toMatchObject({ n: 1 });
    expect(state.select).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(state.values).not.toHaveBeenCalled();
  });

  it("预检通过后 DNS 换成内网仍不连接", async () => {
    state.lookup
      .mockResolvedValueOnce(state.addresses)
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    state.resolve4.mockResolvedValue(["10.0.0.5"]);
    const result = await testApiConfig(input("https://rebind.example.test/v1"));
    expect(result?.data).toMatchObject({ ok: false, imageReturned: false });
    expectNoSideEffects();
  });

  it.each([301, 302, 303, 307, 308])("不跟随 %s 到内网", async (status) => {
    state.status = status;
    state.location = "https://169.254.169.254/latest/meta-data";
    const result = await testApiConfig(
      input("https://provider.example.test/v1")
    );
    expect(result?.data).toMatchObject({ ok: false, imageReturned: false });
    expect(state.https).toHaveBeenCalledTimes(1);
    expect(state.requests[0]?.hostname).toBe("93.184.216.34");
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.http).not.toHaveBeenCalled();
  });

  it.each([
    "http://10.0.0.5",
    "http://10.0.0.5:8080",
    "http://pool.internal:8080",
  ])("服务器显式受信的池 %s 保留内网 HTTP 并固定连接 IP", async (origin) => {
    vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", origin);
    state.addresses = [{ address: "10.0.0.5", family: 4 }];
    const result = await checkImageBackendApiHealth({
      ...input(`${origin}/v1`),
      backendType: "pool-api",
    });
    expect(result).toMatchObject({ ok: true, imageReturned: true });
    expect(state.http).toHaveBeenCalledTimes(1);
    expect(state.requests[0]).toMatchObject({
      hostname: "10.0.0.5",
      port: Number(new URL(origin).port || 80),
      path: "/v1/images/generations",
      method: "POST",
    });
    const headers = new Headers(
      state.requests[0]?.headers as Record<string, string>
    );
    expect(headers.get("host")).toBe(new URL(origin).host);
    expect(headers.get("authorization")).toBe("Bearer test-api-key");
    expect(JSON.parse(state.bodies[0] ?? "{}")).toMatchObject({ n: 1 });
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.https).not.toHaveBeenCalled();
  });

  it("普通 pool 配置不能自行把内网 HTTP 加入受信范围", async () => {
    const result = await checkImageBackendApiHealth({
      ...input("http://10.0.0.5:8080/v1"),
      backendType: "pool-api",
    });
    expect(result).toMatchObject({ ok: false, imageReturned: false });
    expectNoSideEffects();
  });

  it.each([
    "http://10.0.0.5:8081",
    "http://10.0.0.6:8080",
    "https://10.0.0.5:8080",
  ])("服务器受信配置必须精确匹配 origin，不允许相邻目标 %s", async (origin) => {
    vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", "http://10.0.0.5:8080");
    const result = await checkImageBackendApiHealth({
      ...input(`${origin}/v1`),
      backendType: "pool-api",
    });
    expect(result).toMatchObject({ ok: false, imageReturned: false });
    expectNoSideEffects();
  });

  it.each([
    "http://10.0.0.5:8080",
    "https://10.0.0.5:8080",
  ])("受信 pool origin %s 不改变用户 API 的公网 HTTPS 限制", async (origin) => {
    vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", origin);
    const result = await testApiConfig(input(`${origin}/v1`));
    expect(result?.data).toBeUndefined();
    const saved = await saveApiConfig(input(`${origin}/v1`));
    expect(saved?.data).toBeUndefined();
    const health = await checkImageBackendApiHealth({
      ...input(`${origin}/v1`),
      backendType: "user-api",
    });
    expect(health).toMatchObject({ ok: false, imageReturned: false });
    expectNoSideEffects();
  });
});
