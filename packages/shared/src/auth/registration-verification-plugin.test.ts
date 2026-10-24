/**
 * 注册插件的邮箱验证标记测试（DB-free）。
 *
 * 约束：只有证明了邮箱归属（普通模式的一次性验证码）的邮箱密码注册才标记已验证；
 * 固定邀请码模式下必须保持未验证，使 Better Auth 拒绝同邮箱社交登录的隐式关联。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ||=
  "postgres://test:test@127.0.0.1:5432/gpt2image_test";

const state = vi.hoisted(() => ({ fixedCode: null as string | null }));

vi.mock("@repo/database", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@repo/database/schema"
  );
  return { ...schema, db: {} };
});
vi.mock("./self-use-mode", () => ({
  isSelfUseModeEnabled: async () => false,
}));
vi.mock("./registration-email-policy", () => ({
  getRuntimeRegistrationEmailPolicy: async () => ({
    allowedDomains: ["example.com"],
    blockPlusAliases: false,
    blockDottedLocalParts: false,
  }),
}));
vi.mock("./registration-identity", () => ({
  isRegistrationEmailTaken: async () => false,
  recordRegistrationIdentity: async () => undefined,
  markRegistrationIdentityDeleted: async () => undefined,
}));
vi.mock("./registration-verification", () => ({
  verifyRegistrationCode: async () => true,
}));
vi.mock("./registration-fixed-code", () => ({
  getRegistrationFixedCode: async () => state.fixedCode,
}));

import { registrationVerificationPlugin } from "./registration-verification-plugin";

type UserCreateBefore = (
  user: Record<string, unknown>,
  context?: { path?: string }
) => Promise<{ data: Record<string, unknown> } | boolean | undefined>;

function getUserCreateBefore(): UserCreateBefore {
  const init = registrationVerificationPlugin().init as unknown as () => {
    options: {
      databaseHooks: { user: { create: { before: UserCreateBefore } } };
    };
  };
  return init().options.databaseHooks.user.create.before;
}

async function createViaSignUp(path: string) {
  const before = getUserCreateBefore();
  const result = await before(
    { email: "New.User@Example.com", name: "New", emailVerified: false },
    { path }
  );
  if (!result || typeof result !== "object") {
    throw new Error("expected hook data");
  }
  return result.data;
}

describe("邮箱密码注册的 emailVerified 标记", () => {
  beforeEach(() => {
    state.fixedCode = null;
  });

  it("普通模式（验证码已发往邮箱）标记已验证", async () => {
    const data = await createViaSignUp("/sign-up/email");
    expect(data.emailVerified).toBe(true);
    expect(data.email).toBe("new.user@example.com");
  });

  it("固定邀请码模式未证明邮箱归属，保持未验证", async () => {
    state.fixedCode = "INVITE-CODE-2026";
    const data = await createViaSignUp("/sign-up/email");
    expect(data.emailVerified).toBe(false);
  });

  it("社交登录创建用户时不改写提供方给出的验证状态", async () => {
    state.fixedCode = "INVITE-CODE-2026";
    const before = getUserCreateBefore();
    const result = await before(
      { email: "oauth@example.com", name: "OAuth", emailVerified: true },
      { path: "/callback/google" }
    );
    expect(result && typeof result === "object" && result.data.emailVerified).toBe(
      true
    );
  });
});
