/**
 * 读取路由与 local/S3 删除共用的服务端缩略图缓存，不依赖数据库。
 * v2 不复用无 TTL 的旧文件；每分片 512KiB/64 项，256 分片共最多 128MiB 内容。
 * 为首尔 256MiB tmpfs 的文件块、目录、epoch 与临时文件保留余量。
 * 固定 24 小时 TTL 不因访问续期，其他节点的独立磁盘在到期后停止提供旧图。
 * cleanupThumbnailCache 须由每个缓存磁盘所在实例周期调用，同时分批清除旧布局。
 */
import { createHash, randomUUID } from "node:crypto";
import type { Dir } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { logWarn } from "../logger";

const WIDTHS = [128, 256, 320, 480, 512, 640, 1024, 1280] as const;
const SHARDS = 256;
const MAX_FILES_PER_SHARD = 64;
const LOCK_TTL_MS = 10 * 60_000;
const CACHE_FILE =
  /^(?:[a-f0-9]{64}@w\d+\.webp(?:\.[a-f0-9-]+\.tmp)?|\.epoch\.[a-f0-9-]+\.tmp)$/;

/** 把旧合法范围内的整数向上归一，保留实际前端宽度；非法值不请求缩略图。 */
export function normalizeThumbnailWidth(raw: string | null): number | null {
  if (!raw) return null;
  const width = Number(raw);
  if (!Number.isInteger(width) || width < 16 || width > 1280) return null;
  return WIDTHS.find((candidate) => candidate >= width) ?? null;
}

type CacheOptions = {
  directory: string;
  shardMaxBytes?: number;
  ttlMs?: number;
  now?: () => number;
};
type CleanupOptions = { maxShards?: number; maxLegacyEntries?: number };
type CacheFile = {
  name: string;
  size: number;
  accessedAt: number;
  createdAt: number;
};

/** 读取 fs 错误码；日志只输出代码，不回显磁盘路径或对象键。 */
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/** 可选缓存 I/O 失败只影响命中率，告警后仍允许原图读取或返回已算好的字节。 */
function warnCache(error: unknown): void {
  logWarn("缩略图缓存操作失败", { code: errorCode(error) ?? "UNKNOWN" });
}

/** 配额、TTL 和维护预算都必须有限，避免运维误配置恢复无界行为。 */
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error("Invalid thumbnail cache limit");
  return value;
}

/** 实例只保存扫描游标，不缓存图像字节，避免不同 worker 删除后仍命中内存旧图。 */
export class ThumbnailCache {
  private readonly directory: string;
  private readonly shardMaxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private nextShard = 0;
  private legacyFiles: AsyncGenerator<string> | undefined;
  private cleanupRunning = false;

  /** directory 为该实例的本机缓存根目录；可注入时钟与小配额做真实文件系统测试。 */
  constructor(options: CacheOptions) {
    this.directory = options.directory;
    this.shardMaxBytes = boundedInteger(
      options.shardMaxBytes ?? 512 * 1024,
      1,
      64 * 1024 * 1024
    );
    this.ttlMs = boundedInteger(
      options.ttlMs ?? 24 * 60 * 60_000,
      1,
      7 * 24 * 60 * 60_000
    );
    this.now = options.now ?? Date.now;
  }

  /** 哈希隔离对象与路径，存储键永远不能控制缓存目录层级。 */
  private location(bucket: string, key: string, width: number) {
    const hash = createHash("sha256").update(`${bucket}/${key}`).digest("hex");
    const shard = hash.slice(0, 2);
    return {
      hash,
      shard,
      directory: path.join(this.directory, "v2", shard),
      name: `${hash}@w${width}.webp`,
    };
  }

  /** 原子替换的分片 epoch 让其他进程也能识别删除前启动的缩放。 */
  private async epoch(directory: string): Promise<string> {
    try {
      return await readFile(path.join(directory, ".epoch"), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "";
      throw error;
    }
  }

  /**
   * 短文件锁覆盖配额检查/提交/失效，兼容同一磁盘上的多个 worker。
   * 写缓存遇忙即放弃；删除最多等约 1 秒。崩溃锁 10 分钟后可回收。
   * 不在锁内拉原图或缩放；跨节点独立磁盘不共享此锁。
   */
  private async locked<T>(
    directory: string,
    run: () => Promise<T>,
    wait = false
  ): Promise<T | undefined> {
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, ".lock");
    for (let attempt = 0; attempt < (wait ? 101 : 1); attempt++) {
      let handle: FileHandle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (wait && attempt < 100) {
          await delay(10);
          continue;
        }
        if (wait) throw new Error("Thumbnail cache shard busy");
        return undefined;
      }
      try {
        return await run();
      } finally {
        await handle.close();
        await this.remove(lockPath);
      }
    }
    return undefined;
  }

  /** 幂等删除缺失文件；权限/磁盘错误仍向上传播给维护作业或降级告警。 */
  private async remove(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  /** 流式枚举已知缓存文件，不递归未知目录、不跟随目录符号链接。 */
  private async *files(directory: string): AsyncGenerator<string> {
    let dir: Dir;
    try {
      dir = await opendir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for await (const entry of dir)
      if (entry.isFile() && CACHE_FILE.test(entry.name)) yield entry.name;
  }

  /**
   * 在短锁内淘汰到本分片字节/条数预算，TTL 看 mtime，LRU 看主动维护的 atime。
   * 新布局从首次写入即受限，正常分片最多 64 项；不会扫全缓存目录。
   */
  private async prune(
    directory: string,
    reserveBytes = 0,
    reserveFiles = 0
  ): Promise<number> {
    const files: CacheFile[] = [];
    let deleted = 0;
    let bytes = 0;
    for await (const name of this.files(directory)) {
      const file = path.join(directory, name);
      const info = await stat(file);
      if (name.endsWith(".tmp") || info.mtimeMs + this.ttlMs <= this.now()) {
        await this.remove(file);
        deleted++;
        continue;
      }
      files.push({
        name,
        size: info.size,
        accessedAt: info.atimeMs,
        createdAt: info.mtimeMs,
      });
      bytes += info.size;
    }
    files.sort(
      (a, b) =>
        a.accessedAt - b.accessedAt ||
        a.createdAt - b.createdAt ||
        a.name.localeCompare(b.name)
    );
    let remaining = files.length;
    for (const file of files) {
      if (
        bytes + reserveBytes <= this.shardMaxBytes &&
        remaining + reserveFiles <= MAX_FILES_PER_SHARD
      )
        break;
      await this.remove(path.join(directory, file.name));
      bytes -= file.size;
      remaining--;
      deleted++;
    }
    return deleted;
  }

  /** 命中仍校验固定 TTL；不读旧布局。读取失败视为未命中，不能阻断原图服务。 */
  async read(
    bucket: string,
    key: string,
    width: number
  ): Promise<Buffer | undefined> {
    const location = this.location(bucket, key, width);
    const file = path.join(location.directory, location.name);
    try {
      // 先开句柄再 stat/read，删除或替换路径不可能把另一个版本的时间戳用到当前内容。
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (
          info.mtimeMs + this.ttlMs <= this.now() ||
          info.size > this.shardMaxBytes
        )
          return undefined;
        const data = await handle.readFile();
        await handle.utimes(new Date(this.now()), info.mtime);
        return data;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") warnCache(error);
      return undefined;
    }
  }

  /**
   * 未命中才调用 create，异常原样返回给路由；可选缓存故障不掩盖原图/缩放错误。
   * epoch 在计算前读取并在提交锁内复核，删除先于提交时禁止旧结果重新落盘。
   */
  async getOrCreate(
    bucket: string,
    key: string,
    width: number,
    create: () => Promise<Buffer>
  ): Promise<Buffer> {
    if (!WIDTHS.includes(width as (typeof WIDTHS)[number]))
      throw new Error("Noncanonical thumbnail width");
    const cached = await this.read(bucket, key, width);
    if (cached) return cached;
    const location = this.location(bucket, key, width);
    let epoch: string | undefined;
    try {
      epoch = await this.epoch(location.directory);
    } catch (error) {
      warnCache(error);
    }
    const data = await create();
    if (
      epoch === undefined ||
      data.length === 0 ||
      data.length > this.shardMaxBytes
    )
      return data;
    try {
      await this.locked(location.directory, async () => {
        if ((await this.epoch(location.directory)) !== epoch) return;
        // 同宽度并发只保留一份，写入唯一 tmp 后原子 rename，不会产生半图。
        const target = path.join(location.directory, location.name);
        await this.remove(target);
        await this.prune(location.directory, data.length, 1);
        const tmp = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, data);
          await utimes(tmp, new Date(this.now()), new Date(this.now()));
          await rename(tmp, target);
        } finally {
          await this.remove(tmp);
        }
      });
    } catch (error) {
      warnCache(error);
    }
    return data;
  }

  /**
   * 删除该对象在本机共享目录下的新旧派生文件；不承诺其他节点独立磁盘即时删除。
   * 轮换 epoch 会同时使本分片内删除前启动的缩放放弃写缓存，避免保留无界墓碑。
   */
  async invalidate(bucket: string, key: string): Promise<void> {
    const location = this.location(bucket, key, 128);
    await this.locked(
      location.directory,
      async () => {
        const tmp = path.join(location.directory, `.epoch.${randomUUID()}.tmp`);
        try {
          await writeFile(tmp, randomUUID());
          await rename(tmp, path.join(location.directory, ".epoch"));
        } finally {
          await this.remove(tmp);
        }
        for (const directory of [
          location.directory,
          path.join(this.directory, location.shard),
        ]) {
          for await (const name of this.files(directory))
            if (name.startsWith(`${location.hash}@w`))
              await this.remove(path.join(directory, name));
        }
      },
      true
    );
  }

  /** 只遍历旧版 256 个已知分片，生成器保留位置使多次限额调用最终推进到末尾。 */
  private async *legacy(): AsyncGenerator<string> {
    for (let shard = 0; shard < SHARDS; shard++) {
      const directory = path.join(
        this.directory,
        shard.toString(16).padStart(2, "0")
      );
      for await (const name of this.files(directory))
        yield path.join(directory, name);
    }
  }

  /**
   * 单次最多清理指定分片数和旧布局项数，返回删除数供父调度记录。
   * 每次轮换分片，不因低预算永远只扫前几个目录；同实例重入直接返回零。
   */
  async cleanup(
    options: CleanupOptions = {}
  ): Promise<{ deleted: number; legacyDeleted: number }> {
    const maxShards = boundedInteger(options.maxShards ?? 8, 1, 256);
    const maxLegacyEntries = boundedInteger(
      options.maxLegacyEntries ?? 500,
      1,
      5000
    );
    const result = { deleted: 0, legacyDeleted: 0 };
    if (this.cleanupRunning) return result;
    this.cleanupRunning = true;
    try {
      for (let count = 0; count < maxShards; count++) {
        const directory = path.join(
          this.directory,
          "v2",
          this.nextShard.toString(16).padStart(2, "0")
        );
        this.nextShard = (this.nextShard + 1) % SHARDS;
        try {
          const lock = path.join(directory, ".lock");
          if ((await stat(lock)).mtimeMs + LOCK_TTL_MS < this.now())
            await this.remove(lock);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        result.deleted +=
          (await this.locked(directory, () => this.prune(directory))) ?? 0;
      }
      this.legacyFiles ??= this.legacy();
      for (let count = 0; count < maxLegacyEntries; count++) {
        const next = await this.legacyFiles.next();
        if (next.done) {
          this.legacyFiles = undefined;
          break;
        }
        await this.remove(next.value);
        result.legacyDeleted++;
      }
      return result;
    } finally {
      this.cleanupRunning = false;
    }
  }
}

let defaultCache: ThumbnailCache | undefined;

/** 延迟读取缓存根目录；不在模块 import 时创建目录或启动后台定时器。 */
export function getThumbnailCache(): ThumbnailCache {
  defaultCache ??= new ThumbnailCache({
    directory:
      process.env.THUMB_CACHE_DIR ||
      (process.env.NODE_ENV === "test"
        ? path.join(tmpdir(), "gpt2image-thumb-cache")
        : "/home/user1/gpt2image-thumb-cache"),
  });
  return defaultCache;
}

/** provider 原图删除成功（含本来已缺失）后清理本机派生物，失败告警由 TTL 保底。 */
export async function invalidateThumbnailCache(
  bucket: string,
  key: string
): Promise<void> {
  try {
    await getThumbnailCache().invalidate(bucket, key);
  } catch (error) {
    warnCache(error);
  }
}

/** 父调度须在每个缓存节点周期调用；独立磁盘不受其他节点的清理调用影响。 */
export async function cleanupThumbnailCache(options?: CleanupOptions) {
  return getThumbnailCache().cleanup(options);
}
