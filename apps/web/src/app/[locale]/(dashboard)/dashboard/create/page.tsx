import { getCurrentUser } from "@repo/shared/auth/server";

import { getCreditsBalance } from "@repo/shared/credits/core";
import { isContentModerationEnabled } from "@repo/shared/moderation";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { CreatePageClient } from "@/features/image-generation/components/create-page-client";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";
import { getRuntimeImageBaseCreditPricing } from "@/features/image-generation/pricing-settings";
import { getUserRecentGenerations } from "@/features/image-generation/queries";
import { getUserApiConfig } from "@/features/image-generation/service";
import {
  getUserImageBackendPreference,
  listImageBackendGroupOptions,
} from "@/features/image-backend-pool/service";

const DEFAULT_FORCE_WEB_MIN_PIXELS = 660_000;
const DEFAULT_FORCE_WEB_MAX_PIXELS = 2_000_000;

export default async function CreatePage() {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);

  // 三组查询此前为三段串行 await,相互独立时可并行;plan 本身只查一次,
  // 依赖它的下游(uploadLimits/backendGroups/preference/capabilities)挂在
  // 同一个 planPromise 链上,与无依赖查询并发执行。
  const planPromise = getUserPlan(user.id);
  const [
    creditsData,
    recentGenerations,
    plan,
    userApiConfig,
    timeZone,
    uploadLimits,
    backendGroups,
    selectedBackendGroupId,
    moderationEnabled,
    capabilities,
    imageBasePricing,
    forceWebMinPixels,
    forceWebMaxPixels,
  ] = await Promise.all([
    getCreditsBalance(user.id),
    getUserRecentGenerations(user.id, 6),
    planPromise,
    getUserApiConfig(user.id),
    getAppTimeZone(),
    planPromise.then((p) => getPlanUploadLimits(p.plan)),
    // 报价需要看到 mixed 父组的全部可用子组（包括不允许用户直接选择的隐藏组），
    // 否则页面无法预测服务端实际命中的子组倍率。
    planPromise.then((p) => listImageBackendGroupOptions({ plan: p.plan })),
    planPromise.then((p) =>
      getUserImageBackendPreference(user.id, p.plan)
    ),
    isContentModerationEnabled(),
    planPromise.then((p) => getPlanCapabilitySnapshot(p.plan)),
    getRuntimeImageBaseCreditPricing(),
    getRuntimeSettingNumber(
      "IMAGE_FORCE_WEB_MIN_PIXELS",
      DEFAULT_FORCE_WEB_MIN_PIXELS,
      { nonNegative: true }
    ),
    getRuntimeSettingNumber(
      "IMAGE_FORCE_WEB_MAX_PIXELS",
      DEFAULT_FORCE_WEB_MAX_PIXELS,
      { positive: true }
    ),
  ]);
  const forceWebPixelRange = {
    minPixels: Math.min(forceWebMinPixels, forceWebMaxPixels),
    maxPixels: Math.max(forceWebMinPixels, forceWebMaxPixels),
  };

  const balance = creditsData?.balance || 0;

  const recents = recentGenerations.map((g) => ({
    id: g.id,
    prompt: g.prompt,
    revisedPrompt: g.revisedPrompt,
    model: g.model,
    size: g.size,
    creditsConsumed: g.creditsConsumed,
    status: g.status,
    imageUrl: buildSignedStorageImageUrl(g.storageKey, g.storageBucket),
    isLayered: hasLayeredMeta(g.metadata),
    createdAt: g.createdAt.toISOString(),
  }));

  return (
    <CreatePageClient
      balance={balance}
      recentGenerations={recents}
      plan={plan.plan}
      capabilities={capabilities}
      uploadLimits={uploadLimits}
      backendGroups={backendGroups.map((group) => ({
        id: group.id,
        name: group.name,
        isDefault: group.isDefault,
        backendType: group.backendType,
        contentSafetyEnabled: group.contentSafetyEnabled,
        billingMultiplier: group.billingMultiplier,
        qualityMultipliers: group.qualityMultipliers ?? null,
        modelQualityMultipliers: group.modelQualityMultipliers ?? null,
        childGroupIds: group.childGroupIds,
      }))}
      selectedBackendGroupId={selectedBackendGroupId}
      customApiActive={Boolean(userApiConfig)}
      moderationEnabled={moderationEnabled}
      imageBasePricing={imageBasePricing}
      forceWebPixelRange={forceWebPixelRange}
      timeZone={timeZone}
    />
  );
}
