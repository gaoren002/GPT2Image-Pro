import { db } from "@repo/database";
import * as schema from "@repo/database/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isEmailConfigured } from "../mail/client";
import {
  ResetPasswordEmail,
  VerifyEmailEmail,
} from "../mail/templates/primary-action-email";
import { sendEmail } from "../mail/utils";
import { registrationVerificationPlugin } from "./registration-verification-plugin";

function settingValue(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function configuredSocialProviders() {
  const githubClientId = settingValue("GITHUB_CLIENT_ID");
  const githubClientSecret = settingValue("GITHUB_CLIENT_SECRET");
  const googleClientId = settingValue("GOOGLE_CLIENT_ID");
  const googleClientSecret = settingValue("GOOGLE_CLIENT_SECRET");

  return {
    ...(githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
      : {}),
    ...(googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : {}),
  };
}

/**
 * Better Auth 服务端配置
 *
 * 此文件配置 Better Auth 的核心功能:
 * - 数据库适配器 (Drizzle + PostgreSQL)
 * - OAuth 提供商 (GitHub, Google)
 * - 会话配置
 * - 用户自定义字段
 */
export const auth = betterAuth({
  /**
   * 注册扩展插件
   */
  plugins: [registrationVerificationPlugin()],

  /**
   * 基础 URL 配置
   * 用于 OAuth 回调和邮件链接
   */
  baseURL: settingValue("BETTER_AUTH_URL", "http://localhost:3000"),

  /**
   * 信任的来源(CSRF / 登录来源校验)
   *
   * 必须用【运行时可读】的 env:`NEXT_PUBLIC_*` 会被 Next 在构建期内联成固定值,运行时改它无效
   * (反代后默认仍是 localhost、域名对不上 → 浏览器 Origin=反代域名不被信任 → 登录失败)。
   * 故改用运行时读取的 `BETTER_AUTH_URL`,并支持用逗号分隔的 `BETTER_AUTH_TRUSTED_ORIGINS` 追加
   * 额外来源(如反代域名、多个域名)。部署在反代后:把这两个设成实际访问域名即可。
   */
  trustedOrigins: Array.from(
    new Set(
      [
        settingValue("BETTER_AUTH_URL", "http://localhost:3000"),
        ...settingValue("BETTER_AUTH_TRUSTED_ORIGINS")
          .split(",")
          .map((origin) => origin.trim()),
      ].filter(Boolean)
    )
  ),

  /**
   * 数据库配置
   * 使用 Drizzle 适配器连接 PostgreSQL
   */
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  /**
   * 用户自定义字段配置
   * 将 role, banned, bannedReason 字段包含在会话用户中
   */
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false, // 用户不能通过注册/更新设置此字段
      },
      banned: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false, // 用户不能通过注册/更新设置此字段
      },
      bannedReason: {
        type: "string",
        required: false,
        input: false, // 用户不能通过注册/更新设置此字段
      },
    },
  },

  /**
   * 邮箱密码认证配置
   */
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your password - GPT2IMAGE",
        react: ResetPasswordEmail({
          resetUrl: url,
          name: user.name || "there",
        }),
      });
    },
  },

  /**
   * 邮箱验证配置
   */
  ...(isEmailConfigured()
    ? {
        emailVerification: {
          sendOnSignUp: false,
          sendVerificationEmail: async ({ user, url }) => {
            await sendEmail({
              to: user.email,
              subject: "Verify your email - GPT2IMAGE",
              react: VerifyEmailEmail({
                verifyUrl: url,
                name: user.name || "there",
              }),
            });
          },
        },
      }
    : {}),

  /**
   * OAuth 社交登录提供商配置
   * 需要在 .env 中配置相应的 Client ID 和 Secret
   */
  socialProviders: configuredSocialProviders(),

  /**
   * 会话配置
   */
  session: {
    // 会话过期时间: 7 天
    expiresIn: 60 * 60 * 24 * 7,
    // 刷新阈值: 1 天 (会话剩余不足 1 天时自动刷新)
    updateAge: 60 * 60 * 24,
    // 避免切换账号后客户端短时间读取到上一个账号的用户快照。
    cookieCache: {
      enabled: false,
    },
  },

  /**
   * CSRF 与来源校验保持 Better Auth 默认开启(不设 advanced.disableCSRFCheck)。
   *
   * WHY:曾为修复微信/QQ 内置浏览器重置密码 403 而全局关闭 CSRF 校验,但那同时
   * 关掉了"跨站导航登录"拦截,第三方页面可用普通表单让访客登录到他人账号
   * (Login CSRF,2026-10-24 审查以真实配置复现)。内置浏览器兼容改在路由层处理:
   * 对缺失 Origin 的会话无关 POST(重置密码、登录、注册等)去掉 Cookie 后再交给
   * Better Auth,见 ./origin-compat.ts。也不要改用 disableOriginCheck:它会连带
   * 跳过 callbackURL/redirectTo 校验,带来开放重定向风险。
   */
});

/**
 * 导出类型以供其他模块使用
 */
export type Auth = typeof auth;
