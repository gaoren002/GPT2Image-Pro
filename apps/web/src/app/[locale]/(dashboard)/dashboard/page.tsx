import { db } from "@repo/database";
import { creditsBalance, generation } from "@repo/database/schema";
import { auth } from "@repo/shared/auth";
import { formatCredits } from "@repo/shared/credits/format";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { and, count, desc, eq } from "drizzle-orm";
import { Coins, Image as ImageIcon, ImagePlus } from "lucide-react";
import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { ImagePricingChartCardLazy } from "@/features/dashboard/components/image-pricing-chart-card-lazy";
import {
  getUserImageBackendPreference,
  listImageBackendGroupOptions,
} from "@/features/image-backend-pool/service";
import { RecentCreationsClient } from "@/features/image-generation/components/recent-creations-client";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";
import { getRuntimeImageBaseCreditPricing } from "@/features/image-generation/pricing-settings";
import { getImageBaseCreditPricing } from "@/features/image-generation/resolution";
import { Link } from "@/i18n/routing";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { cn } from "@repo/ui/utils";

/**
 * 区块入场动画:上移淡入。
 * fill-mode-backwards 保证 delay 期间保持初始隐藏态(否则错峰时会先闪现再重播);
 * animation-duration-500 显式指定入场时长,与卡片 hover 的 duration-250(transition)互不干扰。
 */
const sectionEnterClass =
  "animate-in fade-in slide-in-from-bottom-2 animation-duration-500 fill-mode-backwards motion-reduce:animate-none";

/**
 * 卡片 hover 抬升:轻位移 + whisper 阴影 + 边框提亮。
 * Tailwind v4 的 -translate-y-* 产出原生 CSS translate 属性,过渡列表须写 translate 而非 transform。
 */
const cardLiftClass =
  "lift-hover motion-reduce:transition-none";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const user = session.user;
  const userId = user.id;
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  const [
    balanceData,
    recentGenerations,
    totalGenerationsResult,
    timeZone,
    imageBasePricing,
    userPlanInfo,
  ] = await Promise.all([
    db.query.creditsBalance.findFirst({
      where: eq(creditsBalance.userId, userId),
    }),
    db
      .select()
      .from(generation)
      .where(
        and(eq(generation.userId, userId), eq(generation.status, "completed"))
      )
      .orderBy(desc(generation.createdAt))
      .limit(4),
    db
      .select({ count: count() })
      .from(generation)
      .where(eq(generation.userId, userId)),
    getAppTimeZone(),
    getRuntimeImageBaseCreditPricing(),
    getUserPlan(userId),
  ]);

  const balance = formatCredits(balanceData?.balance ?? 0);
  const totalGenerations = totalGenerationsResult[0]?.count ?? 0;
  const normalizedImageBasePricing =
    getImageBaseCreditPricing(imageBasePricing);
  const [capabilities, backendGroups, selectedBackendGroupId] =
    await Promise.all([
      getPlanCapabilitySnapshot(userPlanInfo.plan),
      listImageBackendGroupOptions({ plan: userPlanInfo.plan }),
      getUserImageBackendPreference(userId, userPlanInfo.plan),
    ]);
  const activeBackendGroup =
    backendGroups.find((group) => group.id === selectedBackendGroupId) ||
    backendGroups.find((group) => group.isDefault) ||
    backendGroups[0] ||
    null;

  const generationsWithUrls = recentGenerations.map((gen) => ({
    id: gen.id,
    prompt: gen.prompt,
    revisedPrompt: gen.revisedPrompt,
    model: gen.model,
    size: gen.size,
    status: gen.status,
    creditsConsumed: gen.creditsConsumed,
    storageKey: gen.storageKey,
    storageBucket: gen.storageBucket,
    imageUrl: buildSignedStorageImageUrl(gen.storageKey, gen.storageBucket),
    isLayered: hasLayeredMeta(gen.metadata),
    createdAt: gen.createdAt.toISOString(),
  }));

  return (
    <div className="container mx-auto px-4 py-6 md:px-6">
      <div className="space-y-8">
        {/* 页头:编辑部式排版 —— 眉题 + 大号衬线标题 + muted 副行 */}
        <div className={cn("space-y-1.5", sectionEnterClass)}>
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {copy("Overview", "总览")}
          </p>
          <h1 className="font-serif text-3xl font-medium tracking-tight">
            {copy("Dashboard", "控制台")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {copy(`Welcome back, ${user.name}`, `欢迎回来，${user.name}`)}
          </p>
        </div>

        {/* Stats row:三卡以 80ms 步进错峰入场 */}
        <div className="grid gap-4 md:grid-cols-3">
          {/* Credits Balance Card */}
          <Card className={cn(sectionEnterClass, cardLiftClass)}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {copy("Credits Balance", "积分余额")}
              </CardTitle>
              <Coins className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            </CardHeader>
            <CardContent>
              <div className="font-serif text-3xl font-medium tracking-tight">
                {balance}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {copy(
                  `Base price: ${formatCredits(
                    normalizedImageBasePricing.base1024Credits
                  )} at 1024x1024 · ${formatCredits(
                    normalizedImageBasePricing.base4kCredits
                  )} at 4K`,
                  `基础价：1024x1024 为 ${formatCredits(
                    normalizedImageBasePricing.base1024Credits
                  )} · 4K 为 ${formatCredits(
                    normalizedImageBasePricing.base4kCredits
                  )}`
                )}
              </p>
            </CardContent>
          </Card>

          {/* Images Generated Card */}
          <Card className={cn(sectionEnterClass, cardLiftClass, "delay-80")}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {copy("Images Generated", "已生成图片")}
              </CardTitle>
              <ImageIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            </CardHeader>
            <CardContent>
              <div className="font-serif text-3xl font-medium tracking-tight">
                {totalGenerations}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {copy("total images created", "累计创建图片")}
              </p>
            </CardContent>
          </Card>

          {/* Quick Create Card */}
          <Card
            className={cn(
              "border-dashed",
              sectionEnterClass,
              cardLiftClass,
              "delay-160"
            )}
          >
            <CardContent className="flex h-full flex-col items-center justify-center gap-3 p-6">
              <ImagePlus
                className="h-8 w-8 text-muted-foreground"
                strokeWidth={1.5}
              />
              <Button asChild>
                <Link href="/dashboard/create" prefetch={false}>
                  {copy("Start Creating", "开始创作")}
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className={cn(sectionEnterClass, "delay-240")}>
          <ImagePricingChartCardLazy
            billing={{
              agentRoundCredits: capabilities.billing.agentRoundCredits,
              chatRoundCredits: capabilities.billing.chatRoundCredits,
              groupMultiplier: activeBackendGroup?.billingMultiplier ?? 1,
              groupName: activeBackendGroup?.name ?? null,
              moderationBlockingEnabled:
                capabilities.features["moderation.blocking"],
              monthlyCredits: capabilities.limits.monthlyCredits,
              planName: userPlanInfo.planName,
            }}
            isZh={isZh}
            pricing={normalizedImageBasePricing}
          />
        </div>

        {/* Recent Generations */}
        {generationsWithUrls.length > 0 && (
          <div className={cn(sectionEnterClass, "delay-320")}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-serif text-xl font-medium tracking-tight">
                {copy("Recent Creations", "最近创作")}
              </h2>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard/gallery" prefetch={false}>
                  {copy("View All", "查看全部")}
                </Link>
              </Button>
            </div>
            <RecentCreationsClient
              initialGenerations={generationsWithUrls}
              timeZone={timeZone}
            />
          </div>
        )}
      </div>
    </div>
  );
}
