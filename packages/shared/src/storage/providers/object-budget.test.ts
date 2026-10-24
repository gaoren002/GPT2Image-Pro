/** 实际本地文件和可控S3流验证对象读取预算；不连接数据库或外部存储。 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ base: "", send: vi.fn() }));
vi.mock("../../system-settings", () => ({
  getRuntimeSettingString: async (key: string) =>
    key === "LOCAL_STORAGE_PATH"
      ? mocks.base
      : key === "STORAGE_ENDPOINT"
        ? "https://objects.example.test"
        : "test-placeholder",
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = mocks.send;
  },
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));
import { localProvider } from "./local";
import { s3Provider } from "./s3";

const folders: string[] = [];
afterEach(async () => {
  mocks.send.mockReset();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true }))
  );
});

it("本地文件超限时不完整读取对象", async () => {
  mocks.base = await mkdtemp(join(tmpdir(), "storage-budget-"));
  folders.push(mocks.base);
  await mkdir(join(mocks.base, "generations"));
  await writeFile(
    join(mocks.base, "generations", "image.png"),
    Buffer.alloc(1024)
  );
  const options = { maxBytes: 10 };
  await expect(
    localProvider.getObject("image.png", "generations", options)
  ).rejects.toThrow(/byte limit|too large/i);
  expect(
    await localProvider.getObject("image.png", "generations", {
      maxBytes: 1024,
    })
  ).toHaveLength(1024);
});

it("S3逐块超限会取消未读正文", async () => {
  let cancelled = false;
  mocks.send.mockResolvedValue({
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelled = true;
          },
        }),
    },
  });
  await expect(
    s3Provider.getObject("image.png", "generations", { maxBytes: 10 })
  ).rejects.toThrow(/byte limit|too large/i);
  expect(cancelled).toBe(true);
});

it("S3头部已知超限也应取消，不读取正文", async () => {
  let cancelled = false;
  mocks.send.mockResolvedValue({
    ContentLength: 1000,
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
    },
  });
  await expect(
    s3Provider.getObject("image.png", "generations", { maxBytes: 10 })
  ).rejects.toThrow(/byte limit|too large/i);
  expect(cancelled).toBe(true);
});
