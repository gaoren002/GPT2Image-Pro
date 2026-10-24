/**
 * DNS-pinning fetch：解决 DNS 重绑定（rebinding）攻击的连接层防护。
 *
 * 问题：传统 SSRF 防护在 DNS 解析后校验 IP，但实际连接时可能获得不同的 IP
 * （攻击者在第二次 DNS 查询返回内网 IP）。
 *
 * 方案：
 * 1. 解析主机名，获得所有 IP
 * 2. 校验所有 IP 均为公网地址（任一内网即拒绝）
 * 3. 将 URL 中的主机名替换为第一个合法公网 IP，强制连接到该 IP
 * 4. 设置 Host 头以保留虚拟主机路由
 * 5. HTTPS 场景通过 servername 指定 SNI 以通过证书校验
 *
 * 关键设计决策：
 * - 使用 node:http / node:https 原生模块而非 globalThis.fetch，
 *   因为 Next.js 16 patchFetch() 会替换 globalThis.fetch 且不可配置。
 * - 无条件执行（不检测环境，不区分生产/测试），避免被绕过。
 * - redirect:"manual" 由本模块强制，调用方负责对重定向目标重新调用 fetchWithDnsPin。
 *
 * 使用方：safe-image-fetch.ts 中的 fetchPublicImage / fetchPublicCallback
 * 依赖：ip-validation.ts（纯函数 IP 校验）
 */

import { resolve4, resolve6 } from "node:dns/promises";
import type {
  ClientRequest,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import http from "node:http";
import https from "node:https";
import { isBlockedIP } from "./ip-validation";

/**
 * SSRF 请求被阻断时抛出的错误类型。
 * 调用方可据此向用户返回友好错误而非暴露内部细节。
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** fetchWithDnsPin 的可选配置 */
export interface DnsPinFetchOptions {
  /** 请求方法，默认 GET */
  method?: string;
  /** 额外请求头（Host 头由内部设置，不应在此传入） */
  headers?: Record<string, string>;
  /** 请求正文 */
  body?: string | Buffer;
  /** 超时毫秒数，默认 10000（10秒） */
  timeoutMs?: number;
  /** AbortSignal 用于外部取消 */
  signal?: AbortSignal;
  /**
   * 响应正文字节上限。超限即销毁连接并让正文流报错，不继续接收。
   *
   * WHY 放在连接层：上层按 content-length 或读取累计判断时，字节已经进了本进程内存。
   * 调用方仍应保留自己的限额检查（分套餐限额不同），此处是兜底，防止"先收完再拒绝"。
   */
  maxBytes?: number;
}

/** 响应正文超过 maxBytes 时的错误，连接已被销毁。 */
export class DnsPinResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body exceeded ${maxBytes} bytes.`);
    this.name = "DnsPinResponseTooLargeError";
  }
}

/**
 * 不允许携带正文的响应状态（RFC 9110）。Response 构造器对这些状态传入非 null 正文
 * 会抛 TypeError，即使长度为零。
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * 把 Node 响应流转成 Web 流，按需施加字节上限。
 *
 * @param res Node 响应流。
 * @param req 对应请求，用于超限或取消时销毁连接。
 * @param maxBytes 字节上限；未给出则不限制（仍由调用方自己的限额把关）。
 * @returns 可交给 Response 构造器的正文流；超限时流报错且连接已销毁。
 * @remarks 队列满即暂停 socket、被拉取时恢复，保留背压；调用方取消正文时销毁连接，
 *   使"读到一半放弃"真正停止传输，而不是继续收完。
 */
function toLimitedWebStream(
  res: IncomingMessage,
  req: ClientRequest,
  maxBytes?: number
): ReadableStream<Uint8Array> {
  let received = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (maxBytes !== undefined && received > maxBytes) {
          req.destroy();
          controller.error(new DnsPinResponseTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        // 消费方跟不上时暂停接收，由 pull 恢复，避免在内存里堆积。
        if ((controller.desiredSize ?? 1) <= 0) {
          res.pause();
        }
      });
      res.on("end", () => {
        // 已因超限/错误结束时 close 会抛，按已结束处理。
        try {
          controller.close();
        } catch {
          // 流已结束，无需处理。
        }
      });
      res.on("error", (error: Error) => {
        try {
          controller.error(error);
        } catch {
          // 流已结束，无需处理。
        }
      });
    },
    pull() {
      res.resume();
    },
    cancel() {
      req.destroy();
    },
  });
}

/**
 * 解析主机名并校验所有返回 IP 均为公网地址。
 *
 * @param hostname 待解析的主机名
 * @returns 第一个合法公网 IPv4 地址
 * @throws SsrfBlockedError 若任一 IP 为私有/保留地址
 * @throws Error 若 DNS 解析失败或无结果
 */
async function resolveAndValidate(hostname: string): Promise<string> {
  let addresses: string[] = [];

  try {
    const ipv4 = await resolve4(hostname);
    addresses = addresses.concat(ipv4);
  } catch {
    // IPv4 解析失败，尝试 IPv6
  }

  if (addresses.length === 0) {
    try {
      const ipv6 = await resolve6(hostname);
      addresses = addresses.concat(ipv6);
    } catch {
      // IPv6 也失败
    }
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(
      `DNS resolution failed for hostname: ${hostname}`
    );
  }

  // 校验所有解析出的 IP 均为公网地址（ANY 内网即阻断）
  for (const ip of addresses) {
    if (isBlockedIP(ip)) {
      throw new SsrfBlockedError(
        "Image URL resolved to a private/reserved IP address."
      );
    }
  }

  // 返回第一个合法 IPv4（优先）用于 pin
  return addresses[0]!;
}

/**
 * 使用 node:http/node:https 发起请求，将主机名 pin 到已校验的 IP。
 *
 * 关键行为：
 * - 强制 redirect:"manual"（返回 3xx 响应本身，不跟踪重定向）
 * - 对 HTTPS 设置 servername 以保持 SNI/证书校验
 * - 设置 Host 头以保留虚拟主机路由
 * - 超时后自动销毁请求
 *
 * @param url 完整 URL（http:// 或 https://）
 * @param init 可选的请求配置
 * @returns 标准 Response 对象（Node.js 风格包装为 Web Response）
 * @throws SsrfBlockedError 若目标解析到内网地址
 * @throws Error 若请求超时或网络错误
 */
export async function fetchWithDnsPin(
  url: string | URL,
  init?: DnsPinFetchOptions
): Promise<Response> {
  const parsed = typeof url === "string" ? new URL(url) : new URL(url.href);
  const isHttps = parsed.protocol === "https:";
  const hostname = parsed.hostname;
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const maxBytes = init?.maxBytes;

  // 若 URL 已是 IP 字面量，直接校验
  const isLiteralIP =
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");

  let pinnedIP: string;
  if (isLiteralIP) {
    if (isBlockedIP(hostname)) {
      throw new SsrfBlockedError(
        "Image URL resolved to a private/reserved IP address."
      );
    }
    pinnedIP = hostname;
  } else {
    pinnedIP = await resolveAndValidate(hostname);
  }

  // 构造请求选项，将 host 替换为 pinned IP
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
      ? 443
      : 80;

  const headers: Record<string, string> = {
    ...(init?.headers ?? {}),
    Host: parsed.port ? `${hostname}:${parsed.port}` : hostname,
  };

  const requestOptions: RequestOptions = {
    hostname: pinnedIP,
    port,
    path: parsed.pathname + parsed.search,
    method: init?.method ?? "GET",
    headers,
    timeout: timeoutMs,
  };

  // HTTPS: 设置 servername 以通过 TLS 证书校验（SNI）
  if (isHttps) {
    (requestOptions as https.RequestOptions).servername = hostname;
    // 禁止 TLS session 复用到不同主机（防止绕过 pin）
    requestOptions.agent = new https.Agent({
      servername: hostname,
      maxSockets: 1,
    });
  }

  const transport = isHttps ? https : http;

  return new Promise<Response>((resolve, reject) => {
    // 处理外部 AbortSignal
    if (init?.signal?.aborted) {
      reject(new Error("Request aborted"));
      return;
    }

    const req = transport.request(
      requestOptions,
      (res: IncomingMessage) => {
        // 响应头到齐即构造 Response，正文作为流交给调用方：此前把全部 chunk 收进数组、
        // 到 end 事件才 resolve，于是上层的"流式限额"永远在正文已全部进内存之后才生效，
        // 巨大响应可逼近 OOM，取消也无法中止传输。
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) {
                responseHeaders.append(key, v);
              }
            } else {
              responseHeaders.set(key, value);
            }
          }

          const status = res.statusCode ?? 200;
          const init: ResponseInit = {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          };

          // 204/304 等状态不允许携带正文，传入非 null 会抛 TypeError；
          // 丢弃正文流并以 null 构造（正常回调返回 204 即走这里）。
          if (NULL_BODY_STATUSES.has(status) || requestOptions.method === "HEAD") {
            res.resume();
            resolve(new Response(null, init));
            return;
          }

          resolve(new Response(toLimitedWebStream(res, req, maxBytes), init));
        } catch (error) {
          // 构造失败发生在事件回调里，不能让异常逸出（会变成未捕获异常、Promise 永不结算）。
          req.destroy();
          reject(error);
        }
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err: Error) => {
      reject(err);
    });

    // 外部取消
    if (init?.signal) {
      const onAbort = () => {
        req.destroy();
        reject(new Error("Request aborted"));
      };
      init.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => {
        init.signal?.removeEventListener("abort", onAbort);
      });
    }

    // 写入请求正文
    if (init?.body) {
      req.write(init.body);
    }
    req.end();
  });
}
