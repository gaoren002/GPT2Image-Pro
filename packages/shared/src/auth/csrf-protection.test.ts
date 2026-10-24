/**
 * 认证 CSRF 防护回归测试（DB-free）。
 *
 * 被测：./index 导出的真实 auth 实例（真实 options 与注册插件）配合路由层兼容函数。
 * 替换边界：drizzleAdapter 换成 Better Auth 自带 memoryAdapter；@repo/database 只供
 * 插件钩子查询封禁状态，返回空结果。
 * Better Auth 在测试模式（NODE_ENV=test 或 TEST 为真）下会自动跳过来源校验，测试将无法
 * 反映线上行为；这里以 NODE_ENV=development、TEST=false 加载（来源与 CSRF 校验逻辑与生产
 * 一致，且不启用内置限流干扰断言），结束后恢复原环境变量。
 */

import { afterAll, describe, expect, it, vi } from "vitest";

const mem = vi.hoisted(() => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    TEST: process.env.TEST,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  };
  // NODE_ENV 在 Next 类型中为只读，经 Reflect 写入。
  Reflect.set(process.env, "NODE_ENV", "development");
  process.env.TEST = "false";
  process.env.BETTER_AUTH_URL = "https://app.example.test";
  process.env.BETTER_AUTH_SECRET = "test-only-secret-0123456789abcdef0123456789";
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  type Rows = Array<Record<string, unknown>>;
  const db: {
    user: Rows;
    session: Rows;
    account: Rows;
    verification: Rows;
  } = { user: [], session: [], account: [], verification: [] };
  return { originalEnv, db };
});

vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await vi.importActual<
    typeof import("better-auth/adapters/memory")
  >("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(mem.db) };
});

vi.mock("@repo/database", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@repo/database/schema"
  );
  const emptyRows = () =>
    Object.assign(Promise.resolve([]), { limit: async () => [] });
  const query = {
    from: () => ({ where: emptyRows }),
  };
  return { ...schema, db: { select: () => query } };
});

import type { BetterAuthOptions } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { auth } from "./index";
import { stripCookiesForOriginlessAuthPost } from "./origin-compat";

const APP = "https://app.example.test";
const EMAIL = "member@example.com";
const PASSWORD = "Member-Passw0rd!";

async function seedMember() {
  if (mem.db.user.some((row) => row.email === EMAIL)) return;
  const now = new Date();
  mem.db.user.push({
    id: "member-user",
    name: "Member",
    email: EMAIL,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
    role: "user",
    banned: false,
    bannedReason: null,
  });
  mem.db.account.push({
    id: "member-credential",
    accountId: "member-user",
    providerId: "credential",
    userId: "member-user",
    password: await hashPassword(PASSWORD),
    createdAt: now,
    updatedAt: now,
  });
}

function signInRequest(headers: Record<string, string>, clientIp: string) {
  return new Request(`${APP}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": clientIp,
      ...headers,
    },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
  });
}

function resetPasswordRequest(headers: Record<string, string>) {
  return new Request(`${APP}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: "unknown-token", newPassword: "N3w-pass!" }),
  });
}

afterAll(() => {
  for (const [key, value] of Object.entries(mem.originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("认证 CSRF 防护", () => {
  it("配置不得全局关闭 CSRF 或来源校验", () => {
    const options: BetterAuthOptions = auth.options;
    expect(options.advanced?.disableCSRFCheck).not.toBe(true);
    expect(options.advanced?.disableOriginCheck).toBeUndefined();
  });

  it("第三方页面的跨站表单登录被拒绝且不写会话 Cookie", async () => {
    await seedMember();
    const response = await auth.handler(
      stripCookiesForOriginlessAuthPost(
        signInRequest(
          {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
          "203.0.113.20"
        )
      )
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
  });

  it("同源登录正常成功", async () => {
    await seedMember();
    const response = await auth.handler(
      stripCookiesForOriginlessAuthPost(
        signInRequest(
          {
            origin: APP,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
          },
          "203.0.113.21"
        )
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/session_token=/);
  });

  it("内置浏览器缺失 Origin 提交重置密码：兼容后通过来源校验，由令牌校验决定结果", async () => {
    const webviewHeaders = { cookie: "NEXT_LOCALE=zh" };

    const direct = await auth.handler(resetPasswordRequest(webviewHeaders));
    expect(direct.status).toBe(403);

    const compatible = await auth.handler(
      stripCookiesForOriginlessAuthPost(resetPasswordRequest(webviewHeaders))
    );
    expect(compatible.status).toBe(400);
    const body = (await compatible.json()) as { code?: string };
    expect(body.code).toBe("INVALID_TOKEN");
  });
});
