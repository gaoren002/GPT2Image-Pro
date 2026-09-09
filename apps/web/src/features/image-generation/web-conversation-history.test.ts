/**
 * 验证新版 Web messages[] 会话按轮次隔离；使用合成消息复现 HAR 结构，不包含用户数据或凭据。
 */
import { describe, expect, it } from "vitest";
import { getWebConversationTurnNodes } from "./web-conversation-history";

/** 构造最小合成消息；metadata 可模拟分页遗漏的父节点和独立轮次标识。 */
function message(
  id: string,
  role: string,
  metadata: Record<string, unknown> = {},
  content: Record<string, unknown> = { content_type: "text", parts: [] }
) {
  return { id, author: { role }, metadata, content };
}

describe("新版 ChatGPT Web 会话轮次", () => {
  it("非 messages[] 响应交回旧 mapping 解析器", () => {
    expect(getWebConversationTurnNodes({ mapping: {} }, "request")).toBeNull();
    expect(getWebConversationTurnNodes(null, "request")).toBeNull();
  });

  it("messages 格式损坏或目标用户不在当前页时不猜当前轮次", () => {
    expect(getWebConversationTurnNodes({ messages: {} }, "request")).toEqual(
      []
    );
    expect(
      getWebConversationTurnNodes(
        { messages: [null, "invalid", {}, message("other", "user")] },
        "request"
      )
    ).toEqual([]);
  });

  it("用用户的独立轮次标识关联工具与缺失父节点的 recap", () => {
    const turn = { working_turn_id: "work-a", turn_exchange_id: "exchange-a" };
    const image = message(
      "image-a",
      "tool",
      { ...turn, parent_id: "request" },
      {
        content_type: "multimodal_text",
        parts: [
          {
            content_type: "image_asset_pointer",
            asset_pointer: "sediment://synthetic-image",
          },
        ],
      }
    );
    const recap = message(
      "recap-a",
      "assistant",
      { ...turn, parent_id: "omitted-parent" },
      {
        content_type: "reasoning_recap",
      }
    );
    const data = { messages: [message("request", "user", turn), image, recap] };
    expect(getWebConversationTurnNodes(data, "request")).toEqual([
      { id: "image-a", node: { message: image } },
      { id: "recap-a", node: { message: recap } },
    ]);
    expect(data.messages).toHaveLength(3);
  });

  it.each([
    "working_turn_id",
    "turn_exchange_id",
  ])("仅有 %s 也可精确识别轮次", (key) => {
    const answer = message("answer", "assistant", { [key]: "turn-a" });
    expect(
      getWebConversationTurnNodes(
        { messages: [message("request", "user", { [key]: "turn-a" }), answer] },
        "request"
      )
    ).toEqual([{ id: "answer", node: { message: answer } }]);
  });

  it("不会把后续用户的图或前一轮内容混入目标轮次", () => {
    const first = { working_turn_id: "turn-a", turn_exchange_id: "turn-a" };
    const second = { working_turn_id: "turn-b", turn_exchange_id: "turn-b" };
    const firstImage = message("image-a", "tool", first);
    const secondImage = message("image-b", "tool", second);
    const data = {
      messages: [
        message("request-a", "user", first),
        firstImage,
        message("request-b", "user", second),
        secondImage,
      ],
    };
    expect(getWebConversationTurnNodes(data, "request-a")).toEqual([
      { id: "image-a", node: { message: firstImage } },
    ]);
    expect(getWebConversationTurnNodes(data, "request-b")).toEqual([
      { id: "image-b", node: { message: secondImage } },
    ]);
  });

  it("冲突轮次不能借另一个相同标识或父节点关系进入本轮", () => {
    const data = {
      messages: [
        message("request", "user", {
          working_turn_id: "work-a",
          turn_exchange_id: "exchange-a",
        }),
        message("wrong-work", "tool", {
          working_turn_id: "work-b",
          turn_exchange_id: "exchange-a",
          parent_id: "request",
        }),
        message("wrong-exchange", "tool", {
          working_turn_id: "work-a",
          turn_exchange_id: "exchange-b",
          parent_id: "request",
        }),
      ],
    };
    expect(getWebConversationTurnNodes(data, "request")).toEqual([]);
  });

  it("无轮次标识时只接受锚定本轮用户的父链，不按时间猜测", () => {
    const answer = message("answer", "assistant", { parent_id: "request" });
    const image = message("image", "tool", { parent_id: "answer" });
    expect(
      getWebConversationTurnNodes(
        {
          messages: [
            message("request", "user"),
            image,
            answer,
            { ...message("unrelated", "tool"), create_time: 999999 },
            message("cycle-a", "tool", { parent_id: "cycle-b" }),
            message("cycle-b", "tool", { parent_id: "cycle-a" }),
          ],
        },
        "request"
      )
    ).toEqual([
      { id: "image", node: { message: image } },
      { id: "answer", node: { message: answer } },
    ]);
  });

  it("后续用户形成硬边界，即使后续节点复用轮次标识或旧父节点", () => {
    expect(
      getWebConversationTurnNodes(
        {
          messages: [
            message("request", "user", { working_turn_id: "shared-turn" }),
            message("next-request", "user", { working_turn_id: "shared-turn" }),
            message("next-image", "tool", {
              working_turn_id: "shared-turn",
              parent_id: "request",
            }),
          ],
        },
        "request"
      )
    ).toEqual([]);
  });

  it("重复的目标用户标识无法消歧，返回空轮次", () => {
    expect(
      getWebConversationTurnNodes(
        {
          messages: [
            message("request", "user"),
            message("request", "user"),
            message("image", "tool", { parent_id: "request" }),
          ],
        },
        "request"
      )
    ).toEqual([]);
  });
});
