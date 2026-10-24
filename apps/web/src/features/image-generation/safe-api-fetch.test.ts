/** 公共 API 传输离线测试：DNS/HTTPS 均为桩，核对真正连接地址及正文流。 */
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ default: { request: network.request } }));
vi.mock("node:http", () => ({ default: { request: network.request } }));
import {
  assertSafeApiBaseUrl,
  assertSafePoolApiBaseUrl,
  fetchApiRequest,
  safeApiFetch,
} from "./safe-api-fetch";

beforeEach(() => {
  vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", "");
  vi.resetAllMocks();
  network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  network.request.mockImplementation((_options, callback) => {
    const req = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    Object.assign(req, { setTimeout: vi.fn() });
    queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), {
        headers: { "content-type": "application/json" },
        statusCode: 200,
      });
      callback(res);
      res.end('{"data":[{"b64_json":"aW1hZ2U="}]}');
    });
    return req;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("safe API transport", () => {
  it("server-approved internal HTTP pool stays usable; user APIs cannot inherit that trust", async () => {
    vi.stubEnv(
      "IMAGE_BACKEND_TRUSTED_API_ORIGINS",
      "http://image.internal:8080"
    );
    network.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const config = {
      baseUrl: "http://image.internal:8080/v1",
      apiKey: "test-only",
      backend: { type: "pool-api" as const },
    };
    await assertSafePoolApiBaseUrl(config.baseUrl);
    const response = await fetchApiRequest(
      config,
      `${config.baseUrl}/images/generations`,
      { method: "POST", body: "{}" }
    );
    expect(response.ok).toBe(true);
    expect(network.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: "10.1.2.3",
      port: 8080,
      headers: { host: "image.internal:8080" },
    });
    await expect(assertSafeApiBaseUrl(config.baseUrl)).rejects.toThrow();
    await expect(
      fetchApiRequest(
        { ...config, backend: { type: "user-api" } },
        `${config.baseUrl}/responses`
      )
    ).rejects.toThrow();
    await expect(
      assertSafePoolApiBaseUrl("http://image.internal:8081/v1")
    ).rejects.toThrow();
    await expect(
      assertSafePoolApiBaseUrl("http://other.internal:8080/v1")
    ).rejects.toThrow();
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://*.internal:8080",
    "http://image.internal:8080/v1",
    "http://user:pass@image.internal:8080",
  ])("invalid server trust entries do not approve origins: %s", async (entry) => {
    vi.stubEnv("IMAGE_BACKEND_TRUSTED_API_ORIGINS", entry);
    await expect(
      assertSafePoolApiBaseUrl("http://image.internal:8080/v1")
    ).rejects.toThrow();
    expect(network.request).not.toHaveBeenCalled();
  });
  it.each([
    "http://api.example/v1",
    "https://user:pass@api.example/v1",
    "https://127.1/v1",
    "https://169.254.169.254/v1",
    "https://[::ffff:7f00:1]/v1",
    "https://[fe90::1]/v1",
    "https://[febf::1]/v1",
    "https://[2001:db8::1]/v1",
    "https://192.0.2.1/v1",
    "https://localhost./v1",
    "https://api.internal/v1",
  ])("rejects unsafe endpoint %s before sending", async (url) => {
    await expect(assertSafeApiBaseUrl(url)).rejects.toThrow();
    expect(network.request).not.toHaveBeenCalled();
  });

  it("rejects mixed public A/private AAAA and failed/empty DNS", async () => {
    for (const entries of [
      [],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:a00:1", family: 6 },
      ],
    ]) {
      network.lookup.mockResolvedValueOnce(entries);
      await expect(safeApiFetch("https://api.example/v1")).rejects.toThrow();
    }
    network.lookup.mockRejectedValueOnce(new Error("DNS failed secret"));
    await expect(
      assertSafeApiBaseUrl("https://api.example/v1")
    ).rejects.toThrow();
    expect(network.request).not.toHaveBeenCalled();
  });

  it("resolves once and actually connects to the checked IP with Host/SNI", async () => {
    network.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const response = await safeApiFetch(
      "https://api.example:8443/v1/responses",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-only", Host: "evil.example" },
        body: "{}",
      }
    );
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.lookup).toHaveBeenCalledWith("api.example", {
      all: true,
      verbatim: true,
    });
    expect(network.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: "93.184.216.34",
      servername: "api.example",
      port: 8443,
      path: "/v1/responses",
      rejectUnauthorized: true,
      headers: { host: "api.example:8443", authorization: "Bearer test-only" },
    });
    expect(await response.json()).toEqual({ data: [{ b64_json: "aW1hZ2U=" }] });
  });

  it("rejects every redirect without a second connection", async () => {
    network.request.mockImplementationOnce((_options, callback) => {
      const req = new Writable({
        write(_c, _e, done) {
          done();
        },
      });
      queueMicrotask(() =>
        callback(
          Object.assign(new PassThrough(), {
            statusCode: 307,
            headers: { location: "https://169.254.169.254/secret" },
          })
        )
      );
      return req;
    });
    await expect(safeApiFetch("https://api.example/v1")).rejects.toThrow(
      /redirect/i
    );
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it("supports multipart bodies and pre-aborted requests", async () => {
    const body = new FormData();
    body.set("image", new Blob(["pixels"]), "image.png");
    await safeApiFetch("https://api.example/v1/images/edits", {
      method: "POST",
      body,
    });
    expect(
      network.request.mock.calls[0]?.[0].headers["content-type"]
    ).toContain("multipart/form-data; boundary=");
    network.request.mockClear();
    await expect(
      safeApiFetch("https://api.example/v1", { signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(network.request).not.toHaveBeenCalled();
  });

  it("pool/user APIs share transport and cannot send credentials to another origin", async () => {
    for (const type of ["pool-api", "user-api"] as const) {
      const config = {
        baseUrl: "https://api.example/v1",
        apiKey: "test-only",
        backend: { type },
      };
      await expect(
        fetchApiRequest(config, "https://evil.example/v1")
      ).rejects.toThrow();
      const response = await fetchApiRequest(
        config,
        "https://api.example/v1/responses"
      );
      expect(response.ok).toBe(true);
    }
    expect(network.request).toHaveBeenCalledTimes(2);
  });
});
