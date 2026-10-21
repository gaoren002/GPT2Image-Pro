/**
 * 目标主分组的图片型号路由策略，供后端池选号、重试和结果配置共同使用。
 * 纯 Web 主组统一生成 GPT Image 2.5；mixed 主组的 Web 子组不触发该覆盖。
 * 仅依赖纯图像配置与类型，不读数据库，不决定套餐权限、分组归属或请求类型权限。
 */
import { DEFAULT_IMAGE_MODEL } from "@/features/image-generation/resolution";
import type {
  ImageBackendGroupBackendType,
  ImageBackendRequestKind,
} from "./types";

export type PoolModelRouting = {
  requestedModel: string | undefined;
};

/**
 * 按已校验的主组类型解析路由，无副作用；未知模型在非 Web 组原样保留。
 * Web 图片请求覆盖型号；聊天不随图片型号归一，保留顶层文本模型。
 */
export function resolvePoolModelRouting(input: {
  groupBackendType: ImageBackendGroupBackendType;
  requestKind?: ImageBackendRequestKind;
  requestedModel?: string;
}): PoolModelRouting {
  const isWebGroup = input.groupBackendType === "web";
  const requestKind = input.requestKind || "image_generation";
  const isImageRequest =
    requestKind === "image_generation" || requestKind === "image_edit";
  return {
    requestedModel:
      isWebGroup && isImageRequest ? DEFAULT_IMAGE_MODEL : input.requestedModel,
  };
}
