/**
 * 内置浏览器 Origin 兼容逻辑测试（纯函数，DB-free）。
 *
 * 约束：只对缺失 Origin 的会话无关认证 POST 去掉 Cookie；
 * 带 Origin 的请求、依赖会话的端点、非 POST 请求一律原样放行给 Better Auth 校验。
 */

import { describe, expect, it } from "vitest";
import { stripCookiesForOriginlessAuthPost } from "./origin-compat";

const BASE = "https://app.example.test";

function authPost(path: string, headers: Record<string, string>) {
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: "t", newPassword: "n" }),
  });
}

describe("stripCookiesForOriginlessAuthPost", () => {
  it("缺失 Origin 的重置密码提交去掉 Cookie，保留方法、URL、其他头与请求体", async () => {
    const request = authPost("/reset-password", {
      cookie: "better-auth.session_token=abc; NEXT_LOCALE=zh",
      "user-agent": "MicroMessenger",
    });
    const result = stripCookiesForOriginlessAuthPost(request);
    expect(result).not.toBe(request);
    expect(result.headers.has("cookie")).toBe(false);
    expect(result.method).toBe("POST");
    expect(result.url).toBe(`${BASE}/api/auth/reset-password`);
    expect(result.headers.get("user-agent")).toBe("MicroMessenger");
    expect(await result.json()).toEqual({ token: "t", newPassword: "n" });
  });

  it("Origin 为 null 时同样处理（内置浏览器的不透明来源）", () => {
    const request = authPost("/sign-in/email", {
      cookie: "NEXT_LOCALE=zh",
      origin: "null",
    });
    expect(
      stripCookiesForOriginlessAuthPost(request).headers.has("cookie")
    ).toBe(false);
  });

  it("带有 Origin 的请求原样返回，交由 Better Auth 校验来源", () => {
    for (const origin of [BASE, "https://evil.example"]) {
      const request = authPost("/sign-in/email", {
        cookie: "NEXT_LOCALE=zh",
        origin,
      });
      expect(stripCookiesForOriginlessAuthPost(request)).toBe(request);
    }
  });

  it("依赖会话的端点即使缺失 Origin 也不去掉 Cookie", () => {
    for (const path of [
      "/change-password",
      "/update-user",
      "/sign-out",
      "/revoke-sessions",
      "/sign-in/email-otp",
      "/reset-password/abc",
    ]) {
      const request = authPost(path, { cookie: "session=1" });
      expect(stripCookiesForOriginlessAuthPost(request)).toBe(request);
    }
  });

  it("非 POST、无 Cookie 或不在认证前缀下的请求原样返回", () => {
    const get = new Request(`${BASE}/api/auth/reset-password`, {
      headers: { cookie: "session=1" },
    });
    expect(stripCookiesForOriginlessAuthPost(get)).toBe(get);

    const noCookie = authPost("/reset-password", {});
    expect(stripCookiesForOriginlessAuthPost(noCookie)).toBe(noCookie);

    const other = new Request(`${BASE}/api/other/reset-password`, {
      method: "POST",
      headers: { cookie: "session=1" },
    });
    expect(stripCookiesForOriginlessAuthPost(other)).toBe(other);
  });
});
