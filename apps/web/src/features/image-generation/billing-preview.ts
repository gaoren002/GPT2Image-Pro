/**
 * 创作页积分报价的路由与倍率预测。
 *
 * 本文件只包含 DB-free 纯函数，供客户端报价和服务端 Web-first 判定共同使用。
 * mixed 分组的报价必须先预测请求车道，再按父组倍率 × 预测子组倍率计算；否则
 * 页面会只展示父组价格，而服务端按实际子组倍率扣费。
 */
import type {
  ImageBackendAccountBackend,
  ImageBackendGroupBackendType,
} from "@/features/image-backend-pool/types";
import { normalizeGroupBillingMultiplier } from "@/features/image-backend-pool/group-billing";
import { getImageSizePixels, roundUpCreditAmount } from "./resolution";

export type ImageBillingPixelRange = {
  minPixels: number;
  maxPixels: number;
};

export type ImageBillingPreviewGroup = {
  id: string;
  name: string;
  backendType: ImageBackendGroupBackendType;
  billingMultiplier: number;
  childGroupIds: readonly string[];
};

export type PredictedImageBillingRoute = {
  groupId: string | null;
  groupName: string | null;
  backendType: ImageBackendGroupBackendType;
  billingMultiplier: number;
  parentGroupId: string | null;
  usesChildGroup: boolean;
};

/**
 * 判断本次图片请求是否应进入 Web-first 车道。
 *
 * @param input - 当前尺寸、用户开关、强制 Responses 标志与像素范围。
 * @returns true 表示服务端首先尝试 Web；false 表示预测走 Codex/Responses。
 * @remarks auto/无法解析尺寸沿用服务端语义，视为可以优先 Web。
 */
export function shouldPreferWebImageRoute(input: {
  size?: string | null;
  webFirst: boolean;
  requiresResponsesBackend?: boolean;
  pixelRange: ImageBillingPixelRange;
}) {
  if (input.requiresResponsesBackend || !input.webFirst) return false;
  const pixels = getImageSizePixels(input.size);
  if (pixels === null) return true;

  const minPixels = Math.max(
    0,
    Math.min(input.pixelRange.minPixels, input.pixelRange.maxPixels)
  );
  const maxPixels = Math.max(
    1,
    Math.max(input.pixelRange.minPixels, input.pixelRange.maxPixels)
  );
  return pixels >= minPixels && pixels <= maxPixels;
}

/**
 * 预测 mixed 父分组实际导向的子分组及合成计费倍率。
 *
 * @param input - 当前选中组、同套餐可用组以及预测车道。
 * @returns 预测命中组与父子相乘后的倍率；无匹配子组时安全回退父组。
 * @remarks 同车道有多个子组时按父组配置的 childGroupIds 顺序选择第一项。
 */
export function predictImageBillingRoute(input: {
  selectedGroup?: ImageBillingPreviewGroup | null;
  groups: readonly ImageBillingPreviewGroup[];
  preferredBackendType?: ImageBackendAccountBackend;
}): PredictedImageBillingRoute {
  const selectedGroup = input.selectedGroup;
  if (!selectedGroup) {
    return {
      groupId: null,
      groupName: null,
      backendType: input.preferredBackendType ?? "mixed",
      billingMultiplier: 1,
      parentGroupId: null,
      usesChildGroup: false,
    };
  }

  const parentMultiplier = normalizeGroupBillingMultiplier(
    selectedGroup.billingMultiplier
  );
  if (selectedGroup.backendType !== "mixed" || !input.preferredBackendType) {
    return {
      groupId: selectedGroup.id,
      groupName: selectedGroup.name,
      backendType: selectedGroup.backendType,
      billingMultiplier: parentMultiplier,
      parentGroupId: null,
      usesChildGroup: false,
    };
  }

  const groupMap = new Map(input.groups.map((group) => [group.id, group]));
  const predictedChild = selectedGroup.childGroupIds
    .map((groupId) => groupMap.get(groupId))
    .find((group) => group?.backendType === input.preferredBackendType);
  if (!predictedChild) {
    return {
      groupId: selectedGroup.id,
      groupName: selectedGroup.name,
      backendType: selectedGroup.backendType,
      billingMultiplier: parentMultiplier,
      parentGroupId: null,
      usesChildGroup: false,
    };
  }

  return {
    groupId: predictedChild.id,
    groupName: predictedChild.name,
    backendType: predictedChild.backendType,
    billingMultiplier: normalizeGroupBillingMultiplier(
      parentMultiplier * predictedChild.billingMultiplier
    ),
    parentGroupId: selectedGroup.id,
    usesChildGroup: true,
  };
}

/**
 * 把预测合成倍率应用到页面基础积分，并沿用服务端向上保留两位的规则。
 *
 * @param credits - 未应用后端分组倍率的积分。
 * @param billingMultiplier - predictImageBillingRoute 返回的合成倍率。
 * @returns 页面应展示的预测积分。
 */
export function applyBillingPreviewMultiplier(
  credits: number,
  billingMultiplier: number
) {
  const normalizedMultiplier =
    normalizeGroupBillingMultiplier(billingMultiplier);
  return normalizedMultiplier === 1
    ? credits
    : roundUpCreditAmount(credits * normalizedMultiplier);
}
