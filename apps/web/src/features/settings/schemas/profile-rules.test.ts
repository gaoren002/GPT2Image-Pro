/** profile-rules 与服务端 updateProfileSchema 的一致性：客户端即时校验不能放过 Zod 会拒绝的值。 */

import { describe, expect, it } from "vitest";
import {
  getProfileFieldErrors,
  PROFILE_IMAGE_MAX_LENGTH,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_NAME_MIN_LENGTH,
} from "./profile-rules";
import { updateProfileSchema } from "./update-profile";

/** Zod 的逐字段首条消息，形状与 getProfileFieldErrors 对齐。 */
function zodFieldErrors(values: Record<string, unknown>) {
  const result = updateProfileSchema.safeParse(values);
  if (result.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0]);
    errors[field] ??= issue.message;
  }
  return errors;
}

const name = (length: number) => "名".repeat(length);

describe("资料规则与 Zod schema 一致", () => {
  it.each([
    {},
    { name: "" },
    { name: name(PROFILE_NAME_MIN_LENGTH - 1) },
    { name: name(PROFILE_NAME_MIN_LENGTH) },
    { name: name(PROFILE_NAME_MAX_LENGTH) },
    { name: name(PROFILE_NAME_MAX_LENGTH + 1) },
    { image: "a".repeat(PROFILE_IMAGE_MAX_LENGTH) },
    { image: "a".repeat(PROFILE_IMAGE_MAX_LENGTH + 1) },
    { moderationBlockRiskLevel: "low" },
    { moderationBlockRiskLevel: "medium" },
    { moderationBlockRiskLevel: "high" },
    { moderationBlockRiskLevel: "extreme" },
    {
      name: name(1),
      image: "a".repeat(PROFILE_IMAGE_MAX_LENGTH + 1),
      moderationBlockRiskLevel: "none",
    },
  ])("字符串输入 %j 的判定与消息一致", (values) => {
    expect(getProfileFieldErrors(values)).toEqual(zodFieldErrors(values));
  });

  it.each([
    { name: 42 },
    { image: null },
    { moderationBlockRiskLevel: 1 },
  ])("非字符串输入 %j 两边都拒绝同一字段", (values) => {
    expect(Object.keys(getProfileFieldErrors(values))).toEqual(
      Object.keys(zodFieldErrors(values))
    );
    expect(Object.keys(getProfileFieldErrors(values))).toHaveLength(1);
  });
});
