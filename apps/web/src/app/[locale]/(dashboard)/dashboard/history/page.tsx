/** 历史记录服务端页面；按应用时区生成筛选边界，并查询当前用户的记录及分页总数。 */
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
import {
  type GenerationListSearchParams,
  getSingleGenerationListParam,
  normalizeGenerationListPage,
} from "@/features/image-generation/generation-list-filters";
import { parseGenerationListDates } from "@/features/image-generation/generation-list-dates";
import { extractGenerationCreditDetails } from "@/features/image-generation/credit-calculation-details";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "@/features/image-generation/generation-metadata";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";

interface HistoryPageProps {
  searchParams: Promise<GenerationListSearchParams>;
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
    fromDate: Date | null;
    toDate: Date | null;
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
  // 日期范围含结束日；调用方已按应用时区解析，不能再依赖进程 TZ。
  if (filters.fromDate) {
    conditions.push(gte(generation.createdAt, filters.fromDate));
  }
  if (filters.toDate) {
    conditions.push(lte(generation.createdAt, filters.toDate));
  }
  return and(...conditions);
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  const [params, timeZone] = await Promise.all([
    searchParams,
    getAppTimeZone(),
  ]);
  const PAGE_SIZE = 20;
  const page = normalizeGenerationListPage(params.page, PAGE_SIZE);
  const offset = (page - 1) * PAGE_SIZE;
  const queryInput = getSingleGenerationListParam(params.q).trim();
  const statusInput = getSingleGenerationListParam(params.status);
  const modelInput = getSingleGenerationListParam(params.model);
  const { fromInput, toInput, fromDate, toDate } = parseGenerationListDates(
    params,
    timeZone
  );

  const where = buildHistoryWhere(user.id, {
    q: queryInput,
    status: statusInput,
    model: modelInput,
    fromDate,
    toDate,
  });

  // 模型下拉选项:该用户实际用过的模型(排除被关键词/状态过滤干扰,
  // 独立查询全量 distinct,通常个位数)
  const [generations, totalResult, modelRows] = await Promise.all([
    db
      .select()
      .from(generation)
      .where(where)
      .orderBy(desc(generation.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(generation).where(where),
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
          queryInput,
          statusInput,
          modelInput,
          fromInput,
          toInput,
        ].join("|")}
        initialGenerations={withUrls}
        totalCount={totalResult[0]?.count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        timeZone={timeZone}
        searchQuery={queryInput}
        searchStatus={statusInput}
        searchModel={modelInput}
        searchFrom={fromInput}
        searchTo={toInput}
        modelOptions={modelOptions}
      />
    </div>
  );
}
