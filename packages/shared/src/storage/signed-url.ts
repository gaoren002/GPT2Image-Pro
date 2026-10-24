/**
 * 存储 URL 签名工具（服务端专用，含 node:crypto）
 *
 * 为 generations 桶的图像 URL 提供短时签名机制，防止未授权访问。
 * 使用 HMAC-SHA256 签名，签名密钥为 BETTER_AUTH_SECRET 环境变量。
 *
 * 签名覆盖内容：bucket + "/" + key + ":" + expiresAt（unix epoch 秒）
 * 验证使用 crypto.timingSafeEqual 防止时序攻击。
 *
 * 纯函数，不依赖数据库。供 API 路由与服务端 URL 构建层使用。
 *
 * WHY 服务端专用：本模块顶层 import node:crypto，被客户端可达代码 import 会把
 * 整套 crypto-browserify polyfill（约 450KB raw）打进 authed 公共包。不含
 * crypto 的纯 URL 工具（buildStorageThumbnailUrl / parseStorageImageUrl /
 * isPublicBucket）已拆到 ./image-url，客户端一律从那里 import；此处 re-export
 * 仅为既有服务端调用方保持兼容。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  buildStorageThumbnailUrl,
  isPublicBucket,
  parseStorageImageUrl,
} from "./image-url";
import { storageKeyBelongsToUser } from "./utils";

export * from "./image-url";

/**
 * 获取签名密钥。
 * 使用 BETTER_AUTH_SECRET，与 auth 系统共享密钥以避免引入新环境变量。
 */
function getSigningSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required for storage URL signing");
  }
  return secret;
}

/**
 * 构建签名消息（被签名的原始文本）。
 * 格式：bucket/key:expiresAt
 */
function buildSignatureMessage(
  bucket: string,
  key: string,
  expiresAt: number
): string {
  return `${bucket}/${key}:${expiresAt}`;
}

/**
 * 计算 HMAC-SHA256 签名，返回 hex 字符串。
 */
function computeHmac(message: string, secret: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * 生成带签名的图像 URL 查询参数。
 *
 * @param bucket - 存储桶名
 * @param key - 文件键名
 * @param expiresInSeconds - 签名有效期（秒），默认 3600（1 小时）
 * @returns 包含 sig 和 exp 的对象，用于拼接 URL 查询参数
 *
 * @example
 * ```ts
 * const { sig, exp } = generateSignedImageParams("generations", "user-1/abc.png");
 * const url = `/api/storage/generations/user-1/abc.png?sig=${sig}&exp=${exp}`;
 * ```
 */
export function generateSignedImageParams(
  bucket: string,
  key: string,
  expiresInSeconds = 3600
): { sig: string; exp: number } {
  const secret = getSigningSecret();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const message = buildSignatureMessage(bucket, key, expiresAt);
  const sig = computeHmac(message, secret);
  return { sig, exp: expiresAt };
}

/**
 * 生成带签名的完整相对 URL。
 *
 * @param bucket - 存储桶名
 * @param key - 文件键名
 * @param expiresInSeconds - 签名有效期（秒），默认 3600
 * @returns 带 sig 和 exp 查询参数的相对 URL
 */
export function generateSignedImageUrl(
  bucket: string,
  key: string,
  expiresInSeconds = 3600
): string {
  if (isPublicBucket(bucket)) {
    return `/api/storage/${bucket}/${key}`;
  }
  const { sig, exp } = generateSignedImageParams(bucket, key, expiresInSeconds);
  return `/api/storage/${bucket}/${key}?sig=${sig}&exp=${exp}`;
}

/**
 * 从数据库存储键名构造站内图像读取 URL。
 *
 * 业务层从 storageKey/storageBucket 还原图片 URL 时统一走这里：
 * - generations 等非公开桶自动追加 sig/exp，供浏览器、外接 API 客户端、
 *   OAI/第三方上游等无 cookie 场景读取；
 * - avatars 等公开桶保持普通公开路径；
 * - 空 key 返回 null，调用方可继续回退到旧 imageUrl。
 */
export function buildSignedStorageImageUrl(
  storageKey: string | null | undefined,
  storageBucket?: string | null,
  expiresInSeconds = 3600
): string | null {
  const key = storageKey?.trim();
  if (!key) return null;
  const bucket =
    storageBucket?.trim() ||
    process.env.NEXT_PUBLIC_GENERATIONS_BUCKET_NAME?.trim() ||
    "generations";
  return generateSignedImageUrl(bucket, key, expiresInSeconds);
}

function isOwnStorageImageUrl(raw: string, publicBaseUrl?: string | null) {
  try {
    const base = publicBaseUrl?.trim() || "http://localhost";
    const parsed = new URL(raw, base);
    return (
      raw.startsWith("/api/storage/") ||
      (Boolean(publicBaseUrl?.trim()) &&
        parsed.origin === new URL(base).origin &&
        parsed.pathname.startsWith("/api/storage/"))
    );
  } catch {
    return false;
  }
}

/** 不可信图片引用未获得读取权限；由 API 层映射为请求错误，不能进入下载或重签。 */
export class StorageImageAccessError extends Error {
  readonly status = 403;

  constructor(
    message = "Storage image access requires permission or a valid signature."
  ) {
    super(message);
    this.name = "StorageImageAccessError";
  }
}

/**
 * 校验客户端/上游提交的站内图片引用；返回实际对象键与能否重签。
 * 本人可按不可变用户前缀读自己的对象；他人的有效签名仅是限时访问凭证，不能续期。
 * 私有桶白名单与存储读取路由一致。外部 URL 返回 null，交由公网下载层处理。
 */
export function assertStorageImageUrlAccess(
  imageUrl: string,
  publicBaseUrl?: string | null,
  userId?: string
) {
  const reference = parseStorageImageUrl(imageUrl, publicBaseUrl);
  if (!reference) {
    if (isOwnStorageImageUrl(imageUrl, publicBaseUrl)) {
      throw new StorageImageAccessError();
    }
    return null;
  }
  const generationsBucket =
    process.env.NEXT_PUBLIC_GENERATIONS_BUCKET_NAME?.trim() || "generations";
  if (
    !isPublicBucket(reference.bucket) &&
    reference.bucket !== generationsBucket
  ) {
    throw new StorageImageAccessError("Storage bucket access is not allowed.");
  }
  const key = reference.key.replace(/^w\d+\//, "");
  const canResign =
    isPublicBucket(reference.bucket) ||
    Boolean(userId && storageKeyBelongsToUser(key, userId));
  if (!canResign) {
    const parsed = new URL(imageUrl, publicBaseUrl || "http://localhost");
    const signature = parsed.searchParams.get("sig") || "";
    const expiresAt = Number(parsed.searchParams.get("exp"));
    if (
      !/^[a-f0-9]{64}$/i.test(signature) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 ||
      verifySignedImageUrl(reference.bucket, key, signature, expiresAt) !==
        "valid"
    ) {
      throw new StorageImageAccessError();
    }
  }
  return { ...reference, key, canResign };
}

/**
 * 将图片 URL 规范化为对外可访问 URL。
 *
 * - 可信服务端结果可重签；不可信输入必须提供 authorization，只有本人对象能续期，
 *   他人的有效签名原样保留有效期；
 * - 第三方 http(s) URL 保持原样；
 * - 其他相对 URL 在提供 publicBaseUrl 时转绝对 URL。
 */
export function buildPublicImageUrl(
  imageUrl: string | null | undefined,
  publicBaseUrl?: string | null,
  expiresInSeconds = 3600,
  authorization?: { userId?: string }
): string | undefined {
  const raw = imageUrl?.trim();
  if (!raw) return undefined;

  if (authorization) {
    const access = assertStorageImageUrlAccess(
      raw,
      publicBaseUrl,
      authorization.userId
    );
    if (access && !access.canResign) {
      return publicBaseUrl?.trim()
        ? new URL(raw, publicBaseUrl).toString()
        : raw;
    }
  }

  const storageReference = parseStorageImageUrl(raw, publicBaseUrl);
  if (storageReference) {
    const widthSegment = storageReference.key.match(/^w(\d+)\//)?.[1];
    const objectKey = storageReference.key.replace(/^w\d+\//, "");
    const originalUrl =
      buildSignedStorageImageUrl(
        objectKey,
        storageReference.bucket,
        expiresInSeconds
      ) || raw;
    // 宽度属于展示路径，不参与HMAC；否则路由剥离宽度后会验签失败。
    const signedUrl = widthSegment
      ? buildStorageThumbnailUrl(originalUrl, Number(widthSegment)) ||
        originalUrl
      : originalUrl;
    return publicBaseUrl?.trim()
      ? new URL(signedUrl, publicBaseUrl).toString()
      : signedUrl;
  }
  if (isOwnStorageImageUrl(raw, publicBaseUrl)) return undefined;

  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (!publicBaseUrl?.trim()) return raw;
  return new URL(raw, publicBaseUrl).toString();
}

/**
 * 验证签名 URL 的有效性。
 *
 * 使用 timingSafeEqual 进行常量时间比较，防止时序攻击。
 *
 * @param bucket - 存储桶名
 * @param key - 文件键名
 * @param signature - 请求中携带的签名（hex 字符串）
 * @param expiresAt - 签名到期时间（unix epoch 秒）
 * @returns 验证结果：valid 表示通过，expired 表示已过期，invalid 表示签名不匹配
 */
export function verifySignedImageUrl(
  bucket: string,
  key: string,
  signature: string,
  expiresAt: number
): "valid" | "expired" | "invalid" {
  // 先检查过期——过期检查不泄露签名信息，可提前返回。
  const now = Math.floor(Date.now() / 1000);
  if (now > expiresAt) {
    return "expired";
  }

  const secret = getSigningSecret();
  const message = buildSignatureMessage(bucket, key, expiresAt);
  const expected = computeHmac(message, secret);

  // 常量时间比较：两侧必须等长，否则 timingSafeEqual 会抛异常。
  // 将 hex 字符串转为 Buffer 进行安全比较。
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  // 长度不匹配意味着签名格式非法或被篡改。
  // 为避免长度比较本身泄露信息，使用固定长度哈希再比较。
  if (sigBuffer.length !== expectedBuffer.length) {
    return "invalid";
  }

  if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
    return "invalid";
  }

  return "valid";
}
