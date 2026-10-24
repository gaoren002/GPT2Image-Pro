import { randomInt, randomUUID } from "node:crypto";
import { db, verification } from "@repo/database";
import { eq } from "drizzle-orm";
import {
  getRegistrationEmailRejectionMessage,
  getRegistrationEmailRejectionReason,
  normalizeEmail,
} from "./email-domain";
import { isRegistrationEmailTaken } from "./registration-identity";
import {
  EXPIRES_IN_MINUTES,
  encodeCodeValue,
  evaluateVerificationAttempt,
  getResendCooldownRemainingSeconds,
} from "./registration-verification-core";
import { logWarn } from "../logger";
import { RegistrationVerificationCodeEmail } from "../mail/templates/primary-action-email";
import { sendEmail } from "../mail/utils";
import { isSelfUseModeEnabled } from "./self-use-mode";
import { getRegistrationFixedCode } from "./registration-fixed-code";
import { matchesRegistrationFixedCode } from "./registration-fixed-code-core";
import { getRuntimeRegistrationEmailPolicy } from "./registration-email-policy";

const PURPOSE = "registration-email-code";
const CODE_LENGTH = 6;

/** 发信失败时对外返回的通用文案；具体原因只记录在服务端日志。 */
export const REGISTRATION_CODE_SEND_FAILED_MESSAGE =
  "Failed to send verification code, please try again later";

/**
 * 可直接展示给调用方的发码错误（自用模式关闭注册、邮箱不合规、已注册、冷却中、发信失败）。
 *
 * WHY 单独定义类型：发码接口对匿名调用方开放，而本函数内部还会访问数据库，
 * drizzle 的错误消息带完整 SQL 与绑定参数（其中包括明文验证码）。路由层只回显本类型的
 * 消息，其余一律转通用文案，避免把内部细节暴露给未鉴权调用方。
 */
export class RegistrationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationVerificationError";
  }
}

function getIdentifier(email: string) {
  return `${PURPOSE}:${normalizeEmail(email)}`;
}

function generateCode() {
  return Array.from({ length: CODE_LENGTH }, () => randomInt(0, 10)).join("");
}

export async function sendRegistrationVerificationCode(email: string) {
  if (await isSelfUseModeEnabled()) {
    throw new RegistrationVerificationError(
      "Registration is disabled in self-use mode"
    );
  }

  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new RegistrationVerificationError("Invalid email address");
  }

  const emailPolicy = await getRuntimeRegistrationEmailPolicy();
  const rejectionReason = getRegistrationEmailRejectionReason(
    normalizedEmail,
    emailPolicy
  );
  if (rejectionReason) {
    throw new RegistrationVerificationError(
      getRegistrationEmailRejectionMessage(rejectionReason, emailPolicy)
    );
  }

  if (await isRegistrationEmailTaken(normalizedEmail)) {
    throw new RegistrationVerificationError("Email already registered");
  }

  // 固定邀请码模式仍执行邮箱格式、域名与重复账号检查，但不创建一次性验证码，
  // 也不调用邮件服务。该分支用于受邀小范围开放，邀请码只在注册提交时校验。
  if (await getRegistrationFixedCode()) {
    return { simulated: true };
  }

  const identifier = getIdentifier(normalizedEmail);

  // 每邮箱发码冷却（审计 S-H6）：复用上一封验证码行的 createdAt 判断间隔，
  // 冷却期内拒绝再次发送，防止对任意白名单邮箱无限轰炸放大邮件出账成本。
  const [existing] = await db
    .select({ createdAt: verification.createdAt })
    .from(verification)
    .where(eq(verification.identifier, identifier))
    .limit(1);

  const cooldownRemaining = getResendCooldownRemainingSeconds(
    existing?.createdAt,
    new Date()
  );
  if (cooldownRemaining > 0) {
    throw new RegistrationVerificationError(
      `Please wait ${cooldownRemaining} seconds before requesting another code`
    );
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRES_IN_MINUTES * 60 * 1000);

  await db.delete(verification).where(eq(verification.identifier, identifier));
  await db.insert(verification).values({
    id: randomUUID(),
    identifier,
    value: encodeCodeValue(code, 0),
    expiresAt,
  });

  const result = await sendEmail({
    to: normalizedEmail,
    subject: "Your GPT2IMAGE verification code",
    react: RegistrationVerificationCodeEmail({
      code,
      expiresIn: `${EXPIRES_IN_MINUTES} minutes`,
    }),
  });

  if (!result.success) {
    await db
      .delete(verification)
      .where(eq(verification.identifier, identifier));
    // 发码接口对匿名调用方开放，邮件服务原始错误可能含内网地址、端口或服务商细节，
    // 只写日志，对外统一返回通用文案。
    logWarn("注册验证码邮件发送失败", {
      provider: result.provider,
      error: result.error,
    });
    throw new RegistrationVerificationError(
      REGISTRATION_CODE_SEND_FAILED_MESSAGE
    );
  }

  return { simulated: result.simulated ?? false };
}

export async function verifyRegistrationCode(email: string, code: string) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedCode = code.trim();

  if (!normalizedEmail || !normalizedCode) {
    return false;
  }

  const fixedCode = await getRegistrationFixedCode();
  if (fixedCode) {
    return matchesRegistrationFixedCode(fixedCode, normalizedCode);
  }

  const identifier = getIdentifier(normalizedEmail);
  const [record] = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, identifier))
    .limit(1);

  if (!record) {
    return false;
  }

  // 状态机判定（过期 / 锁定 / 匹配 / 失败计数）抽到 DB-free 纯函数，
  // 这里只按其结论执行对应的 DB 副作用（删除或写回新尝试次数）。
  const decision = evaluateVerificationAttempt(
    record,
    normalizedCode,
    new Date()
  );

  if (decision.shouldDelete) {
    await db.delete(verification).where(eq(verification.id, record.id));
    return decision.outcome === "valid";
  }

  if (decision.nextValue !== null) {
    await db
      .update(verification)
      .set({ value: decision.nextValue })
      .where(eq(verification.id, record.id));
  }

  return false;
}
