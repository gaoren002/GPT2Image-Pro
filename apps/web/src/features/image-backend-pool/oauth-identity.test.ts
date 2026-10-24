/** 稳定身份纯解析回归；依据官方Codex token_data.rs，用户ID与workspace ID必须区分。 */
import { expect, it } from "vitest";
import { oauthIdentity, oauthResponseIdentity } from "./oauth-identity";
const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
it("官方user_id后备字段与chatgpt_user_id属于同一身份键", () => {
  expect(
    oauthIdentity(
      jwt({ chatgpt_account_id: "workspace", chatgpt_user_id: "user" })
    )
  ).toEqual(
    oauthIdentity(jwt({ chatgpt_account_id: "workspace", user_id: "user" }))
  );
});
it.each([
  {},
  { chatgpt_account_id: "workspace" },
  { chatgpt_user_id: "user" },
  { chatgpt_account_id: "bad workspace", chatgpt_user_id: "user" },
  { chatgpt_account_id: "workspace", chatgpt_user_id: "a", user_id: "b" },
])("缺失或冲突claim %j 不从邮件/metadata/sub猜测账户", (claims) => {
  expect(() =>
    oauthIdentity(jwt({ sub: "user", email: "x@example.test", ...claims }))
  ).toThrow("身份缺失或冲突");
});
it("畸形/过大JWT错误不回显输入", () => {
  const token = `e30.${"x".repeat(65537)}.signature`;
  try {
    oauthIdentity(token);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(String(error)).not.toContain("xxxx");
  }
});

it("同一OAuth响应的AT与ID token身份冲突必须拒绝", () => {
  expect(() =>
    oauthResponseIdentity(
      jwt({ chatgpt_account_id: "workspace", user_id: "user-a" }),
      jwt({ chatgpt_account_id: "workspace", user_id: "user-b" })
    )
  ).toThrow();
});
it("官方ID token中的完整身份可补AT缺失，不能用邮件/sub补", () => {
  expect(
    oauthResponseIdentity(
      "opaque-at",
      jwt({ chatgpt_account_id: "workspace", chatgpt_user_id: "user" })
    )
  ).toEqual(
    oauthIdentity(jwt({ chatgpt_account_id: "workspace", user_id: "user" }))
  );
});
