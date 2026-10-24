/**
 * 存储 URL 工具函数
 *
 * 处理存储键名和外部 URL 的转换
 */

// ============================================
// 头像 URL 工具
// ============================================

/**
 * 判断是否为外部 URL
 *
 * 外部 URL 包括:
 * - OAuth 提供的头像 (GitHub, Google 等)
 * - 其他完整 URL
 *
 * @param value - URL 或存储键名
 * @returns 是否为外部 URL
 */
export function isExternalUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * 获取头像显示 URL
 *
 * 根据传入的值返回正确的 URL:
 * - 如果是外部 URL (http/https 开头)，直接返回
 * - 如果是存储键名，转换为本地存储读取 URL
 * - 如果为空，返回 undefined
 *
 * @param image - 用户的 image 字段值 (可能是 URL 或存储键名)
 * @returns 头像显示 URL 或 undefined
 *
 * @example
 * ```ts
 * // 外部 URL (OAuth 头像)
 * getAvatarUrl("https://avatars.githubusercontent.com/u/12345")
 * // => "https://avatars.githubusercontent.com/u/12345"
 *
 * // 存储键名
 * getAvatarUrl("user-abc123-1234567890.jpg")
 * // => "/api/storage/avatars/user-abc123-1234567890.jpg"
 *
 * // 空值
 * getAvatarUrl(null) // => undefined
 * ```
 */
export function getAvatarUrl(image: string | null | undefined): string | undefined {
  if (!image) {
    return undefined;
  }

  // 如果是外部 URL，直接返回
  if (isExternalUrl(image)) {
    return image;
  }

  // 否则是存储键名，转换为本地存储读取 URL
  const avatarsBucket = process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME ?? "avatars";
  return `/api/storage/${avatarsBucket}/${image}`;
}

/**
 * 生成唯一的头像文件名
 *
 * 格式: {userId}-{timestamp}.{extension}
 *
 * @param userId - 用户 ID
 * @param file - 上传的文件
 * @returns 唯一的文件键名
 */
export function generateAvatarKey(userId: string, file: File): string {
  const timestamp = Date.now();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  return `${userId}-${timestamp}.${extension}`;
}

// ============================================
// 归属与存储桶校验工具
// ============================================

/**
 * 判断文件键名是否归属于指定用户
 *
 * 归属判定锚定在 userId 边界上，而非旧实现的 key.includes(userId) 子串匹配。
 * WHY：子串匹配过弱——当一个 userId 恰为另一 userId 的子串，或目标 userId
 * 出现在 key 的任意位置时，旧校验会被绕过，构成潜在越权（IDOR）。本仓的
 * 存储键命名为 `${userId}-${timestamp}.ext`（见 generateAvatarKey）或以
 * `${userId}/` 作前缀，因此只接受以 `${userId}/`、`${userId}-` 开头或与
 * `${userId}` 完全相等的键，杜绝子串混淆。
 *
 * @param key - 文件键名
 * @param userId - 当前用户 ID
 * @returns 键名是否归属该用户
 */
export function keyBelongsToUser(key: string, userId: string): boolean {
  if (!userId) {
    return false;
  }
  return (
    key === userId ||
    key.startsWith(`${userId}/`) ||
    key.startsWith(`${userId}-`)
  );
}

/**
 * 判断 generations 桶的存储键是否归属指定用户（不查库）。
 *
 * 该桶所有写入方都把用户 ID 编进键里，共两种布局：
 * - `${userId}/...`：生成图、可编辑文件、PSD、输入图转存、请求上传
 *   （operations.ts、editable-file-operations.ts、psd-export/orchestrator.ts、
 *   rehost-input-images.ts、request-utils.ts）；
 * - `support/${userId}/...`：工单附件（api/support/attachments）。
 *
 * WHY 不按 generation.storage_key 查库：该列无索引，每次回退鉴权都要全表扫描最大的表，
 * 且只覆盖主图，派生对象（草稿、输入图、可编辑文件、工单附件）签名过期后一律 403。
 * 键前缀是写入时就确定的归属事实，判定同样严格且无需查询。
 *
 * @param key - 存储键（已剥离缩略图宽度段）
 * @param userId - 当前会话用户 ID
 * @returns 该键是否由此用户写入
 * @remarks 仅用于"本人读自己的对象"；工单附件的管理员/工单归属等更宽的授权仍由
 *   工单附件接口自行校验并下发签名 URL，不走本判定。
 */
export function storageKeyBelongsToUser(
  key: string,
  userId: string
): boolean {
  if (!userId || !key) {
    return false;
  }
  if (keyBelongsToUser(key, userId)) {
    return true;
  }
  return key.startsWith(`support/${userId}/`);
}

/**
 * 判断存储桶是否在白名单内
 *
 * 安全措施：只允许访问预定义的存储桶，避免跨桶越权。
 *
 * @param bucket - 待校验的存储桶名称
 * @param allowedBuckets - 允许的存储桶列表
 * @returns 是否允许访问该存储桶
 */
export function isBucketAllowed(
  bucket: string,
  allowedBuckets: readonly string[]
): boolean {
  return allowedBuckets.includes(bucket);
}
