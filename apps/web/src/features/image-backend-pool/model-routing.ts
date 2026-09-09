/**
 * 目标主分组的图片型号和 Adobe 路由策略，供后端池选号、重试和结果配置共同使用。
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
  forceFirefly: boolean;
  fireflyOnly: boolean;
  excludeAdobeBackends: boolean;
};

/**
 * 按已校验的主组类型解析路由，无副作用；未知模型在非 Web 组原样保留。
 * Web 图片请求覆盖型号及 forceFirefly，聊天只清除 Adobe 意图并保留文本模型。
 * Adobe 和 Adobe 来源 API 会将普通图片型号改回 GPT Image 2，故纯 Web 组需排除它们。
 */
export function resolvePoolModelRouting(input: {
  groupBackendType: ImageBackendGroupBackendType;
  requestKind?: ImageBackendRequestKind;
  requestedModel?: string;
  forceFirefly?: boolean;
}): PoolModelRouting {
  const isWebGroup = input.groupBackendType === "web";
  const requestKind = input.requestKind || "image_generation";
  const isImageRequest =
    requestKind === "image_generation" || requestKind === "image_edit";
  const requestedModel =
    isWebGroup && isImageRequest ? DEFAULT_IMAGE_MODEL : input.requestedModel;
  const forceFirefly = !isWebGroup && input.forceFirefly === true;
  return {
    requestedModel,
    forceFirefly,
    fireflyOnly:
      !isWebGroup &&
      (forceFirefly ||
        (requestedModel || "").trim().toLowerCase().startsWith("firefly-")),
    excludeAdobeBackends: isWebGroup,
  };
}
