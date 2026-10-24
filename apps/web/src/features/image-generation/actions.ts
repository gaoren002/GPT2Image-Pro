"use server";

import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import {
  collectGenerationImageStorageReferences,
  type GenerationImageStorageReference,
} from "@repo/shared/generation-maintenance";
import { protectedAction } from "@repo/shared/safe-action";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { runImageGenerationForUser } from "./operations";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  validateImageSize,
} from "./resolution";

const generateImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
  size: z
    .string()
    .transform(alignImageSizeToStep)
    .optional()
    .refine((value) => !value || validateImageSize(value).valid, {
      message: "Invalid image size",
    }),
  model: z.string().optional(),
});

function referenceKey(ref: GenerationImageStorageReference) {
  return `${ref.bucket}:${ref.key}`;
}

export const generateImageAction = protectedAction
  .metadata({ action: "image-generation.generate" })
  .schema(generateImageSchema)
  .action(async ({ parsedInput, ctx }) => {
    return await runImageGenerationForUser({
      mode: "generate",
      userId: ctx.userId,
      prompt: parsedInput.prompt,
      size: parsedInput.size || DEFAULT_IMAGE_SIZE,
      model: parsedInput.model,
    });
  });

export const deleteGenerationAction = protectedAction
  .metadata({ action: "image-generation.delete" })
  .schema(z.object({ generationId: z.string() }))
  .action(async ({ parsedInput, ctx }) => {
    const gen = await db
      .select()
      .from(generation)
      .where(eq(generation.id, parsedInput.generationId))
      .limit(1);

    if (!gen[0] || gen[0].userId !== ctx.userId) {
      return { error: "Not found" };
    }
    // pending 任务可能仍在执行，或首笔扣费结果未知、等待超时清扫按行内额度退款；
    // 删除会让清扫看不到它，已入账的扣费从此无人退回。终态后才允许删除。
    if (gen[0].status === "pending") {
      return { error: "Generation is still in progress" };
    }

    const storageReferences = collectGenerationImageStorageReferences({
      storageKey: gen[0].storageKey,
      storageBucket: gen[0].storageBucket,
      metadata: gen[0].metadata,
    });
    const storageReferenceKeys = new Set(storageReferences.map(referenceKey));

    if (storageReferenceKeys.size > 0) {
      const otherGenerations = await db
        .select({
          storageKey: generation.storageKey,
          storageBucket: generation.storageBucket,
          metadata: generation.metadata,
        })
        .from(generation)
        .where(
          and(
            eq(generation.userId, ctx.userId),
            ne(generation.id, parsedInput.generationId)
          )
        );
      for (const other of otherGenerations) {
        for (const ref of collectGenerationImageStorageReferences(other)) {
          storageReferenceKeys.delete(referenceKey(ref));
        }
      }
    }

    if (storageReferenceKeys.size > 0) {
      try {
        const storage = await getStorageProvider();
        for (const ref of storageReferences) {
          if (!storageReferenceKeys.has(referenceKey(ref))) continue;
          await storage.deleteObject(ref.key, ref.bucket);
        }
      } catch {
        /* best effort */
      }
    }

    await db
      .delete(generation)
      .where(
        and(
          eq(generation.id, parsedInput.generationId),
          ne(generation.status, "pending")
        )
      );
    return { success: true };
  });

/**
 * 批量删除生成记录。
 * 逐条验证归属后,收集存储引用并去重(排除被其他记录共享的存储对象),
 * 然后尽力删除存储文件,最后批量删除 DB 记录。
 * 最多一次删除 100 条。
 */
export const batchDeleteGenerationAction = protectedAction
  .metadata({ action: "image-generation.batch-delete" })
  .schema(
    z.object({
      generationIds: z.array(z.string()).min(1).max(100),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    // 查出所有待删记录并校验归属
    const gens = await db
      .select()
      .from(generation)
      .where(
        and(
          inArray(generation.id, parsedInput.generationIds),
          eq(generation.userId, ctx.userId)
        )
      );

    // pending 任务保留给执行进程与超时清扫结算，见单条删除的说明。
    const deletable = gens.filter((g) => g.status !== "pending");
    const skippedPendingCount = gens.length - deletable.length;
    if (deletable.length === 0) {
      return { success: true, deletedCount: 0, skippedPendingCount };
    }

    const idsToDelete = deletable.map((g) => g.id);

    // 收集待删记录的全部存储引用
    const allRefs: GenerationImageStorageReference[] = [];
    const allRefKeys = new Set<string>();
    for (const g of deletable) {
      const refs = collectGenerationImageStorageReferences({
        storageKey: g.storageKey,
        storageBucket: g.storageBucket,
        metadata: g.metadata,
      });
      for (const ref of refs) {
        const key = referenceKey(ref);
        if (!allRefKeys.has(key)) {
          allRefKeys.add(key);
          allRefs.push(ref);
        }
      }
    }

    // 去重:排除被本用户其他记录(不在待删集中)仍在使用的存储对象
    const uniqueRefKeys = new Set(allRefKeys);
    if (uniqueRefKeys.size > 0) {
      const otherGenerations = await db
        .select({
          storageKey: generation.storageKey,
          storageBucket: generation.storageBucket,
          metadata: generation.metadata,
        })
        .from(generation)
        .where(
          and(
            eq(generation.userId, ctx.userId),
            notInArray(generation.id, idsToDelete)
          )
        );
      for (const other of otherGenerations) {
        for (const ref of collectGenerationImageStorageReferences(other)) {
          uniqueRefKeys.delete(referenceKey(ref));
        }
      }
    }

    // 尽力删除存储文件
    if (uniqueRefKeys.size > 0) {
      try {
        const storage = await getStorageProvider();
        for (const ref of allRefs) {
          if (!uniqueRefKeys.has(referenceKey(ref))) continue;
          await storage.deleteObject(ref.key, ref.bucket);
        }
      } catch {
        /* best effort */
      }
    }

    // 批量删除 DB 记录
    await db
      .delete(generation)
      .where(
        and(
          inArray(generation.id, idsToDelete),
          ne(generation.status, "pending")
        )
      );

    return {
      success: true,
      deletedCount: idsToDelete.length,
      skippedPendingCount,
    };
  });
