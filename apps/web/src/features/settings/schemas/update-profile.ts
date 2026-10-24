import { MODERATION_BLOCK_RISK_LEVELS } from "@repo/shared/config/subscription-plan";
import { z } from "zod";
import {
  PROFILE_IMAGE_MAX_LENGTH,
  PROFILE_MESSAGES,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_NAME_MIN_LENGTH,
} from "./profile-rules";

const moderationBlockRiskLevelSchema = z.enum(MODERATION_BLOCK_RISK_LEVELS, {
  error: PROFILE_MESSAGES.invalidRiskLevel,
});

/**
 * 更新用户资料的 Zod Schema（Server Action 的权威校验）。
 * 字段规则来自 profile-rules，设置页客户端表单复用同一规则做即时校验。
 *
 * @field name - 用户显示名称，最少 2 个字符，最多 50 个字符
 * @field image - 用户头像 (存储键名)，可选
 */
export const updateProfileSchema = z.object({
  name: z
    .string()
    .min(PROFILE_NAME_MIN_LENGTH, PROFILE_MESSAGES.nameTooShort)
    .max(PROFILE_NAME_MAX_LENGTH, PROFILE_MESSAGES.nameTooLong)
    .optional(),
  image: z
    .string()
    .max(PROFILE_IMAGE_MAX_LENGTH, PROFILE_MESSAGES.imageTooLong)
    .optional(),
  moderationBlockRiskLevel: moderationBlockRiskLevelSchema.optional(),
});

/**
 * 表单数据类型，从 Zod Schema 推断
 */
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
