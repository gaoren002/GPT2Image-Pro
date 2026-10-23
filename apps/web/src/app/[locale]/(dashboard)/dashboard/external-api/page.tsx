import { getServerSession } from "@repo/shared/auth/server";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getAppTimeZone } from "@repo/shared/time-zone/server";

import { getExternalApiKeys } from "@/features/settings/actions/external-api-key";
import { ExternalApiKeySection } from "@/features/settings/components/external-api-key-section";
import { buildExternalApiKeyInitialSnapshot } from "@/features/settings/external-api-key-snapshot";

export const metadata = {
  title: "External API | GPT2IMAGE",
  description: "Create and manage GPT2IMAGE external API keys",
};

/** 复用原受保护查询提供首屏快照，省去组件挂载后两次 action 往返。 */
export default async function ExternalApiPage() {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const [t, timeZone, keysResult, planResult] = await Promise.all([
    getTranslations("Settings.externalApi"),
    getAppTimeZone(),
    getExternalApiKeys(),
    getMyPlanAction(),
  ]);
  const initialSnapshot = buildExternalApiKeyInitialSnapshot(
    keysResult,
    planResult
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <ExternalApiKeySection
        timeZone={timeZone}
        initialSnapshot={initialSnapshot}
      />
    </div>
  );
}
