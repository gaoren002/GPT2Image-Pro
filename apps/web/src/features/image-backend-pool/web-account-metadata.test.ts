/** 验证 ChatGPT Web workspace claim 的容错解析和 metadata 合并边界。 */
import { describe, expect, it } from "vitest";
import {
  chatGptAccountIdFromAccessToken,
  mergeChatGptAccountIdMetadata,
} from "./web-account-metadata";

/** 构造不含真实凭据的 JWT 形状，签名不会被解析器读取。 */
function testJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

describe("ChatGPT Web workspace metadata", () => {
  it("从 access token 提取账号 claim，并覆盖旧 workspace 而保留其他 metadata", () => {
    const accessToken = testJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-new",
      },
    });

    expect(chatGptAccountIdFromAccessToken(`Bearer ${accessToken}`)).toBe(
      "workspace-new"
    );
    expect(
      mergeChatGptAccountIdMetadata(
        { source: "manual", chatgptAccountId: "workspace-old" },
        accessToken,
        "web"
      )
    ).toEqual({ source: "manual", chatgptAccountId: "workspace-new" });
  });

  it("非 Web 模式或畸形 JWT 不改写 metadata", () => {
    const metadata = { source: "manual" };
    expect(
      mergeChatGptAccountIdMetadata(metadata, "invalid-token", "web")
    ).toBe(metadata);
    expect(
      mergeChatGptAccountIdMetadata(
        metadata,
        testJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace-1",
          },
        }),
        "responses"
      )
    ).toBe(metadata);
  });

  it("嵌套现网 claim 优先，同时兼容旧工具的扁平 claim", () => {
    expect(
      chatGptAccountIdFromAccessToken(
        testJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace-current",
          },
          "https://api.openai.com/auth.chatgpt_account_id": "workspace-legacy",
        })
      )
    ).toBe("workspace-current");
    expect(
      chatGptAccountIdFromAccessToken(
        testJwt({
          "https://api.openai.com/auth.chatgpt_account_id": "workspace-legacy",
        })
      )
    ).toBe("workspace-legacy");
  });

  it("拒绝非对象 auth claim 和非法 workspace id", () => {
    expect(
      chatGptAccountIdFromAccessToken(
        testJwt({ "https://api.openai.com/auth": ["workspace-array"] })
      )
    ).toBe("");
    expect(
      chatGptAccountIdFromAccessToken(
        testJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace with spaces",
          },
        })
      )
    ).toBe("");
  });
});
