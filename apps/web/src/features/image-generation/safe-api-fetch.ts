/**
 * 池 API 和用户 API 的统一公网 HTTPS 传输；保存校验与每次实际连接共用地址规则。
 * 单次 lookup(all) 后直接连接选定 IP，保留 Host/SNI 和证书校验，禁止重定向。
 * 用户 API 无内网例外；池内部 HTTP 仅允许服务器精确 origin 白名单，普通管理员不可扩权。
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ApiConfig } from "./types";

/** 固定错误摘要，不包含 URL、DNS 原文、请求正文或密钥。 */
export class UnsafeApiUrlError extends Error {
  constructor(message = "API URL must use public HTTPS.") {
    super(message);
    this.name = "UnsafeApiUrlError";
  }
}

/** 只接受可公网路由地址；IPv6 限全球单播并排除特殊用途/隧道地址。 */
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  // URL 规范化会把 IPv4 映射地址转为十六进制；全球单播限制同时拒绝全部映射形式。
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [first = "", second = "0"] = canonical.split(":");
  const prefix = Number.parseInt(first, 16);
  if (!(prefix >= 0x2000 && prefix <= 0x3fff)) return false;
  return !(
    prefix === 0x2002 ||
    prefix === 0x3fff ||
    (prefix === 0x2001 &&
      (Number.parseInt(second || "0", 16) < 0x200 || second === "db8"))
  );
}

/** 规范化 URL 并拒绝 URL 凭据、片段及本机/内部主机名；不发网络请求。 */
function parseApiUrl(rawUrl: string | URL, trustedPool = false): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UnsafeApiUrlError();
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    (url.protocol !== "https:" && !(trustedPool && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash ||
    (!trustedPool &&
      (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".internal") ||
        host.endsWith(".local") ||
        (!host.includes(".") && !host.includes(":"))))
  ) {
    throw new UnsafeApiUrlError();
  }
  return url;
}

/** 一次解析全部地址，任一非公网或解析失败就拒绝；返回的 IP 直接用于连接。 */
async function resolveApiTarget(
  url: URL,
  trustedPool = false
): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (!trustedPool && !isPublicAddress(hostname))
      throw new UnsafeApiUrlError();
    return hostname;
  }
  try {
    const entries = await lookup(hostname, { all: true, verbatim: true });
    if (
      !entries.length ||
      entries.some(
        ({ address }) =>
          !isIP(address) || (!trustedPool && !isPublicAddress(address))
      )
    ) {
      throw new UnsafeApiUrlError();
    }
    const first = entries[0];
    if (!first) throw new UnsafeApiUrlError();
    return first.address;
  } catch {
    throw new UnsafeApiUrlError();
  }
}

/** 仅信任运维配置的完整 origin；不接受路径、凭据、通配符或数据库提供的规则。 */
function isTrustedPoolOrigin(rawUrl: string | URL): boolean {
  let target: URL;
  try {
    target = new URL(String(rawUrl));
  } catch {
    return false;
  }
  return (process.env.IMAGE_BACKEND_TRUSTED_API_ORIGINS || "")
    .split(",")
    .some((entry) => {
      try {
        const origin = new URL(entry.trim());
        return (
          ["http:", "https:"].includes(origin.protocol) &&
          !origin.username &&
          !origin.password &&
          origin.pathname === "/" &&
          !origin.search &&
          !origin.hash &&
          origin.origin === target.origin
        );
      } catch {
        return false;
      }
    });
}

/** 池保存允许服务器已批准的内部 origin；用户自定义 API 不能调用此信任策略。 */
export async function assertSafePoolApiBaseUrl(baseUrl: string): Promise<void> {
  const trusted = isTrustedPoolOrigin(baseUrl);
  await resolveApiTarget(parseApiUrl(baseUrl, trusted), trusted);
}

/** 保存/测试前的只读校验；真正发送仍独立解析并固定该次已验证的 IP。 */
export async function assertSafeApiBaseUrl(baseUrl: string): Promise<void> {
  await resolveApiTarget(parseApiUrl(baseUrl));
}
export { assertSafeApiBaseUrl as assertPublicApiBaseUrl };

/**
 * 固定 IP 的 HTTPS 请求，支持 JSON、FormData 和流式响应；取消会销毁连接。
 * 只接受本次 URL 的服务器证书，全部 3xx 拒绝且丢弃正文，不携密钥跟随跳转。
 * 不使用全局 fetch（避免 Next 包装或 DNS 二次解析），正文持续保留流背压。
 */
export async function safeApiFetch(
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  return fetchPinnedApi(url, init, false);
}

/** 按服务器策略解析并 pin；信任池 origin 也禁跟随跳转、禁关闭 TLS 校验。 */
async function fetchPinnedApi(
  url: string | URL,
  init: RequestInit,
  trustedPool: boolean
): Promise<Response> {
  const parsed = parseApiUrl(url, trustedPool);
  init.signal?.throwIfAborted();
  const address = await resolveApiTarget(parsed, trustedPool);
  init.signal?.throwIfAborted();
  const request = new Request(parsed, init);
  request.headers.set("host", parsed.host);
  // 原生 HTTPS 不自动解压；向上游明确要求 identity，避免流/JSON 被压缩编码。
  request.headers.set("accept-encoding", "identity");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Response>((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: address,
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        path: parsed.pathname + parsed.search,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
        agent: false,
        signal: init.signal ?? undefined,
        timeout: 20 * 60_000,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.destroy();
          req.destroy();
          reject(new UnsafeApiUrlError("API redirect is not allowed."));
          return;
        }
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value))
              for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const body =
            status === 204 || status === 205 || request.method === "HEAD"
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          if (!body) res.resume();
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          res.destroy();
          req.destroy();
          reject(error);
        }
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("API request timed out")));
    if (request.body) {
      void pipeline(
        Readable.fromWeb(
          request.body as import("node:stream/web").ReadableStream
        ),
        req
      ).catch(reject);
    } else req.end();
  });
}

/** 所有池/用户 API 的凭据请求限定同 origin；第一方账号沿用原传输与取消逻辑。 */
export async function fetchApiRequest(
  config: ApiConfig,
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (
    config.backend?.type === "pool-api" ||
    config.backend?.type === "user-api"
  ) {
    const trustedPool =
      config.backend.type === "pool-api" && isTrustedPoolOrigin(config.baseUrl);
    if (
      parseApiUrl(url, trustedPool).origin !==
      parseApiUrl(config.baseUrl, trustedPool).origin
    )
      throw new UnsafeApiUrlError();
    return fetchPinnedApi(url, init ?? {}, trustedPool);
  }
  return fetch(url, { ...init, redirect: "manual" });
}
