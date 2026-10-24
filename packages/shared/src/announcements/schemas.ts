import { z } from "zod";

import { announcementSeverityValues } from "./constants";
export * from "./constants";

const optionalDateSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) =>
    typeof value === "string" && value.trim() ? value.trim() : null
  );

export const createAnnouncementSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "标题至少需要 2 个字符")
    .max(160, "标题最多 160 个字符"),
  content: z
    .string()
    .trim()
    .min(2, "内容至少需要 2 个字符")
    .max(10000, "内容最多 10000 个字符"),
  severity: z.enum(announcementSeverityValues).default("info"),
  isPublished: z.boolean().default(false),
  isPinned: z.boolean().default(false),
  priority: z.coerce.number().int().min(0).max(999).default(0),
  publishedAt: optionalDateSchema,
  expiresAt: optionalDateSchema,
});

export const updateAnnouncementSchema = createAnnouncementSchema.extend({
  id: z.string().min(1, "公告 ID 不能为空"),
});

export const announcementIdSchema = z.object({
  id: z.string().min(1, "公告 ID 不能为空"),
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;
