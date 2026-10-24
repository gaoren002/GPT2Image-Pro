/**
 * 用户资料字段规则（不依赖 Zod）。
 *
 * 使用方：服务端 updateProfileSchema（Zod，Server Action 的权威校验）与设置页资料表单的
 * 客户端即时校验共用这里的常量和判定，避免规则漂移；客户端因此不必把完整 Zod 打进
 * 设置页首屏。规则变化时两边自动同步，一致性由 profile-rules.test.ts 对照 Zod 结果约束。
 */

import {
  MODERATION_BLOCK_RISK_LEVELS,
  type ModerationBlockRiskLevel,
} from "@repo/shared/config/subscription-plan";

export const PROFILE_NAME_MIN_LENGTH = 2;
export const PROFILE_NAME_MAX_LENGTH = 50;
export const PROFILE_IMAGE_MAX_LENGTH = 255;

export const PROFILE_MESSAGES = {
  nameTooShort: `名称至少需要 ${PROFILE_NAME_MIN_LENGTH} 个字符`,
  nameTooLong: `名称最多 ${PROFILE_NAME_MAX_LENGTH} 个字符`,
  imageTooLong: "头像路径过长",
  invalidRiskLevel: "审核拦截等级无效",
} as const;

export type ProfileFields = {
  name?: string;
  image?: string;
  moderationBlockRiskLevel?: ModerationBlockRiskLevel;
};

/**
 * 按资料规则逐字段校验。
 *
 * @param values 表单值；undefined 字段视为未提交（与 Zod optional 一致）
 * @returns 每个违规字段的第一条消息；全部合法时返回空对象
 */
export function getProfileFieldErrors(values: {
  name?: unknown;
  image?: unknown;
  moderationBlockRiskLevel?: unknown;
}): Partial<Record<keyof ProfileFields, string>> {
  const errors: Partial<Record<keyof ProfileFields, string>> = {};
  if (values.name !== undefined) {
    if (typeof values.name !== "string")
      errors.name = PROFILE_MESSAGES.nameTooShort;
    else if (values.name.length < PROFILE_NAME_MIN_LENGTH)
      errors.name = PROFILE_MESSAGES.nameTooShort;
    else if (values.name.length > PROFILE_NAME_MAX_LENGTH)
      errors.name = PROFILE_MESSAGES.nameTooLong;
  }
  if (
    values.image !== undefined &&
    (typeof values.image !== "string" ||
      values.image.length > PROFILE_IMAGE_MAX_LENGTH)
  ) {
    errors.image = PROFILE_MESSAGES.imageTooLong;
  }
  if (
    values.moderationBlockRiskLevel !== undefined &&
    !(MODERATION_BLOCK_RISK_LEVELS as readonly unknown[]).includes(
      values.moderationBlockRiskLevel
    )
  ) {
    errors.moderationBlockRiskLevel = PROFILE_MESSAGES.invalidRiskLevel;
  }
  return errors;
}
