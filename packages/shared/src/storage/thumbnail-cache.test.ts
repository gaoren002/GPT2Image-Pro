/** 缩略图缓存的真实文件系统回归：固定宽度、配额、过期、旧布局及删除竞态。 */
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeThumbnailWidth, ThumbnailCache } from "./thumbnail-cache";

let directory: string;
let now: number;
let cache: ThumbnailCache;

/** 只使用临时目录，避免触碰配置中的真实缓存。 */
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "thumb-retention-"));
  now = Date.now();
  cache = new ThumbnailCache({
    directory,
    shardMaxBytes: 12,
    ttlMs: 1000,
    now: () => now,
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 构造命中同一分片的对象，实际验证局部配额而非模拟文件列表。 */
function collidingKeys(count: number): string[] {
  const keys: string[] = [];
  for (let index = 0; keys.length < count; index++) {
    const key = `u/${index}.png`;
    if (
      createHash("sha256")
        .update(`generations/${key}`)
        .digest("hex")
        .startsWith("aa")
    )
      keys.push(key);
  }
  return keys;
}

describe("thumbnail retention", () => {
  it("默认配额为256MiB tmpfs保留余量，不缓存超过512KiB的单项", async () => {
    const defaults = new ThumbnailCache({ directory });
    const data = Buffer.alloc(1024 * 1024);
    expect(
      await defaults.getOrCreate(
        "generations",
        "u/large.png",
        1280,
        async () => data
      )
    ).toEqual(data);
    expect(
      Boolean(await defaults.read("generations", "u/large.png", 1280))
    ).toBe(false);
  });
  it("把整个旧合法宽度范围收敛到固定规范，保留前端宽度", () => {
    for (const width of [128, 256, 320, 480, 512, 640, 1024, 1280])
      expect(normalizeThumbnailWidth(String(width))).toBe(width);
    const normalized = new Set(
      Array.from({ length: 1265 }, (_, i) =>
        normalizeThumbnailWidth(String(i + 16))
      )
    );
    expect([...normalized]).toEqual([128, 256, 320, 480, 512, 640, 1024, 1280]);
    expect(normalizeThumbnailWidth("321")).toBe(480);
    for (const raw of [null, "", "0", "15", "1281", "12.5", "NaN"])
      expect(normalizeThumbnailWidth(raw)).toBeNull();
  });

  it("缓存命中不重算；不同桶隔离", async () => {
    let loads = 0;
    const create = async () => {
      loads++;
      return Buffer.from("test");
    };
    await cache.getOrCreate("generations", "u/x.png", 128, create);
    await cache.getOrCreate("generations", "u/x.png", 128, create);
    await cache.getOrCreate("avatars", "u/x.png", 128, create);
    expect(loads).toBe(2);
  });

  it("每个分片按字节淘汰最久未访问项，超大项不落盘", async () => {
    const [a, b, c] = collidingKeys(3) as [string, string, string];
    await cache.getOrCreate("generations", a, 128, async () =>
      Buffer.from("aaaaaa")
    );
    now += 10;
    await cache.getOrCreate("generations", b, 128, async () =>
      Buffer.from("bbbbbb")
    );
    now += 10;
    await cache.read("generations", a, 128);
    now += 10;
    await cache.getOrCreate("generations", c, 128, async () =>
      Buffer.from("cccccc")
    );
    expect(await cache.read("generations", a, 128)).toEqual(
      Buffer.from("aaaaaa")
    );
    expect(await cache.read("generations", b, 128)).toBeUndefined();
    expect(await cache.read("generations", c, 128)).toEqual(
      Buffer.from("cccccc")
    );
    await cache.getOrCreate("generations", a, 320, async () =>
      Buffer.alloc(13)
    );
    expect(await cache.read("generations", a, 320)).toBeUndefined();
  });

  it("TTL 按生成时间固定到期，热读不延寿；新进程也不能读过期项", async () => {
    await cache.getOrCreate("generations", "u/x.png", 128, async () =>
      Buffer.from("old")
    );
    now += 900;
    expect(await cache.read("generations", "u/x.png", 128)).toBeDefined();
    now += 101;
    const second = new ThumbnailCache({
      directory,
      shardMaxBytes: 12,
      ttlMs: 1000,
      now: () => now,
    });
    expect(await second.read("generations", "u/x.png", 128)).toBeUndefined();
  });

  it("删除覆盖所有规范宽度及旧任意宽度，不影响其他对象", async () => {
    for (const width of [128, 320, 640])
      await cache.getOrCreate("generations", "u/x.png", width, async () =>
        Buffer.from("x")
      );
    await cache.getOrCreate("generations", "u/keep.png", 128, async () =>
      Buffer.from("keep")
    );
    const hash = createHash("sha256")
      .update("generations/u/x.png")
      .digest("hex");
    const legacyDir = path.join(directory, hash.slice(0, 2));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, `${hash}@w319.webp`), "old");
    await cache.invalidate("generations", "u/x.png");
    for (const width of [128, 320, 640])
      expect(await cache.read("generations", "u/x.png", width)).toBeUndefined();
    expect(await readdir(legacyDir)).toEqual([]);
    expect(await cache.read("generations", "u/keep.png", 128)).toEqual(
      Buffer.from("keep")
    );
  });

  it("另一实例删除后，已在计算的旧缩略图不能重新落盘", async () => {
    let finish: (value: Buffer) => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = cache.getOrCreate("generations", "u/x.png", 128, () => {
      started();
      return new Promise<Buffer>((resolve) => {
        finish = resolve;
      });
    });
    await ready;
    const second = new ThumbnailCache({ directory, shardMaxBytes: 12 });
    await second.invalidate("generations", "u/x.png");
    finish(Buffer.from("late"));
    expect(await pending).toEqual(Buffer.from("late"));
    expect(await cache.read("generations", "u/x.png", 128)).toBeUndefined();
  });

  it("旧目录不读回，周期清理有预算且多次可推进到全部旧文件", async () => {
    const hash = `aa${"1".repeat(62)}`;
    const legacyDir = path.join(directory, "aa");
    await mkdir(legacyDir, { recursive: true });
    for (const width of [16, 17, 18])
      await writeFile(path.join(legacyDir, `${hash}@w${width}.webp`), "legacy");
    await writeFile(path.join(directory, "keep.txt"), "keep");
    expect(await cache.read("generations", "u/x.png", 128)).toBeUndefined();
    const first = await cache.cleanup({ maxShards: 1, maxLegacyEntries: 1 });
    expect(first.legacyDeleted).toBe(1);
    expect((await readdir(legacyDir)).length).toBe(2);
    for (let i = 0; i < 4; i++)
      await cache.cleanup({ maxShards: 1, maxLegacyEntries: 1 });
    expect(await readdir(legacyDir)).toEqual([]);
    expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
      "keep"
    );
  });

  it("周期清理删除无人再访问的过期新布局项", async () => {
    const [key] = collidingKeys(1) as [string];
    await cache.getOrCreate("generations", key, 128, async () =>
      Buffer.from("x")
    );
    now += 1001;
    const result = await cache.cleanup({ maxShards: 256, maxLegacyEntries: 1 });
    expect(result.deleted).toBe(1);
  });

  it("周期清理回收崩溃 tmp 与遗留锁，保留 epoch 和未知文件", async () => {
    const shard = path.join(directory, "v2/00");
    await mkdir(shard, { recursive: true });
    await writeFile(path.join(shard, ".epoch.aaaaaaaa-aaaa.tmp"), "unfinished");
    await writeFile(path.join(shard, ".epoch"), "keep-epoch");
    await writeFile(path.join(shard, "keep.txt"), "keep");
    const lock = path.join(shard, ".lock");
    await writeFile(lock, "");
    const old = new Date(now - 11 * 60_000);
    await utimes(lock, old, old);
    expect(
      (await cache.cleanup({ maxShards: 1, maxLegacyEntries: 1 })).deleted
    ).toBe(1);
    expect((await readdir(shard)).sort()).toEqual([".epoch", "keep.txt"]);
  });

  it("同盘并行实例不突破分片配额，写锁忙时直接返回本次计算结果", async () => {
    const keys = collidingKeys(6);
    const other = new ThumbnailCache({ directory, shardMaxBytes: 12 });
    const values = await Promise.all(
      keys.map((key, index) =>
        (index % 2 ? other : cache).getOrCreate(
          "generations",
          key,
          128,
          async () => Buffer.alloc(6, index)
        )
      )
    );
    expect(values).toHaveLength(6);
    const shard = path.join(directory, "v2/aa");
    const files = (await readdir(shard)).filter((name) =>
      name.endsWith(".webp")
    );
    const sizes = await Promise.all(
      files.map(async (name) => (await readFile(path.join(shard, name))).length)
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(
      12
    );
  });
});
