import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { getCurrentUser } from "@repo/shared/auth/server";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { HistoryClient } from "@/features/image-generation/components/history-client";
import { extractGenerationCreditDetails } from "@/features/image-generation/credit-calculation-details";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "@/features/image-generation/generation-metadata";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";

interface HistoryPageProps {
  searchParams: Promise<{
    page?: string;
    q?: string;
    status?: string;
    model?: string;
    from?: string;
    to?: string;
  }>;
}

/**
 * 历史记录查询条件:提示词/改写词/模型的子串匹配(大小写不敏感)+
 * 状态筛选。空搜索退化为全量(行为与旧版一致)。
 */
function buildHistoryWhere(
  userId: string,
  filters: {
    q?: string;
    status?: string;
    model?: string;
    from?: string;
    to?: string;
  }
): SQL | undefined {
  const conditions: Array<SQL | undefined> = [eq(generation.userId, userId)];
  const keyword = filters.q?.trim();
  if (keyword) {
    const pattern = `%${keyword}%`;
    conditions.push(
      or(
        ilike(generation.prompt, pattern),
        ilike(generation.revisedPrompt, pattern),
        ilike(generation.model, pattern)
      )
    );
  }
  if (
    filters.status === "completed" ||
    filters.status === "failed" ||
    filters.status === "pending"
  ) {
    conditions.push(eq(generation.status, filters.status));
  }
  // 模型精确匹配:下拉项来自该用户实际用过的模型,值可信
  if (filters.model?.trim()) {
    conditions.push(eq(generation.model, filters.model.trim()));
  }
  // 日期范围含当天(to 取当日末尾)
  const fromDate = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
  const toDate = filters.to ? new Date(`${filters.to}T23:59:59.999`) : null;
  if (fromDate && !Number.isNaN(fromDate.getTime())) {
    conditions.push(gte(generation.createdAt, fromDate));
  }
  if (toDate && !Number.isNaN(toDate.getTime())) {
    conditions.push(lte(generation.createdAt, toDate));
  }
  return and(...conditions);
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  const params = await searchParams;
  const PAGE_SIZE = 20;
  const pageParam = Number(params.page);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const where = buildHistoryWhere(user.id, params);

  // 模型下拉选项:该用户实际用过的模型(排除被关键词/状态过滤干扰,
  // 独立查询全量 distinct,通常个位数)
  const [generations, totalResult, timeZone, modelRows] = await Promise.all([
    db
      .select()
      .from(generation)
      .where(where)
      .orderBy(desc(generation.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(generation).where(where),
    getAppTimeZone(),
    db
      .selectDistinct({ model: generation.model })
      .from(generation)
      .where(eq(generation.userId, user.id))
      .orderBy(generation.model),
  ]);
  const modelOptions = modelRows
    .map((row) => row.model)
    .filter((value): value is string => Boolean(value));

  const withUrls = generations.map((g) => ({
    id: g.id,
    prompt: g.prompt,
    revisedPrompt: g.revisedPrompt,
    promptRepairNotice: extractPromptRepairNotice(g.metadata),
    model: g.model,
    size: g.size,
    status: g.status,
    creditsConsumed: g.creditsConsumed,
    creditDetails: extractGenerationCreditDetails(
      g.metadata,
      g.creditsConsumed
    ),
    error: g.error,
    storageKey: g.storageKey,
    storageBucket: g.storageBucket,
    imageUrl: buildSignedStorageImageUrl(g.storageKey, g.storageBucket),
    referenceImages: extractGenerationReferenceImages(g.metadata),
    isLayered: hasLayeredMeta(g.metadata),
    createdAt: g.createdAt.toISOString(),
  }));

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy("History", "历史记录")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy(
            "All generations, including failed and pending",
            "所有生成记录，包括失败和处理中的任务"
          )}
        </p>
      </div>
      <HistoryClient
        key={[
          page,
          params.q ?? "",
          params.status ?? "",
          params.model ?? "",
          params.from ?? "",
          params.to ?? "",
        ].join("|")}
        initialGenerations={withUrls}
        totalCount={totalResult[0]?.count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        timeZone={timeZone}
        searchQuery={params.q?.trim() ?? ""}
        searchStatus={params.status ?? ""}
        searchModel={params.model ?? ""}
        searchFrom={params.from ?? ""}
        searchTo={params.to ?? ""}
        modelOptions={modelOptions}
      />
    </div>
  );
}
