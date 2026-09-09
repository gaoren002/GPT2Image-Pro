/**
 * 将新版 ChatGPT Web conversations 接口的 messages[] 限定到单轮，供既有图像/文本提取器使用。
 * 仅处理内存中的未知 JSON；按 HAR 已验证的轮次标识和父关系关联，不访问网络或保存用户数据。
 */

export type WebConversationTurnNode = {
  id: string;
  node: { message: Record<string, unknown> };
};

type ParsedMessage = {
  message: Record<string, unknown>;
  id: string;
  role: string;
  metadata: Record<string, unknown>;
};

const TURN_KEYS = ["working_turn_id", "turn_exchange_id"] as const;

/** 判断外部 JSON 是否为普通对象；拒绝 null 与数组，不做类型强制转换。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取非空标识；不推断缺失或错误类型的外部字段。 */
function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** 解析消息锚点与轮次元数据；无效消息不参与任何父链或轮次匹配。 */
function parseMessage(value: unknown): ParsedMessage | null {
  if (!isRecord(value) || !isRecord(value.author)) return null;
  const id = readId(value.id);
  const role = readId(value.author.role);
  if (!id || !role) return null;
  return {
    message: value,
    id,
    role,
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

/**
 * 比较共同存在的轮次标识；任一冲突优先拒绝，防止父链或另一相同字段掩盖跨轮消息。
 */
function compareTurn(request: ParsedMessage, candidate: ParsedMessage) {
  let matches = false;
  for (const key of TURN_KEYS) {
    const expected = readId(request.metadata[key]);
    const actual = readId(candidate.metadata[key]);
    if (!expected || !actual) continue;
    if (expected !== actual) return "conflict";
    matches = true;
  }
  return matches ? "match" : "unknown";
}

/** 读取 HAR 已验证的 metadata.parent_id，同时兼容显式顶层父关系；不猜父节点。 */
function parentMessageId(message: ParsedMessage): string | null {
  return (
    readId(message.metadata.parent_id) ||
    readId(message.message.parent_id) ||
    readId(message.message.parent)
  );
}

/**
 * 从新版 messages[] 返回请求用户之后、本轮内的节点，保持数组原顺序且不修改输入。
 * 非新版结构返回 null，交给旧 mapping 解析器；损坏响应或当前页无唯一目标用户返回 []。
 * 后续用户形成硬边界；范围内优先按独立 working_turn_id/turn_exchange_id 关联，缺字段时
 * 仅接受显式连到本轮用户/已确认节点的父链。禁止时间兜底，避免把历史图片当成本轮结果。
 */
export function getWebConversationTurnNodes(
  data: unknown,
  requestMessageId: string
): WebConversationTurnNode[] | null {
  if (!isRecord(data) || !("messages" in data)) return null;
  if (!Array.isArray(data.messages) || !requestMessageId.trim()) return [];

  const messages = data.messages
    .map(parseMessage)
    .filter((message): message is ParsedMessage => message !== null);
  const requests = messages.filter(
    (message) => message.id === requestMessageId && message.role === "user"
  );
  const request = requests[0];
  if (requests.length !== 1 || !request) return [];

  const requestIndex = messages.indexOf(request);
  const nextRequestIndex = messages.findIndex(
    (message, index) => index > requestIndex && message.role === "user"
  );
  const candidates = messages
    .slice(
      requestIndex + 1,
      nextRequestIndex < 0 ? undefined : nextRequestIndex
    )
    .filter(
      (message) =>
        ["assistant", "tool", "system"].includes(message.role) &&
        isRecord(message.message.content) &&
        compareTurn(request, message) !== "conflict"
    );

  const included = new Set([requestMessageId]);
  for (const candidate of candidates) {
    if (compareTurn(request, candidate) === "match") included.add(candidate.id);
  }

  // 父节点可在分页数组中位于子节点之后；按有限节点集求闭包，未锚定的环不会被纳入。
  let added = true;
  while (added) {
    added = false;
    for (const candidate of candidates) {
      if (included.has(candidate.id)) continue;
      const parentId = parentMessageId(candidate);
      if (!parentId || !included.has(parentId)) continue;
      included.add(candidate.id);
      added = true;
    }
  }

  const emitted = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (!included.has(candidate.id) || emitted.has(candidate.id)) return [];
    emitted.add(candidate.id);
    return [{ id: candidate.id, node: { message: candidate.message } }];
  });
}
