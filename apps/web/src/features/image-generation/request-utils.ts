import { getStorageProvider } from "@repo/shared/storage/providers";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { logWarn } from "@repo/shared/logger";
import type { ImageInputFile } from "./types";

export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const TEMP_IMAGE_UPLOAD_URL_EXPIRES = 15 * 60;
export const VALID_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type TemporaryUploadedImage = {
  bucket: string;
  key: string;
  url: string;
};

export async function getImagePublicBaseUrl() {
  return (
    (await getRuntimeSettingString("CONTENT_MODERATION_PUBLIC_BASE_URL")) ||
    (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
    (await getRuntimeSettingString("BETTER_AUTH_URL")) ||
    ""
  ).replace(/\/$/, "");
}

function toAbsoluteImageUrl(url: string, publicBaseUrl: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!publicBaseUrl) return url;
  return `${publicBaseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function formatMegabytes(bytes: number) {
  return `${bytes / 1024 / 1024}MB`;
}

export function validateImageFile(
  file: File,
  options?: {
    mask?: boolean;
    maxImageBytes?: number;
    label?: string;
    invalidTypeMessage?: string;
  }
) {
  const label =
    options?.label || file.name || (options?.mask ? "Mask" : "Image");
  if (file.size <= 0) {
    throw new Error(`${label} is empty.`);
  }

  const maxImageBytes = options?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (file.size > maxImageBytes) {
    throw new Error(
      `${label} exceeds the ${formatMegabytes(maxImageBytes)} limit.`
    );
  }

  if (options?.mask) {
    if (file.type !== "image/png") {
      throw new Error(options.invalidTypeMessage || "Mask must be a PNG file.");
    }
    return;
  }

  if (!VALID_IMAGE_TYPES.has(file.type)) {
    throw new Error(
      options?.invalidTypeMessage ||
        "Source images must be PNG, JPEG, or WebP files."
    );
  }
}

export function getTotalUploadSize(files: File[], maskFile?: File) {
  return (
    files.reduce((total, file) => total + file.size, 0) + (maskFile?.size || 0)
  );
}

export async function toImageInput(
  file: File,
  options?: { publicUrl?: string; storageBucket?: string; storageKey?: string }
): Promise<ImageInputFile> {
  return {
    data: Buffer.from(await file.arrayBuffer()),
    name: file.name || "image.png",
    type: file.type || "image/png",
    url: options?.publicUrl,
    storageBucket: options?.storageBucket,
    storageKey: options?.storageKey,
  };
}

export async function uploadTemporaryImageUrls(
  userId: string,
  generationId: string,
  files: File[],
  options?: { scope?: string; signal?: AbortSignal }
): Promise<TemporaryUploadedImage[] | undefined> {
  options?.signal?.throwIfAborted();
  if (files.length === 0) return undefined;

  try {
    const publicBaseUrl = await getImagePublicBaseUrl();
    if (
      !(await getRuntimeSettingString("STORAGE_ENDPOINT")) &&
      !publicBaseUrl
    ) {
      return undefined;
    }

    const storage = await getStorageProvider();
    const bucket =
      (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
      "generations";

    return await Promise.all(
      files.map(async (file, index) => {
        options?.signal?.throwIfAborted();
        const extension =
          file.type === "image/jpeg"
            ? "jpg"
            : file.type === "image/webp"
              ? "webp"
              : "png";
        const scope = options?.scope || "requests";
        const key = `${userId}/${scope}/${generationId}-${index}.${extension}`;
        const data = Buffer.from(await file.arrayBuffer());
        options?.signal?.throwIfAborted();
        await storage.putObject(key, bucket, data, file.type || "image/png");
        options?.signal?.throwIfAborted();
        const url = await storage.getSignedUrl(
          key,
          bucket,
          TEMP_IMAGE_UPLOAD_URL_EXPIRES
        );
        return {
          bucket,
          key,
          url: toAbsoluteImageUrl(url, publicBaseUrl),
        };
      })
    );
  } catch (error) {
    // 取消必须中止整条输入链，不能降级为 base64 后继续上传或生成。
    options?.signal?.throwIfAborted();
    logWarn("临时图片 URL 上传失败，回退到 base64 输入", {
      generationId,
      fileCount: files.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export const uploadModerationImages = uploadTemporaryImageUrls;

export async function deleteTemporaryImages(
  images: TemporaryUploadedImage[] | undefined
) {
  if (!images?.length) return;

  const storage = await getStorageProvider();
  await Promise.allSettled(
    images.map((image) => storage.deleteObject(image.key, image.bucket))
  );
}

export const deleteModerationImages = deleteTemporaryImages;

export async function filesToImageInputs(
  files: File[],
  uploadedImages?: TemporaryUploadedImage[]
) {
  return await Promise.all(
    files.map((file, index) =>
      toImageInput(file, {
        publicUrl: uploadedImages?.[index]?.url,
        storageBucket: uploadedImages?.[index]?.bucket,
        storageKey: uploadedImages?.[index]?.key,
      })
    )
  );
}
