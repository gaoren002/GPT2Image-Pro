/** 无限画布图片来源契约；供页面、Action 和 agent 共用，执行体由 web 服务端绑定。 */
import { z } from "zod";
import { defineOperation } from "../registry";

export const canvasImageSourceSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  url: z.string().startsWith("/api/storage/"),
  thumbnailUrl: z.string().startsWith("/api/storage/"),
});

export type CanvasImageSource = z.infer<typeof canvasImageSourceSchema>;

export const canvasListImages = defineOperation({
  name: "canvas.listImages",
  domain: "image-generation",
  title: "获取画布图片来源",
  description:
    "返回调用者最近 36 张已完成且具有存储主图的生成记录；身份仅取 principal，" +
    "原图与 320 像素缩略图均为签名的站内相对地址。",
  input: z.strictObject({}),
  output: z.array(canvasImageSourceSchema).max(36),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  /** 纯契约不加载数据库；web 的 canvas/server 在首次使用前绑定真实执行体。 */
  execute: async () => {
    throw new Error("Not yet wired: canvas.listImages");
  },
});
