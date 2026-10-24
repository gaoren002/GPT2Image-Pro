/** local/S3 原图删除与真实本机派生缓存的接线回归，不触碰数据库或外部服务。 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", send: vi.fn() }));
vi.mock("../../system-settings", () => ({
  getRuntimeSettingString: async (key: string) =>
    key === "LOCAL_STORAGE_PATH" ? state.root : "test-config",
}));
vi.mock("@aws-sdk/client-s3", () => {
  /** 保留命令输入用于核验删除真实对象，不发网络。 */
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: class {
      send = state.send;
    },
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    PutObjectCommand: Command,
  };
});

let directory: string;
const originalCacheDirectory = process.env.THUMB_CACHE_DIR;
beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(path.join(os.tmpdir(), "provider-thumb-delete-"));
  state.root = path.join(directory, "originals");
  process.env.THUMB_CACHE_DIR = path.join(directory, "thumbs");
  state.send.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (originalCacheDirectory === undefined) delete process.env.THUMB_CACHE_DIR;
  else process.env.THUMB_CACHE_DIR = originalCacheDirectory;
});

/** 创建两种宽度，并返回实际 cache/provider；测试删除后不会命中旧缩略图。 */
async function prepare(kind: "local" | "s3") {
  const { getThumbnailCache } = await import("../thumbnail-cache");
  const cache = getThumbnailCache();
  const provider =
    kind === "local"
      ? (await import("./local")).localProvider
      : (await import("./s3")).s3Provider;
  for (const width of [128, 512])
    await cache.getOrCreate("generations", "u/x.png", width, async () =>
      Buffer.from("thumb")
    );
  return { cache, provider };
}

describe("provider thumbnail invalidation", () => {
  it.each([
    "local",
    "s3",
  ] as const)("%s 删除成功后清除所有本机派生宽度", async (kind) => {
    const { cache, provider } = await prepare(kind);
    const original = path.join(state.root, "generations/u/x.png");
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, "original");
    await provider.deleteObject("u/x.png", "generations");
    for (const width of [128, 512])
      expect(await cache.read("generations", "u/x.png", width)).toBeUndefined();
    if (kind === "local")
      await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
    else
      expect(state.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { Bucket: "generations", Key: "u/x.png" },
        })
      );
  });

  it("本地原图已缺失时仍清理派生物，重复删除幂等", async () => {
    const { cache, provider } = await prepare("local");
    await provider.deleteObject("u/x.png", "generations");
    await provider.deleteObject("u/x.png", "generations");
    expect(await cache.read("generations", "u/x.png", 128)).toBeUndefined();
  });

  it("S3 删除失败不能先清缓存并伪装成功", async () => {
    const { cache, provider } = await prepare("s3");
    state.send.mockRejectedValue(new Error("S3 unavailable"));
    await expect(
      provider.deleteObject("u/x.png", "generations")
    ).rejects.toThrow("S3 unavailable");
    expect(await cache.read("generations", "u/x.png", 128)).toEqual(
      Buffer.from("thumb")
    );
  });

  it("本地非 ENOENT 失败向上传播，不能伪装删除成功", async () => {
    const { cache, provider } = await prepare("local");
    await mkdir(path.join(state.root, "generations/u/x.png"), {
      recursive: true,
    });
    await expect(
      provider.deleteObject("u/x.png", "generations")
    ).rejects.toThrow();
    expect(await cache.read("generations", "u/x.png", 128)).toEqual(
      Buffer.from("thumb")
    );
  });
});
