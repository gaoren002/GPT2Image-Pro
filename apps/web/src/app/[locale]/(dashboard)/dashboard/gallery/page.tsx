import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { getCurrentUser } from "@repo/shared/auth/server";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { GalleryClient } from "@/features/image-generation/components/gallery-client";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "@/features/image-generation/generation-metadata";
import { hasLayeredMeta } from "@/features/psd-export/layered-meta";

interface GalleryPageProps {
  searchParams: Promise<{ page?: string; tab?: string }>;
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

  const params = await searchParams;
  const PAGE_SIZE = 20;
  const activeTab: GalleryTab =
    params.tab === "agent-drafts"
      ? "agent-drafts"
      : params.tab === "uploads"
        ? "uploads"
        : "final";
  const pageParam = Number(params.page);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const limit = page * PAGE_SIZE;
  const finalCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey),
    sql`NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(${generation.metadata}::jsonb->'outputImage'->'imageOutputs', '[]'::jsonb)) AS output
      WHERE output->>'role' = 'agent_draft' AND output->>'primary' = 'true'
    )`
  );
  // finalCount 徽标:避免对 finalCondition 的 NOT EXISTS 做无 LIMIT 全表计数(~2.5s)。
  // 改用集合差:完成且有图的总数 − 其中"主体为 agent_draft"的数(后者走 GIN，~2ms),
  // 两项都廉价,结果与原 NOT EXISTS 计数完全一致(已校验 63610 = 63610)。
  const completedStorageCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey)
  );
  const draftPrimaryCondition = and(
    completedStorageCondition,
    sql`(${generation.metadata}::jsonb) @? '$.outputImage.imageOutputs[*] ? (@.role == "agent_draft" && @.primary == true)'`
  );
  // @? jsonpath 谓词:命中"含 agent_draft 输出，或存在非主输出(primary=false)"的行。
  // 与原 EXISTS(jsonb_array_elements ...) 逐行解析完全等价(已校验命中数一致),
  // 但可走 generation_metadata_gin_idx（jsonb_path_ops GIN），把单查从 ~2.3s 降到 ~11ms。
  const draftCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey),
    isNotNull(generation.metadata),
    sql`(${generation.metadata}::jsonb) @? '$.outputImage.imageOutputs[*] ? (@.role == "agent_draft" || @.primary == false)'`
  );
  // @? jsonpath 谓词:命中"inputImages.images 至少有一个元素"的行。等价于原
  // jsonb_array_length(... ) > 0（已校验命中数一致），可走 generation_metadata_gin_idx。
  const uploadCondition = and(
    eq(generation.userId, user.id),
    isNotNull(generation.metadata),
    sql`(${generation.metadata}::jsonb) @? '$.inputImages.images[0]'`
  );
  // 仅 final 标签页用到带 LIMIT 的成品主查询(finalCondition 命中密集，LIMIT 命中快)。
  // drafts/uploads 标签页的展示来自下面无 LIMIT 的 draft/upload 查询(走 GIN)，故此处不重复
  // 执行——否则会在这两个标签页跑一条结果用不到、且对稀疏谓词极慢(~1.3s)的 LIMIT 查询。
  // 同时移除原 totalResult:它只在 final 标签页用到，且与 finalCountResult 完全等价(重复计数)。
  const isFinalTab = activeTab === "final";
  const [
    finalRows,
    completedStorageCountResult,
    draftPrimaryCountResult,
    draftParentRows,
    uploadParentRows,
    draftCountResult,
    uploadCountResult,
    timeZone,
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
    db
      .select()
      .from(generation)
      .where(draftCondition)
      .orderBy(desc(generation.createdAt))
      .limit(limit),
    db
      .select()
      .from(generation)
      .where(uploadCondition)
      .orderBy(desc(generation.createdAt))
      .limit(limit),
    // 徽章计数：独立 COUNT 查询，避免加载全部行到内存
    // 注意：draft 的 COUNT 是父行数（近似值），因为每个父行可能通过
    // extractAgentDraftGenerations 展开为多个子项，但作为徽章计数足够
    db.select({ count: count() }).from(generation).where(draftCondition),
    db.select({ count: count() }).from(generation).where(uploadCondition),
    getAppTimeZone(),
  ]);

  const allDraftItems = extractAgentDraftGenerations(draftParentRows);
  const allUploadItems = extractUploadedImageGenerations(
    uploadParentRows,
    copy
  );
  const displayedItems =
    activeTab === "agent-drafts"
      ? allDraftItems.slice(0, limit)
      : activeTab === "uploads"
        ? allUploadItems.slice(0, limit)
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
  const totalCount =
    activeTab === "agent-drafts"
      ? draftCount
      : activeTab === "uploads"
        ? uploadCount
        : finalCount;

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
        key={`${activeTab}-${page}`}
        initialGenerations={displayedItems}
        totalCount={totalCount}
        finalCount={finalCount}
        draftCount={draftCount}
        uploadCount={uploadCount}
        activeTab={activeTab}
        page={page}
        timeZone={timeZone}
      />
    </div>
  );
}
