/**
 * 生成中止原因的统一判定与文案。
 *
 * 外层生成信号由客户端断开（request.signal）与 20 分钟截止合成。信号中止时，
 * 原先一律写成 "The operation was aborted due to timeout"：客户端自己断开也被
 * 记成超时，并在状态页归为平台错误。本模块按 signal.reason 区分原因并给出稳定文案：
 * - 客户端断开：CLIENT_CLOSED_REQUEST_ERROR，归用户侧（499），不计入平台失败；
 * - 其余（截止超时、无理由或未知理由的中止）：沿用 GENERATION_ABORTED_ERROR。
 *
 * 使用方：image-generation/service.ts（池重试与提示词改写的中止结果）、
 * external-api/images.ts（映射 499）、image-generation/sla-classification.ts 与
 * image-backend-pool/service.ts（失败分类）。文案集中在此，避免多处各写一份而漂移。
 * 依赖：无（纯函数，不 import 数据库或 Next，便于单测）。
 */

/**
 * 客户端在结果就绪前断开连接的错误文案。
 * 刻意不含 "aborted" 等字样：基础设施故障与审核服务故障规则按子串匹配，
 * 含这些字样会被抢先归为平台错误。
 */
export const CLIENT_CLOSED_REQUEST_ERROR =
  "Client closed the request before the image was ready.";

/**
 * 历史中止文案。截止超时与无法证明是客户端断开的中止继续使用，
 * 保持既有的分类与测试语义。
 */
export const GENERATION_ABORTED_ERROR =
  "The operation was aborted due to timeout";

/**
 * Next 在连接先于响应结束关闭时中止 request.signal 所用 Error 的名称
 * （next/dist/server/web/spec-extension/adapters/next-request.js 的 ResponseAborted）。
 */
const CLIENT_DISCONNECT_REASON_NAME = "ResponseAborted";

/**
 * 按中止信号的 reason 给出生成中止的错误文案。
 *
 * @param signal 外层生成信号（可能是 AbortSignal.any 的合成信号）；可为空。
 * @returns 客户端断开返回 CLIENT_CLOSED_REQUEST_ERROR，其余一律返回
 *   GENERATION_ABORTED_ERROR。
 *
 * 只按 reason.name 判断而不用 instanceof，避免模块被打包出多份副本时误判；
 * reason 不是对象（例如 abort("ResponseAborted") 传字符串）时视为未知原因。
 * 信号未中止时 reason 为 undefined，同样走历史文案。无副作用。
 */
export function resolveGenerationAbortError(signal?: AbortSignal | null) {
  const reason: unknown = signal?.reason;
  const isClientDisconnect =
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === CLIENT_DISCONNECT_REASON_NAME;
  return isClientDisconnect
    ? CLIENT_CLOSED_REQUEST_ERROR
    : GENERATION_ABORTED_ERROR;
}
