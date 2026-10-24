import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { db, user as userTable } from "@repo/database";
import { eq } from "drizzle-orm";
import {
  getRegistrationEmailErrorCode,
  getRegistrationEmailRejectionMessage,
  getRegistrationEmailRejectionReason,
  normalizeEmail,
} from "./email-domain";
import { getRuntimeRegistrationEmailPolicy } from "./registration-email-policy";
import {
  isRegistrationEmailTaken,
  markRegistrationIdentityDeleted,
  recordRegistrationIdentity,
} from "./registration-identity";
import { getRegistrationFixedCode } from "./registration-fixed-code";
import { verifyRegistrationCode } from "./registration-verification";
import { isSelfUseModeEnabled } from "./self-use-mode";

function isPublicRegistrationPath(path?: string) {
  return (
    path === "/sign-up/email" ||
    path === "/sign-in/social" ||
    Boolean(path?.startsWith("/callback/"))
  );
}

async function assertRegistrationOpen() {
  if (await isSelfUseModeEnabled()) {
    throw new APIError("FORBIDDEN", {
      message: "Registration is disabled in self-use mode",
      code: "REGISTRATION_DISABLED",
    });
  }
}

async function assertAllowedRegistrationEmail(email: string) {
  const policy = await getRuntimeRegistrationEmailPolicy();
  const reason = getRegistrationEmailRejectionReason(email, policy);
  if (reason) {
    throw new APIError("BAD_REQUEST", {
      message: getRegistrationEmailRejectionMessage(reason, policy),
      code: getRegistrationEmailErrorCode(reason),
    });
  }
}

async function assertEmailNotRegistered(email: string) {
  const normalizedEmail = normalizeEmail(email);

  if (await isRegistrationEmailTaken(normalizedEmail)) {
    throw new APIError("BAD_REQUEST", {
      message: "Email already registered",
      code: "EMAIL_ALREADY_REGISTERED",
    });
  }
}

/**
 * 邮箱密码注册时，是否已证明注册人控制该邮箱。
 *
 * - 普通模式：before 钩子已要求发往该邮箱的一次性验证码，归属已证明，标记已验证；
 * - 固定邀请码模式：只校验共享邀请码，持码人可填写任意邮箱，归属未证明，必须保持未验证。
 *
 * WHY：Better Auth 只在本地账号邮箱已验证时才允许同邮箱的社交登录隐式关联
 * （accountLinking.requireLocalEmailVerified，默认开启）。若把未证明归属的邮箱标为
 * 已验证，先用他人邮箱注册的账号会在真正的邮箱主人用 Google/GitHub 登录时被关联，
 * 而先注册者的密码继续有效（2026-10-24 审查复现）。
 *
 * @returns 已证明归属返回 true；固定邀请码模式返回 false。
 * @throws 固定邀请码配置非法时抛错（before 钩子校验验证码时已会抛出同一错误）。
 */
async function isEmailOwnershipProvenAtSignUp() {
  return !(await getRegistrationFixedCode());
}

async function assertUserCanAuthenticate(userId: string) {
  const [existingUser] = await db
    .select({
      id: userTable.id,
      banned: userTable.banned,
      bannedReason: userTable.bannedReason,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  if (!existingUser?.banned) return;

  // 任意 banned=true 都拒绝创建会话/账户，不再只拦 account_deleted。
  // 否则管理员的普通封禁（banUserAction 写入的 banned=true + 普通原因）在 Web 通道形同摆设，
  // 被封用户重新登录即可创建新会话照常调用受保护操作（生图/扣费/工单/设置）。
  if (existingUser.bannedReason === "account_deleted") {
    throw new APIError("FORBIDDEN", {
      message: "Account has been deleted",
      code: "ACCOUNT_DELETED",
    });
  }

  throw new APIError("FORBIDDEN", {
    message: "Account has been banned",
    code: "ACCOUNT_BANNED",
  });
}

export const registrationVerificationPlugin = (): BetterAuthPlugin => ({
  id: "registration-verification",
  hooks: {
    before: [
      {
        matcher: (context) => context.path === "/sign-up/email",
        handler: createAuthMiddleware(async (ctx) => {
          await assertRegistrationOpen();

          const email =
            typeof ctx.body.email === "string" ? ctx.body.email : "";
          const verificationCode =
            typeof ctx.body.verificationCode === "string"
              ? ctx.body.verificationCode
              : "";
          const normalizedEmail = normalizeEmail(email);

          await assertAllowedRegistrationEmail(normalizedEmail);
          await assertEmailNotRegistered(normalizedEmail);

          if (!verificationCode) {
            throw new APIError("BAD_REQUEST", {
              message: "Verification code is required",
              code: "VERIFICATION_CODE_REQUIRED",
            });
          }

          const valid = await verifyRegistrationCode(
            normalizedEmail,
            verificationCode
          );

          if (!valid) {
            throw new APIError("BAD_REQUEST", {
              message: "Invalid or expired verification code",
              code: "INVALID_VERIFICATION_CODE",
            });
          }

          delete ctx.body.verificationCode;
          ctx.body.email = normalizedEmail;
        }),
      },
    ],
  },
  init: () => ({
    options: {
      databaseHooks: {
        user: {
          create: {
            before: async (user, context) => {
              if (isPublicRegistrationPath(context?.path)) {
                await assertRegistrationOpen();
              }

              const normalizedEmail = normalizeEmail(user.email);

              await assertAllowedRegistrationEmail(normalizedEmail);
              await assertEmailNotRegistered(normalizedEmail);

              if (context?.path === "/sign-up/email") {
                return {
                  data: {
                    ...user,
                    email: normalizedEmail,
                    emailVerified: await isEmailOwnershipProvenAtSignUp(),
                  },
                };
              }

              return {
                data: {
                  ...user,
                  email: normalizedEmail,
                },
              };
            },
            after: async (user) => {
              await recordRegistrationIdentity(user.email, user.id);
            },
          },
          delete: {
            after: async (user) => {
              await markRegistrationIdentityDeleted(user.email, user.id);
            },
          },
        },
        account: {
          create: {
            before: async (account) => {
              await assertUserCanAuthenticate(account.userId);
              return { data: account };
            },
          },
        },
        session: {
          create: {
            before: async (session) => {
              await assertUserCanAuthenticate(session.userId);
              return { data: session };
            },
          },
        },
      },
    },
  }),
});
