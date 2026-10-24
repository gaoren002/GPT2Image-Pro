/**
 * DNS-pinning fetch 单元测试。
 *
 * 全部 mock dns 模块与 http/https 传输层，不发起真实网络请求。
 * 覆盖：公网 IP 放行、私有 IP 阻断、混合结果阻断、DNS 失败、Host 头设置，
 * 以及正文流式返回（响应头到齐即可读、超限销毁连接）与禁止正文的状态码。
 *
 * 响应桩使用真实 Readable：被测实现以 Readable.toWeb 把响应接成 Web 流（保留背压），
 * 裸 EventEmitter 无法反映该行为。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { Readable } from "node:stream";

// mock node:dns/promises
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock("node:http", () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

vi.mock("node:https", () => ({
  default: { request: vi.fn(), Agent: vi.fn() },
  request: vi.fn(),
  Agent: vi.fn(),
}));

import { resolve4, resolve6 } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import {
  DnsPinResponseTooLargeError,
  fetchWithDnsPin,
  SsrfBlockedError,
} from "./dns-pin";

const mockResolve4 = vi.mocked(resolve4);
const mockResolve6 = vi.mocked(resolve6);
// eslint-disable-next-line -- 类型断言简化 mock 签名匹配
const httpRequestMock = http.request as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line -- 类型断言简化 mock 签名匹配
const httpsRequestMock = https.request as unknown as ReturnType<typeof vi.fn>;

/**
 * 配置 mock transport 使其返回指定的响应。
 */
function setupMockTransport(
  mock: ReturnType<typeof vi.fn>,
  statusCode: number,
  responseBody: string,
  responseHeaders: Record<string, string> = {}
) {
  mock.mockImplementation(
    (
      _opts: unknown,
      callback: (res: Readable) => void
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      req.write = vi.fn();
      req.end = vi.fn().mockImplementation(() => {
        const res = new Readable({ read() {} }) as Readable & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        res.statusCode = statusCode;
        res.statusMessage = "OK";
        res.headers = responseHeaders;

        callback(res);

        queueMicrotask(() => {
          res.push(Buffer.from(responseBody));
          res.push(null);
        });
      });
      req.destroy = vi.fn();
      return req;
    }
  );
}

describe("fetchWithDnsPin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows public IP (8.8.8.8) and makes request correctly", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8"]);
    setupMockTransport(httpRequestMock, 200, "image-data", {
      "content-type": "image/png",
    });

    const response = await fetchWithDnsPin("http://example.com/image.png");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("image-data");
  });

  it("blocks private IP (192.168.1.1)", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.1"]);

    await expect(
      fetchWithDnsPin("http://example.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks loopback address (127.0.0.1)", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);

    await expect(
      fetchWithDnsPin("http://evil.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks link-local address (169.254.169.254)", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);

    await expect(
      fetchWithDnsPin("http://metadata.example.com/latest")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks IPv6 loopback (::1) via resolve6 fallback", async () => {
    mockResolve4.mockRejectedValue(new Error("ENODATA"));
    mockResolve6.mockResolvedValue(["::1"]);

    await expect(
      fetchWithDnsPin("http://evil-v6.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks mixed results (one public + one private)", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8", "192.168.1.1"]);

    await expect(
      fetchWithDnsPin("http://rebinding.evil.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws SsrfBlockedError when DNS resolution fails entirely", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(
      fetchWithDnsPin("http://nonexistent.invalid/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      fetchWithDnsPin("http://nonexistent.invalid/image.png")
    ).rejects.toThrow("DNS resolution failed");
  });

  it("sets Host header correctly with IP pinning transparent", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    let capturedOptions: RequestOptions | undefined;
    httpRequestMock.mockImplementation(
      (
        opts: unknown,
        callback: (res: EventEmitter) => void
      ) => {
        capturedOptions = opts as RequestOptions;
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn();
        req.end = vi.fn().mockImplementation(() => {
          const res = new Readable({ read() {} }) as Readable & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = {};
          callback(res);
          queueMicrotask(() => {
            res.push(Buffer.from("ok"));
            res.push(null);
          });
        });
        req.destroy = vi.fn();
        return req;
      }
    );

    await fetchWithDnsPin("http://example.com:8080/path?q=1");

    // hostname 被替换为 pinned IP
    expect(capturedOptions?.hostname).toBe("93.184.216.34");
    // Host 头保留原始主机名:端口
    expect(
      (capturedOptions?.headers as Record<string, string>)?.Host
    ).toBe("example.com:8080");
    // path 保留完整
    expect(capturedOptions?.path).toBe("/path?q=1");
    expect(capturedOptions?.port).toBe(8080);
  });

  it("sets servername for SNI on HTTPS requests", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    let capturedOptions: RequestOptions | undefined;
    httpsRequestMock.mockImplementation(
      (
        opts: unknown,
        callback: (res: EventEmitter) => void
      ) => {
        capturedOptions = opts as RequestOptions;
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn();
        req.end = vi.fn().mockImplementation(() => {
          const res = new Readable({ read() {} }) as Readable & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = {};
          callback(res);
          queueMicrotask(() => {
            res.push(Buffer.from("ok"));
            res.push(null);
          });
        });
        req.destroy = vi.fn();
        return req;
      }
    );

    await fetchWithDnsPin("https://secure.example.com/img.png");

    expect(
      (capturedOptions as Record<string, unknown>)?.servername
    ).toBe("secure.example.com");
    expect(capturedOptions?.hostname).toBe("93.184.216.34");
    expect(capturedOptions?.port).toBe(443);
  });

  it("validates IP literal directly without DNS lookup", async () => {
    setupMockTransport(httpRequestMock, 200, "ok");

    const response = await fetchWithDnsPin("http://8.8.4.4/image.png");
    expect(response.status).toBe(200);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("blocks private IP literal in URL", async () => {
    await expect(
      fetchWithDnsPin("http://10.0.0.1/secret")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("blocks 10.x.x.x range", async () => {
    mockResolve4.mockResolvedValue(["10.255.255.1"]);
    await expect(
      fetchWithDnsPin("http://evil.com/x")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks 0.0.0.0/8 range", async () => {
    mockResolve4.mockResolvedValue(["0.0.0.1"]);
    await expect(
      fetchWithDnsPin("http://evil.com/x")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks 172.16.0.0/12 range", async () => {
    mockResolve4.mockResolvedValue(["172.20.10.1"]);
    await expect(
      fetchWithDnsPin("http://evil.com/x")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks CGNAT 100.64.0.0/10 range", async () => {
    mockResolve4.mockResolvedValue(["100.100.100.1"]);
    await expect(
      fetchWithDnsPin("http://evil.com/x")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

/**
 * 正文流式返回与禁止正文状态的行为。
 *
 * 此前实现把所有 chunk 收进数组、到 end 事件才构造 Response：上层"流式限额"永远在
 * 正文全部进内存之后才生效，取消也无法中止传输；且对 204/304 以非 null 正文构造
 * Response 会在事件回调里抛 TypeError，Promise 永不结算。
 */
describe("fetchWithDnsPin 正文处理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 受控响应桩：手动推送 chunk，可观察连接是否被销毁。 */
  function setupControllableTransport() {
    const state = {
      push: (_chunk: Buffer) => {},
      finish: () => {},
      destroyed: false,
      responded: false,
    };
    httpRequestMock.mockImplementation(
      (_opts: unknown, callback: (res: Readable) => void) => {
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn();
        req.destroy = vi.fn().mockImplementation(() => {
          state.destroyed = true;
        });
        req.end = vi.fn().mockImplementation(() => {
          const res = new Readable({ read() {} }) as Readable & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = { "content-type": "image/png" };
          state.push = (chunk: Buffer) => res.push(chunk);
          state.finish = () => res.push(null);
          state.responded = true;
          callback(res);
        });
        return req;
      }
    );
    return state;
  }

  it("响应头到齐即返回，正文尚未传完也不阻塞", async () => {
    const state = setupControllableTransport();
    const response = await fetchWithDnsPin("http://cdn.example.com/a.png");
    // 一个 chunk 都还没推送就已拿到响应头。
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    state.push(Buffer.from("abc"));
    state.finish();
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("abc");
  });

  it("超过 maxBytes 时销毁连接并让正文流报错", async () => {
    const state = setupControllableTransport();
    const response = await fetchWithDnsPin("http://cdn.example.com/a.png", {
      maxBytes: 4,
    });
    state.push(Buffer.from("12345678"));
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(
      DnsPinResponseTooLargeError
    );
    expect(state.destroyed).toBe(true);
  });

  it("取消正文即销毁连接，不继续接收", async () => {
    const state = setupControllableTransport();
    const response = await fetchWithDnsPin("http://cdn.example.com/a.png");
    await response.body?.cancel();
    expect(state.destroyed).toBe(true);
  });

  it("204/304 等禁止正文的状态以 null 正文构造，Promise 正常结算", async () => {
    for (const status of [204, 304]) {
      setupMockTransport(httpRequestMock, status, "");
      const response = await fetchWithDnsPin(
        "http://callback.example.com/hook",
        { method: "POST", body: "{}" }
      );
      expect(response.status, String(status)).toBe(status);
      expect(response.body, String(status)).toBeNull();
    }
  });
});
