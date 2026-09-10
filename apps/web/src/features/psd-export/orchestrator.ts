/**
 * 分层 PSD 导出编排:把一次"生成即分层"的 agent 产物组装成可编辑的分层 PSD,存储并返回签名下载链接。
 *
 * WHY:分层由生成阶段完成——agent 先出整图,再逐层生成(背景一张、各前景元素各一张,元素在纯白底上)。
 * 各层产物已随 generation 落库,角色记录在 metadata.outputImage.layered(见 image-generation/operations.ts)。
 * 本编排只负责"取层 → 元素层抠白底转透明 → ag-psd 组装"(见 assemble-layers.ts),**不生成新图、不扣费**。
 *
 * 注意:这是"生成式分层",层与层之间可能有尺度/位置漂移,标准叠加为近似还原而非像素级还原。
 *
 * 使用方:apps/web 的 server action / UOL image.exportPsd。CPU 主要花在逐元素 ISNet 抠图 + ag-psd 写盘。
 */
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { nanoid } from "nanoid";
import { getGenerationById } from "@/features/image-generation/queries";
import { assembleLayeredPsd, type LayerSpec } from "./assemble-layers";
import { readLayeredMeta } from "./layered-meta";

/** PSD 签名下载链接有效期(秒)。 */
const PSD_SIGNED_URL_TTL_SECONDS = 7200;

export type ExportLayeredPsdInput = {
  userId: string;
  /** 分层产物所属 generation。 */
  generationId: string;
  /** 预先算好的 PSD 存储 key(异步导出:action 先返回签名 URL,后台用同一 key 写入)。 */
  psdStorageKey?: string;
};

export type ExportLayeredPsdResult = {
  psdStorageKey: string;
  psdSignedUrl: string;
};

/**
 * 执行分层 PSD 导出:取各层 → 元素层抠白底 → 组装 → 存储 → 返回签名下载链接。
 *
 * @throws 产物不存在/无权/未完成、非分层生成、或可用层不足时抛错。
 */
export async function exportLayeredPsdForUser(
  input: ExportLayeredPsdInput
): Promise<ExportLayeredPsdResult> {
  const base = await getGenerationById(input.generationId);
  if (!base || base.userId !== input.userId) {
    throw new Error("产物不存在或无权访问");
  }
  if (base.status !== "completed") {
    throw new Error("产物尚未完成,无法导出 PSD");
  }

  const layeredMeta = readLayeredMeta(base.metadata);
  if (!layeredMeta) {
    throw new Error("该图不是分层生成产物,无法导出分层 PSD");
  }

  const bucket = base.storageBucket || "generations";
  const storage = await getStorageProvider();

  // 取背景层 + 各前景元素层(整图仅作合成预览,不入图层)。按 order 自底向上排序。
  const stackLayers = layeredMeta.layers
    .filter((layer) => layer.role !== "composite")
    .sort((a, b) => a.order - b.order);
  if (stackLayers.length === 0) {
    throw new Error("分层产物缺少可组装的图层");
  }

  let elementIndex = 0;
  const layers: LayerSpec[] = await Promise.all(
    stackLayers.map(async (layer) => {
      const opaque = layer.role === "background";
      if (!opaque) elementIndex += 1;
      const name = opaque ? "背景" : `元素 ${elementIndex}`;
      const image = await storage.getObject(layer.storageKey, bucket);
      // 背景层不抠图、铺满不透明;元素层(白底生成)交给组装环节抠白底转透明。
      return { name, image, opaque };
    })
  );

  // 合成预览:优先用整图层,否则退化为背景层(assemble 内部兜底)。
  const compositeLayer = layeredMeta.layers.find(
    (layer) => layer.role === "composite"
  );
  const composite = compositeLayer
    ? await storage.getObject(compositeLayer.storageKey, bucket)
    : undefined;

  const psdBuffer = await assembleLayeredPsd({ layers, composite });

  const psdStorageKey =
    input.psdStorageKey || `${input.userId}/${nanoid(32)}.psd`;
  await storage.putObject(
    psdStorageKey,
    bucket,
    psdBuffer,
    "image/vnd.adobe.photoshop"
  );
  const psdSignedUrl =
    buildSignedStorageImageUrl(
      psdStorageKey,
      bucket,
      PSD_SIGNED_URL_TTL_SECONDS
    ) || "";
  return { psdStorageKey, psdSignedUrl };
}
