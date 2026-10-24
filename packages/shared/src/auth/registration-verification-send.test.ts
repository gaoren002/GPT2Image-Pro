/**
 * 注册验证码发送失败的对外文案测试（DB-free）。
 *
 * 约束：发码接口对匿名调用方开放，邮件服务原始错误（可能含内网地址、端口、服务商
 * 细节）只写服务端日志，抛给调用方的必须是通用文案；失败后清除已写入的验证码记录。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ||=
  "postgres://test:test@127.0.0.1:5432/gpt2image_test";

const state = vi.hoisted(() => ({
  deletes: 0,
  inserts: 0,
  warnings: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock("@repo/database", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@repo/database/schema"
  );
  return {
    ...schema,
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      delete: () => ({
        where: async () => {
          state.deletes += 1;
        },
      }),
      insert: () => ({
        values: async () => {
          state.inserts += 1;
        },
      }),
    },
  };
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
}));
vi.mock("./registration-fixed-code", () => ({
  getRegistrationFixedCode: async () => null,
}));
vi.mock("../mail/templates/primary-action-email", () => ({
  RegistrationVerificationCodeEmail: () => null,
}));
vi.mock("../mail/utils", () => ({
  sendEmail: async () => ({
    success: false,
    provider: "smtp",
    error: "connect ECONNREFUSED 10.0.0.5:587",
  }),
}));
vi.mock("../logger", () => ({
  logWarn: (_message: string, data?: Record<string, unknown>) => {
    state.warnings.push(data);
  },
}));

import {
  REGISTRATION_CODE_SEND_FAILED_MESSAGE,
  RegistrationVerificationError,
  sendRegistrationVerificationCode,
} from "./registration-verification";

describe("sendRegistrationVerificationCode 发信失败", () => {
  beforeEach(() => {
    state.deletes = 0;
    state.inserts = 0;
    state.warnings.length = 0;
  });

  it("对外只返回通用文案，原始错误进入服务端日志", async () => {
    const error = await sendRegistrationVerificationCode(
      "new-user@example.com"
    ).catch((caught: unknown) => caught);

    // 必须是可展示错误类型：路由层只回显该类型，其余转通用文案。
    expect(error).toBeInstanceOf(RegistrationVerificationError);
    const message = (error as Error).message;
    expect(message).toBe(REGISTRATION_CODE_SEND_FAILED_MESSAGE);
    expect(message).not.toContain("10.0.0.5");
    expect(state.warnings).toEqual([
      { provider: "smtp", error: "connect ECONNREFUSED 10.0.0.5:587" },
    ]);
  });

  it("发送失败后删除刚写入的验证码记录", async () => {
    await sendRegistrationVerificationCode("new-user@example.com").catch(
      () => undefined
    );
    expect(state.inserts).toBe(1);
    // 写入前清理旧记录一次，发送失败后再删除一次。
    expect(state.deletes).toBe(2);
  });
});
