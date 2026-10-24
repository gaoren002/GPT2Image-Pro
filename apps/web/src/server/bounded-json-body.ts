/**
 * 限长读取 JSON 请求体。
 *
 * 使用方：不经过 middleware 的自鉴权入口（/moderate、/api/mcp/user、/api/mcp/admin）。
 * Next 路由处理函数的 request.json() 没有字节上限，而 middleware 的
 * proxyClientMaxBodySize 只约束经过 middleware 的请求；这些入口移出 middleware
 * 以避免请求体被复制，因此在鉴权之后、解析之前由本函数按字节计数读取：
 * 先拒绝声明长度超限的请求，再流式累计，超限立即取消读取，内存不超过上限。
 */

/**
 * 自鉴权入口的请求体上限。等于这些入口移出 middleware 前 proxyClientMaxBodySize
 * 实际允许的 200MB，保持可接受的载荷大小不变（审核图片、MCP 文件生成的 base64 图）。
 */
export const SELF_AUTHENTICATED_BODY_MAX_BYTES = 200 * 1024 * 1024;

export type BoundedJsonBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

/**
 * 按字节上限读取并解析 JSON 请求体。
 *
 * @param request 原始请求；调用方须已完成鉴权，避免为匿名请求读取请求体
 * @param maxBytes 允许的最大字节数（含）
 * @returns 解析成功返回 value；声明或实际字节超限返回 too_large；空体、读取中断
 *   或非法 JSON 返回 invalid_json。不抛异常，原始错误不外泄。
 */
export async function readJsonBodyWithinLimit(
  request: Request,
  maxBytes: number
): Promise<BoundedJsonBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }
  if (!request.body) return { ok: false, reason: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Content-Length 可缺失（分块传输）或与实际不符，必须按实际字节判定。
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
