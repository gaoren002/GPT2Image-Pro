/**
 * 内置浏览器 Origin 兼容逻辑测试（纯函数，DB-free）。
 *
 * 约束：只为 JSON 请求体、缺失 Origin/Referer 且未被标记为跨站的认证 POST 补上本站
 * Origin，并保留 Cookie（登出、修改密码等依赖会话的端点需要它）；已带来源、明确跨站，
 * 或表单编码的请求一律原样交给 Better Auth 校验。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeOriginlessAuthPost } from "./origin-compat";

const APP = "https://app.example.test";
const originalEnv = {
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

beforeEach(() => {
  process.env.BETTER_AUTH_URL = APP;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function authPost(path: string, headers: Record<string, string>) {
  return new Request(`${APP}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: "t", newPassword: "n" }),
  });
}

describe("normalizeOriginlessAuthPost", () => {
  it("缺失 Origin 的内置浏览器提交补本站 Origin，并保留 Cookie 与请求体", async () => {
    const request = authPost("/reset-password", {
      cookie: "better-auth.session_token=abc; NEXT_LOCALE=zh",
      "user-agent": "MicroMessenger",
    });
    const result = normalizeOriginlessAuthPost(request);
    expect(result).not.toBe(request);
    expect(result.headers.get("origin")).toBe(APP);
    expect(result.headers.get("cookie")).toBe(
      "better-auth.session_token=abc; NEXT_LOCALE=zh"
    );
    expect(result.method).toBe("POST");
    expect(result.url).toBe(`${APP}/api/auth/reset-password`);
    expect(await result.json()).toEqual({ token: "t", newPassword: "n" });
  });

  it("Origin 为 null 时同样补写（内置浏览器的不透明来源）", () => {
    const request = authPost("/sign-out", { cookie: "s=1", origin: "null" });
    expect(normalizeOriginlessAuthPost(request).headers.get("origin")).toBe(
      APP
    );
  });

  it("Sec-Fetch-Site 标记为跨站时不补写，交由 Better Auth 拒绝", () => {
    const request = authPost("/sign-in/email", {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    });
    expect(normalizeOriginlessAuthPost(request)).toBe(request);
  });

  it("已带 Origin 或 Referer 的请求原样返回", () => {
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: APP },
      { referer: "https://evil.example/page" },
    ]) {
      const request = authPost("/sign-in/email", headers);
      expect(normalizeOriginlessAuthPost(request)).toBe(request);
    }
  });

  it("同站与用户直接发起的请求补写后可通过来源校验", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      const request = authPost("/change-password", {
        cookie: "s=1",
        "sec-fetch-site": site,
      });
      expect(
        normalizeOriginlessAuthPost(request).headers.get("origin"),
        site
      ).toBe(APP);
    }
  });

  it("跨站表单在 no-referrer 下发出的 Origin: null 不被补写", () => {
    // 跨站导航型 POST 在 Referrer-Policy: no-referrer 下 Origin 序列化为 "null"
    // 且不带 Referer；不发 Sec-Fetch-* 的老客户端无法据此判别，只能靠请求体类型：
    // HTML 表单只能发 urlencoded/multipart/text-plain，发不出 JSON。
    for (const contentType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain;charset=UTF-8",
    ]) {
      const request = new Request(`${APP}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": contentType, origin: "null" },
        body: "email=victim%40example.com&password=attacker",
      });
      expect(normalizeOriginlessAuthPost(request), contentType).toBe(request);
    }
  });

  it("缺少 content-type 的请求不被补写", () => {
    const request = new Request(`${APP}/api/auth/sign-in/email`, {
      method: "POST",
      body: "email=a&password=b",
      headers: { "content-type": "" },
    });
    expect(normalizeOriginlessAuthPost(request)).toBe(request);
  });

  it("JSON 判定忽略参数与大小写", () => {
    for (const contentType of [
      "application/json",
      "Application/JSON; charset=utf-8",
      " application/json ",
    ]) {
      const request = new Request(`${APP}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": contentType, cookie: "s=1" },
        body: "{}",
      });
      expect(
        normalizeOriginlessAuthPost(request).headers.get("origin"),
        contentType
      ).toBe(APP);
    }
  });

  it("非 POST 或不在认证前缀下的请求原样返回", () => {
    const get = new Request(`${APP}/api/auth/reset-password`, {
      headers: { cookie: "s=1" },
    });
    expect(normalizeOriginlessAuthPost(get)).toBe(get);

    const other = new Request(`${APP}/api/other/reset-password`, {
      method: "POST",
      headers: { cookie: "s=1" },
    });
    expect(normalizeOriginlessAuthPost(other)).toBe(other);
  });

  it("部署未配置来源时回退到请求自身来源", () => {
    delete process.env.BETTER_AUTH_URL;
    const request = authPost("/reset-password", { cookie: "s=1" });
    expect(normalizeOriginlessAuthPost(request).headers.get("origin")).toBe(
      APP
    );
  });

  it("配置非法时同样回退，不至于丢掉兼容", () => {
    process.env.BETTER_AUTH_URL = "not-a-url";
    const request = authPost("/reset-password", { cookie: "s=1" });
    expect(normalizeOriginlessAuthPost(request).headers.get("origin")).toBe(
      APP
    );
  });
});
