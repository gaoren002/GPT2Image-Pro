import { getRuntimeSettingString } from "../../system-settings";
import { buildSignedStorageImageUrl } from "../signed-url";
import { invalidateThumbnailCache } from "../thumbnail-cache";
import type { StorageProvider } from "../types";
import {
  assertObjectReadBudget,
  type ObjectReadOptions,
  readObjectBody,
} from "./object-budget";

/**
 * 路径模块的最小接口
 *
 * 仅声明 resolveSafePath 所需的方法，便于在 DB-free 单测中直接注入
 * node:path，避免依赖运行时设置（getBaseDir → getRuntimeSettingString → DB）。
 */
type PathLike = Pick<typeof import("node:path"), "join" | "resolve" | "sep">;

/**
 * 解析并校验本地存储的最终文件路径（纯函数）
 *
 * baseDir 由调用方注入，因此不触达运行时设置，可独立单测。这是 local 存储
 * deleteObject/getObject/putObject 的唯一目录穿越防线：
 * - 先做 substring 快检拒绝明显的 ".." 穿越；
 * - 再用 path.resolve + startsWith(base + sep) 做权威校验。
 * WHY 必须带 path.sep：否则 base="/data/gen" 会错误接受 "/data/gen-evil/x"
 * 这类前缀混淆路径。
 *
 * @param path - 注入的 path 模块（运行时为 node:path）
 * @param baseDir - 存储根目录
 * @param bucket - 存储桶名称
 * @param key - 文件键名
 * @returns join(baseDir, bucket, key) 得到的安全路径
 * @throws 当 bucket/key 含目录穿越或解析后逃逸出 base 时
 */
export function resolveSafePath(
  path: PathLike,
  baseDir: string,
  bucket: string,
  key: string
): string {
  // Defense-in-depth: fast substring check rejects obvious traversal attempts early,
  // while the path.resolve + startsWith check below is the authoritative guard.
  if (key.includes("..") || bucket.includes("..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
  const filePath = path.join(baseDir, bucket, key);

  // 防止路径遍历攻击：确保解析后的路径在允许的目录范围内
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir, bucket);
  if (
    !resolvedPath.startsWith(resolvedBase + path.sep) &&
    resolvedPath !== resolvedBase
  ) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  return filePath;
}

async function getBaseDir() {
  const configured =
    (await getRuntimeSettingString("LOCAL_STORAGE_PATH")) || "./storage";
  if (configured === "~" || configured.startsWith("~/")) {
    const os = await import("node:os");
    const path = await getPath();
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

async function getFs() {
  return await import("node:fs/promises");
}

async function getPath() {
  return (await import("node:path")).default;
}

async function safePath(bucket: string, key: string): Promise<string> {
  const path = await getPath();
  const baseDir = await getBaseDir();
  return resolveSafePath(path, baseDir, bucket, key);
}

/**
 * 本地存储提供者
 *
 * 注意（语义差异，调用方须知）：本地后端的 getSignedUrl 返回带 sig/exp 的
 * 站内读取路由 `/api/storage/{bucket}/{key}`，用于提供给外部服务下载。
 * getSignedUploadUrl 仍返回普通 GET 路由，并非可直接 PUT 的上传 URL；S3
 * 后端返回真正的预签名 PUT/GET。因此依赖预签名直传的调用方在 local 后端下
 * 需要走专门的本地上传端点。
 */
export const localProvider: StorageProvider = {
  async getSignedUrl(
    key: string,
    bucket: string,
    expiresIn: number
  ): Promise<string> {
    return buildSignedStorageImageUrl(key, bucket, expiresIn) ?? "";
  },

  async getSignedUploadUrl(
    key: string,
    bucket: string,
    _contentType: string
  ): Promise<string> {
    return `/api/storage/${bucket}/${key}`;
  },

  async deleteObject(key: string, bucket: string): Promise<void> {
    const filePath = await safePath(bucket, key);
    const fs = await getFs();
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // 缺失也应清除派生缓存；权限或 I/O 故障不能伪装原图已删除。
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    await invalidateThumbnailCache(bucket, key);
  },

  async getObject(
    key: string,
    bucket: string,
    options?: ObjectReadOptions
  ): Promise<Buffer> {
    assertObjectReadBudget(options);
    const filePath = await safePath(bucket, key);
    const fs = await getFs();
    if (options?.maxBytes !== undefined) {
      const handle = await fs.open(filePath, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > options.maxBytes)
          throw new Error("Object exceeds the byte limit.");
        const { Readable } = await import("node:stream");
        const stream = handle.createReadStream({
          autoClose: false,
          signal: options.signal,
        });
        // Web流的队列策略按字节计数，不能让默认的chunk计数放大磁盘预读内存。
        const body = Readable.toWeb(stream, {
          strategy: {
            highWaterMark: 64 * 1024,
            size: (chunk: Uint8Array) => chunk.byteLength,
          },
        }) as ReadableStream<Uint8Array>;
        return await readObjectBody(body, options, size);
      } finally {
        await handle.close();
      }
    }
    // 透传 signal：调用方取消时中止读取（fs/promises.readFile 支持 { signal }）。
    return fs.readFile(
      filePath,
      options?.signal ? { signal: options.signal } : {}
    ) as Promise<Buffer>;
  },

  async putObject(
    key: string,
    bucket: string,
    data: Buffer,
    _contentType: string
  ): Promise<void> {
    const filePath = await safePath(bucket, key);
    const fs = await getFs();
    const path = await getPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, data);
  },
};
