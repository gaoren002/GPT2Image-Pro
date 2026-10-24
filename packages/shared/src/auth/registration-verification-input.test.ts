/** 匿名注册发码的单邮箱边界；真实服务函数配 DB/邮件桩，禁止触网或访问业务库。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  emails: [] as string[],
  inserts: 0,
  deletes: 0,
  identityChecks: 0,
  selfUse: false,
  fixedCode: null as string | null,
  emailTaken: false,
  previousCodeAt: null as Date | null,
  allowedDomains: ["gmail.com", "qq.com", "163.com", "126.com", "example.com"],
  blockPlusAliases: false,
  blockDottedLocalParts: false,
}));

vi.mock("@repo/database", () => ({
  verification: { identifier: "identifier", createdAt: "createdAt", id: "id" },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            state.previousCodeAt ? [{ createdAt: state.previousCodeAt }] : [],
        }),
      }),
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
}));
vi.mock("./self-use-mode", () => ({
  isSelfUseModeEnabled: async () => state.selfUse,
}));
vi.mock("./registration-email-policy", () => ({
  getRuntimeRegistrationEmailPolicy: async () => ({
    allowedDomains: state.allowedDomains,
    blockPlusAliases: state.blockPlusAliases,
    blockDottedLocalParts: state.blockDottedLocalParts,
  }),
}));
vi.mock("./registration-identity", () => ({
  isRegistrationEmailTaken: async () => {
    state.identityChecks += 1;
    return state.emailTaken;
  },
}));
vi.mock("./registration-fixed-code", () => ({
  getRegistrationFixedCode: async () => state.fixedCode,
}));
vi.mock("../mail/templates/primary-action-email", () => ({
  RegistrationVerificationCodeEmail: () => null,
}));
vi.mock("../mail/utils", () => ({
  sendEmail: async ({ to }: { to: string }) => {
    state.emails.push(to);
    return { success: true, simulated: false };
  },
}));
vi.mock("../logger", () => ({ logWarn: vi.fn() }));

import {
  RegistrationVerificationError,
  sendRegistrationVerificationCode,
} from "./registration-verification";

/** 构造254/255字符、每个域名标签均不超过63字符的普通邮箱，避免以非法语法冒充长度测试。 */
function boundaryEmail(length: 254 | 255) {
  const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 193)}`;
  return { email: `${"a".repeat(64)}@${domain}`, domain };
}

describe("注册发码输入边界", () => {
  beforeEach(() => {
    state.emails.length = 0;
    state.inserts = 0;
    state.deletes = 0;
    state.identityChecks = 0;
    state.selfUse = false;
    state.fixedCode = null;
    state.emailTaken = false;
    state.previousCodeAt = null;
    state.allowedDomains = [
      "gmail.com",
      "qq.com",
      "163.com",
      "126.com",
      "example.com",
    ];
    state.blockPlusAliases = false;
    state.blockDottedLocalParts = false;
  });

  it.each([
    ["逗号多段", `${"x,".repeat(32)}fixture@gmail.com`],
    ["正则回退文本", `${"[x]".repeat(32)},fixture@gmail.com`],
    ["分号列表", "x;fixture@gmail.com"],
    ["地址组", "group:fixture@gmail.com"],
    ["注释", "fixture(comment)@gmail.com"],
    ["引号本地部分", '"fixture"@gmail.com'],
    ["尖括号", "<fixture>@gmail.com"],
    ["多邮箱", "one@gmail.com,two@qq.com"],
    ["嵌套注释公告样例", "Victim (x(y) <evil@example.com>) <v@gmail.com>"],
    ["组分号公告样例", "G: (a; <evil@example.com>) <v@gmail.com>;"],
    ["引号大于号公告样例", '<"a@example.com>"@gmail.com>'],
    ["内部换行", "fi\r\nxture@gmail.com"],
    ["连续点", "fixture..name@gmail.com"],
    ["起始点", ".fixture@gmail.com"],
    ["结束点", "fixture.@gmail.com"],
  ])("%s 在身份查询、验证码写入和 mailer 前拒绝", async (_name, email) => {
    await expect(sendRegistrationVerificationCode(email)).rejects.toMatchObject(
      {
        name: "RegistrationVerificationError",
        message: "Invalid email address",
      }
    );
    expect(state.identityChecks).toBe(0);
    expect(state.inserts).toBe(0);
    expect(state.deletes).toBe(0);
    expect(state.emails).toEqual([]);
  });

  it("255字符的语法合法单邮箱在 mailer 前拒绝", async () => {
    const { email, domain } = boundaryEmail(255);
    state.allowedDomains = [domain];
    expect(email.length).toBe(255);
    await expect(sendRegistrationVerificationCode(email)).rejects.toThrow(
      "Invalid email address"
    );
    expect(state.emails).toEqual([]);
    expect(state.inserts).toBe(0);
  });

  it("254字符边界仍能发送到允许域", async () => {
    const { email, domain } = boundaryEmail(254);
    state.allowedDomains = [domain];
    expect(email.length).toBe(254);
    await expect(sendRegistrationVerificationCode(email)).resolves.toEqual({
      simulated: false,
    });
    expect(state.emails).toEqual([email]);
  });

  it.each([
    "ordinary@gmail.com",
    "user+tag@gmail.com",
    "user.name+tag@example.com",
    "user@qq.com",
    "user@163.com",
    "user@126.com",
  ])("普通/plus/允许域邮箱 %s 保持可用", async (email) => {
    await sendRegistrationVerificationCode(email);
    expect(state.emails).toEqual([email]);
    expect(state.inserts).toBe(1);
  });

  it("保留首尾空白和大小写归一化", async () => {
    await sendRegistrationVerificationCode("  User+Tag@GMAIL.COM  ");
    expect(state.emails).toEqual(["user+tag@gmail.com"]);
  });

  it("保留域名和 plus 策略错误", async () => {
    await expect(
      sendRegistrationVerificationCode("user@outlook.com")
    ).rejects.toBeInstanceOf(RegistrationVerificationError);
    state.blockPlusAliases = true;
    await expect(
      sendRegistrationVerificationCode("user+tag@gmail.com")
    ).rejects.toThrow("Email aliases containing + are not allowed.");
    expect(state.emails).toEqual([]);
  });

  it("保留固定邀请码的无邮件/无验证码写入语义", async () => {
    state.fixedCode = "fixture-only";
    await expect(
      sendRegistrationVerificationCode("user@gmail.com")
    ).resolves.toEqual({ simulated: true });
    expect(state.emails).toEqual([]);
    expect(state.inserts).toBe(0);
    expect(state.deletes).toBe(0);
  });

  it("固定邀请码也不接受复杂地址", async () => {
    state.fixedCode = "fixture-only";
    await expect(
      sendRegistrationVerificationCode("x,user@gmail.com")
    ).rejects.toThrow("Invalid email address");
    expect(state.emails).toEqual([]);
  });

  it("保留自用模式先拒绝注册、已有邮箱和发码冷却", async () => {
    state.selfUse = true;
    await expect(sendRegistrationVerificationCode("invalid")).rejects.toThrow(
      "Registration is disabled in self-use mode"
    );
    state.selfUse = false;
    state.emailTaken = true;
    await expect(
      sendRegistrationVerificationCode("user@gmail.com")
    ).rejects.toThrow("Email already registered");
    state.emailTaken = false;
    state.previousCodeAt = new Date();
    await expect(
      sendRegistrationVerificationCode("user@gmail.com")
    ).rejects.toThrow(/Please wait .* seconds before requesting another code/);
    expect(state.emails).toEqual([]);
    expect(state.inserts).toBe(0);
  });
});
