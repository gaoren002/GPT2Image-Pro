/** 画布图片读取服务；绑定 UOL 并供已认证的页面/Action 调用，依赖 Drizzle 和存储签名。 */
import "server-only";

import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import {
  bindExecute,
  getPrincipalUserId,
  invokeOperation,
  OperationError,
} from "@repo/shared/uol";
import {
  type CanvasImageSource,
  canvasListImages,
} from "@repo/shared/uol/operations/canvas";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

bindExecute<Record<string, never>, CanvasImageSource[]>(
  canvasListImages.name,
  /** 身份只来自 principal；SQL 在排序和 limit 之前过滤归属、状态及空键，不展开附图。 */
  async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    // protected 在网关允许 system；没有用户身份时不能推测或扩大查询范围。
    if (!userId?.trim()) {
      throw new OperationError("forbidden", "User identity required");
    }

    const rows = await db
      .select({
        id: generation.id,
        prompt: generation.prompt,
        storageKey: generation.storageKey,
        storageBucket: generation.storageBucket,
      })
      .from(generation)
      .where(
        and(
          eq(generation.userId, userId),
          eq(generation.status, "completed"),
          isNotNull(generation.storageKey),
          sql`btrim(${generation.storageKey}) <> ''`
        )
      )
      .orderBy(desc(generation.createdAt), desc(generation.id))
      .limit(36);

    return rows.flatMap((row) => {
      const url = buildSignedStorageImageUrl(row.storageKey, row.storageBucket);
      if (!url) return [];
      return [
        {
          id: row.id,
          prompt: row.prompt,
          url,
          thumbnailUrl: buildStorageThumbnailUrl(url, 320) ?? url,
        },
      ];
    });
  }
);

/**
 * 为已认证的服务端调用者读取本人图片；userId 必须来自会话，不能转发客户端输入。
 * 经真实 UOL 网关执行，返回最多 36 张主图；数据库或签名失败按网关错误上抛。
 */
export async function listCanvasImagesForUser(
  userId: string
): Promise<CanvasImageSource[]> {
  return invokeOperation<CanvasImageSource[]>(
    canvasListImages.name,
    {},
    {
      type: "user",
      userId,
      role: "user",
    }
  );
}
