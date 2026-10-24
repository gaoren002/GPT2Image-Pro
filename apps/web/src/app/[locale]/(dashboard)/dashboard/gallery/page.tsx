/** 图库服务端页面；按应用时区筛选，按标签读取实体并保留多图展开的分页语义。 */
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
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { GalleryClient } from "@/features/image-generation/components/gallery-client";
import {
  type GenerationListSearchParams,
  getSingleGenerationListParam,
  normalizeGenerationListPage,
} from "@/features/image-generation/generation-list-filters";
import { parseGenerationListDates } from "@/features/image-generation/generation-list-dates";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "@/features/image-generation/generation-metadata";
import { hasMoreGalleryItems } from "@/features/image-generation/gallery-pagination";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";

interface GalleryPageProps {
  searchParams: Promise<GenerationListSearchParams>;
}

type GalleryOutputRole = "final" | "agent_draft" | "upload";
type GalleryTab = "final" | "agent-drafts" | "uploads";

function extractAgentDraftGenerations(
  rows: Array<typeof generation.$inferSelect>
) {
  return rows.flatMap((g) => {
    const referenceImages = extractGenerationReferenceImages(g.metadata);
    const outputImage =
      g.metadata &&
      typeof g.metadata === "object" &&
      !Array.isArray(g.metadata) &&
      g.metadata.outputImage &&
      typeof g.metadata.outputImage === "object" &&
      !Array.isArray(g.metadata.outputImage)
        ? (g.metadata.outputImage as Record<string, unknown>)
        : null;
    const outputs = Array.isArray(outputImage?.imageOutputs)
      ? outputImage.imageOutputs
      : [];
    return outputs.flatMap((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const output = item as Record<string, unknown>;
      if (output.role !== "agent_draft" && output.primary !== false) return [];
      const storageKey =
        typeof output.storageKey === "string" ? output.storageKey : null;
      const storedImageUrl = buildSignedStorageImageUrl(
        storageKey,
        g.storageBucket
      );
      const fallbackImageUrl =
        typeof output.imageUrl === "string" ? output.imageUrl : null;
      if (!storedImageUrl && !fallbackImageUrl) return [];
      const generationId =
        typeof output.generationId === "string"
          ? output.generationId
          : `${g.id}-${index + 1}`;
      return [
        {
          id: generationId,
          parentId: g.id,
          prompt: g.prompt,
          revisedPrompt:
            typeof output.revisedPrompt === "string"
              ? output.revisedPrompt
              : g.revisedPrompt,
          promptRepairNotice: extractPromptRepairNotice(g.metadata),
          model: g.model,
          size: typeof output.size === "string" ? output.size : g.size,
          status: g.status,
          creditsConsumed: 0,
          storageKey,
          storageBucket: g.storageBucket,
          imageUrl: storedImageUrl || fallbackImageUrl,
          createdAt: g.createdAt.toISOString(),
          outputRole: "agent_draft" as GalleryOutputRole,
          referenceImages,
        },
      ];
    });
  });
}

function formatUploadedImageSize(
  image: ReturnType<typeof extractGenerationReferenceImages>[number],
  copy: (en: string, zh: string) => string
) {
  if (image.sizeBytes && image.sizeBytes > 0) {
    const megabytes = image.sizeBytes / 1024 / 1024;
    return `${megabytes >= 0.1 ? megabytes.toFixed(1) : "<0.1"} MB`;
  }
  return copy("Uploaded", "上传图");
}

function extractUploadedImageGenerations(
  rows: Array<typeof generation.$inferSelect>,
  copy: (en: string, zh: string) => string
) {
  return rows.flatMap((g) => {
    const referenceImages = extractGenerationReferenceImages(g.metadata);
    return referenceImages.map((image, index) => ({
      id: `${g.id}-upload-${image.id || index + 1}`,
      parentId: g.id,
      prompt: g.prompt,
      revisedPrompt: g.revisedPrompt,
      promptRepairNotice: extractPromptRepairNotice(g.metadata),
      model: image.type || copy("User upload", "用户上传"),
      size: formatUploadedImageSize(image, copy),
      status: "completed" as const,
      creditsConsumed: 0,
      storageKey: image.storageKey,
      storageBucket: image.storageBucket,
      imageUrl: image.imageUrl,
      createdAt: g.createdAt.toISOString(),
      outputRole: "upload" as GalleryOutputRole,
      referenceImages,
    }));
  });
}

export default async function GalleryPage({ searchParams }: GalleryPageProps) {
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
  const tab = getSingleGenerationListParam(params.tab);
  const activeTab: GalleryTab =
    tab === "agent-drafts"
      ? "agent-drafts"
      : tab === "uploads"
        ? "uploads"
        : "final";
  const page = normalizeGenerationListPage(params.page, PAGE_SIZE);
  const limit = page * PAGE_SIZE;
  // 关键词搜索:提示词/改写词/模型 ilike 子串(三个标签页共用);
  // 模型精确筛选 + 日期范围一并并入公共条件。
  const keyword = getSingleGenerationListParam(params.q).trim().slice(0, 120);
  const modelFilter = getSingleGenerationListParam(params.model).trim();
  const { fromInput, toInput, fromDate, toDate } = parseGenerationListDates(
    params,
    timeZone
  );
  const keywordCondition = and(
    keyword
      ? or(
          ilike(generation.prompt, `%${keyword}%`),
          ilike(generation.revisedPrompt, `%${keyword}%`),
          ilike(generation.model, `%${keyword}%`)
        )
      : undefined,
    modelFilter ? eq(generation.model, modelFilter) : undefined,
    fromDate ? gte(generation.createdAt, fromDate) : undefined,
    toDate ? lte(generation.createdAt, toDate) : undefined
  );
  const finalCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey),
    sql`NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(${generation.metadata}::jsonb->'outputImage'->'imageOutputs', '[]'::jsonb)) AS output
      WHERE output->>'role' = 'agent_draft' AND output->>'primary' = 'true'
    )`,
    keywordCondition
  );
  // finalCount 徽标:避免对 finalCondition 的 NOT EXISTS 做无 LIMIT 全表计数(~2.5s)。
  // 改用集合差:完成且有图的总数 − 其中"主体为 agent_draft"的数(后者走 GIN，~2ms),
  // 两项都廉价,结果与原 NOT EXISTS 计数完全一致(已校验 63610 = 63610)。
  const completedStorageCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey),
    keywordCondition
  );
  const draftPrimaryCondition = and(
    completedStorageCondition,
    sql`(${generation.metadata}::jsonb) @? '$.outputImage.imageOutputs[*] ? (@.role == "agent_draft" && @.primary == true)'`,
    keywordCondition
  );
  // @? jsonpath 谓词:命中"含 agent_draft 输出，或存在非主输出(primary=false)"的行。
  // 与原 EXISTS(jsonb_array_elements ...) 逐行解析完全等价(已校验命中数一致),
  // 但可走 generation_metadata_gin_idx（jsonb_path_ops GIN），把单查从 ~2.3s 降到 ~11ms。
  const draftCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey),
    isNotNull(generation.metadata),
    sql`(${generation.metadata}::jsonb) @? '$.outputImage.imageOutputs[*] ? (@.role == "agent_draft" || @.primary == false)'`,
    keywordCondition
  );
  // @? jsonpath 谓词:命中"inputImages.images 至少有一个元素"的行。等价于原
  // jsonb_array_length(... ) > 0（已校验命中数一致），可走 generation_metadata_gin_idx。
  const uploadCondition = and(
    eq(generation.userId, user.id),
    isNotNull(generation.metadata),
    sql`(${generation.metadata}::jsonb) @? '$.inputImages.images[0]'`,
    keywordCondition
  );
  // 每个标签仅查询自身要展示的实体行；其余标签只保留徽章 COUNT，
  // 避免读取并解析当前页面用不到的 metadata。
  const isFinalTab = activeTab === "final";
  const [
    finalRows,
    completedStorageCountResult,
    draftPrimaryCountResult,
    draftParentRows,
    uploadParentRows,
    draftCountResult,
    uploadCountResult,
    modelRows,
  ] = await Promise.all([
    isFinalTab
      ? db
          .select()
          .from(generation)
          .where(finalCondition)
          .orderBy(desc(generation.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof generation.$inferSelect>),
    db
      .select({ count: count() })
      .from(generation)
      .where(completedStorageCondition),
    db.select({ count: count() }).from(generation).where(draftPrimaryCondition),
    activeTab === "agent-drafts"
      ? db
          .select()
          .from(generation)
          .where(draftCondition)
          .orderBy(desc(generation.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof generation.$inferSelect>),
    activeTab === "uploads"
      ? db
          .select()
          .from(generation)
          .where(uploadCondition)
          .orderBy(desc(generation.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof generation.$inferSelect>),
    // 徽章计数：独立 COUNT 查询，避免加载全部行到内存
    // 注意：draft 的 COUNT 是父行数（近似值），因为每个父行可能通过
    // extractAgentDraftGenerations 展开为多个子项，但作为徽章计数足够
    db.select({ count: count() }).from(generation).where(draftCondition),
    db.select({ count: count() }).from(generation).where(uploadCondition),
    // 模型下拉选项:该用户完成生成的历史里实际用过的模型
    db
      .selectDistinct({ model: generation.model })
      .from(generation)
      .where(eq(generation.userId, user.id))
      .orderBy(generation.model),
  ]);

  const modelOptions = (modelRows as Array<{ model: string | null }>)
    .map((row) => row.model)
    .filter((value): value is string => Boolean(value));

  const allItems =
    activeTab === "agent-drafts"
      ? extractAgentDraftGenerations(draftParentRows)
      : activeTab === "uploads"
        ? extractUploadedImageGenerations(uploadParentRows, copy)
        : finalRows.map((g) => ({
            id: g.id,
            parentId: g.id,
            prompt: g.prompt,
            revisedPrompt: g.revisedPrompt,
            promptRepairNotice: extractPromptRepairNotice(g.metadata),
            model: g.model,
            size: g.size,
            status: g.status,
            creditsConsumed: g.creditsConsumed,
            storageKey: g.storageKey,
            storageBucket: g.storageBucket,
            imageUrl: buildSignedStorageImageUrl(g.storageKey, g.storageBucket),
            createdAt: g.createdAt.toISOString(),
            outputRole: "final" as GalleryOutputRole,
            referenceImages: extractGenerationReferenceImages(g.metadata),
            isLayered: hasLayeredMeta(g.metadata),
          }));

  const finalCount =
    (completedStorageCountResult[0]?.count ?? 0) -
    (draftPrimaryCountResult[0]?.count ?? 0);
  const draftCount = draftCountResult[0]?.count ?? 0;
  const uploadCount = uploadCountResult[0]?.count ?? 0;
  const totalParentCount =
    activeTab === "agent-drafts"
      ? draftCount
      : activeTab === "uploads"
        ? uploadCount
        : finalCount;
  const hasMore = hasMoreGalleryItems({
    itemCount: allItems.length,
    limit,
    parentCount:
      activeTab === "agent-drafts"
        ? draftParentRows.length
        : activeTab === "uploads"
          ? uploadParentRows.length
          : finalRows.length,
    totalParentCount,
  });

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy("Gallery", "图库")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy("Your generated images", "你生成的图片")}
        </p>
      </div>
      <GalleryClient
        key={`${activeTab}-${page}-${keyword}-${modelFilter}-${fromInput}-${toInput}`}
        initialGenerations={allItems.slice(0, limit)}
        hasMore={hasMore}
        finalCount={finalCount}
        draftCount={draftCount}
        uploadCount={uploadCount}
        activeTab={activeTab}
        page={page}
        timeZone={timeZone}
        searchQuery={keyword}
        searchModel={modelFilter}
        searchFrom={fromInput}
        searchTo={toInput}
        modelOptions={modelOptions}
      />
    </div>
  );
}
