/**
 * 外部图片接口的型号输入归一化，仅依赖纯 resolution 模块。
 * 传输层保留图片别名，统一操作在选定分组后决定默认覆盖或拒绝。
 */
import { getImageModel } from "@/features/image-generation/resolution";

/**
 * 接收已经通过字符串类型校验的图片型号；空白沿用默认，未知非空别名保留。
 * 无副作用，不校验文本型号，也不替代统一操作中的分组/型号/权限校验。
 */
export function normalizeExternalImageModelInput(model = ""): string {
  return getImageModel(model) ?? model.trim();
}
