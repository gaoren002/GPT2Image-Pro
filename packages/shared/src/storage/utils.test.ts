/**
 * 存储 URL 与归属工具的 DB-free 单测
 *
 * 覆盖 isExternalUrl / getAvatarUrl / generateAvatarKey（C-L16）以及
 * keyBelongsToUser / storageKeyBelongsToUser / isBucketAllowed
 * （归属与白名单的纯逻辑；存储读取路由的会话回退鉴权依赖前者）。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  generateAvatarKey,
  getAvatarUrl,
  isBucketAllowed,
  isExternalUrl,
  keyBelongsToUser,
  storageKeyBelongsToUser,
} from "./utils";

describe("isExternalUrl", () => {
  it("识别 http/https 链接为外部 URL", () => {
    expect(isExternalUrl("http://example.com/a.png")).toBe(true);
    expect(isExternalUrl("https://example.com/a.png")).toBe(true);
  });

  it("非 http(s) scheme 与存储键名不算外部 URL", () => {
    expect(isExternalUrl("ftp://example.com/a.png")).toBe(false);
    expect(isExternalUrl("user-1-123.png")).toBe(false);
    expect(isExternalUrl("/api/storage/avatars/x.png")).toBe(false);
  });

  it("空值返回 false", () => {
    expect(isExternalUrl(null)).toBe(false);
    expect(isExternalUrl(undefined)).toBe(false);
    expect(isExternalUrl("")).toBe(false);
  });
});

describe("getAvatarUrl", () => {
  const previousBucket = process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;

  afterEach(() => {
    if (previousBucket === undefined) {
      delete process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;
    } else {
      process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME = previousBucket;
    }
  });

  it("空值返回 undefined", () => {
    expect(getAvatarUrl(null)).toBeUndefined();
    expect(getAvatarUrl(undefined)).toBeUndefined();
    expect(getAvatarUrl("")).toBeUndefined();
  });

  it("外部 URL 原样返回", () => {
    const url = "https://avatars.githubusercontent.com/u/12345";
    expect(getAvatarUrl(url)).toBe(url);
  });

  it("存储键名拼为 /api/storage/<bucket>/<key>（默认 avatars 桶）", () => {
    delete process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;
    expect(getAvatarUrl("user-1-123.png")).toBe(
      "/api/storage/avatars/user-1-123.png"
    );
  });

  it("存储键名使用配置的桶名", () => {
    process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME = "my-avatars";
    expect(getAvatarUrl("user-1-123.png")).toBe(
      "/api/storage/my-avatars/user-1-123.png"
    );
  });
});

describe("generateAvatarKey", () => {
  const makeFile = (name: string): File =>
    ({ name }) as unknown as File;

  it("以 userId 前缀开头并归一扩展名为小写", () => {
    const key = generateAvatarKey("user-1", makeFile("Photo.PNG"));
    expect(key.startsWith("user-1-")).toBe(true);
    expect(key.endsWith(".png")).toBe(true);
  });

  it("文件名无点号时把整名当作扩展名（split('.').pop() 行为）", () => {
    const key = generateAvatarKey("user-1", makeFile("photo"));
    expect(key.startsWith("user-1-")).toBe(true);
    expect(key.endsWith(".photo")).toBe(true);
  });

  it("多级扩展名只取最后一段并小写", () => {
    const key = generateAvatarKey("user-1", makeFile("archive.TAR.GZ"));
    expect(key.endsWith(".gz")).toBe(true);
  });
});

describe("keyBelongsToUser", () => {
  it("以 ${userId}- 前缀开头返回 true", () => {
    expect(keyBelongsToUser("user-1-123.png", "user-1")).toBe(true);
  });

  it("以 ${userId}/ 前缀开头返回 true", () => {
    expect(keyBelongsToUser("user-1/nested/a.png", "user-1")).toBe(true);
  });

  it("与 ${userId} 完全相等返回 true", () => {
    expect(keyBelongsToUser("user-1", "user-1")).toBe(true);
  });

  it("他人 key 返回 false", () => {
    expect(keyBelongsToUser("user-2-123.png", "user-1")).toBe(false);
  });

  it("子串混淆攻击（userId 为另一 userId 的前缀）应返回 false（防回归）", () => {
    // 旧实现用 key.includes(userId)，此处会被绕过返回 true，新实现锚定边界返回 false
    expect(keyBelongsToUser("user-12-evil.png", "user-1")).toBe(false);
  });

  it("userId 出现在 key 中间不算归属", () => {
    expect(keyBelongsToUser("victim/user-1-x.png", "user-1")).toBe(false);
  });

  it("空 userId 返回 false", () => {
    expect(keyBelongsToUser("anything", "")).toBe(false);
  });
});

describe("isBucketAllowed", () => {
  it("白名单内返回 true", () => {
    expect(isBucketAllowed("avatars", ["avatars"])).toBe(true);
  });

  it("白名单外返回 false", () => {
    expect(isBucketAllowed("generations", ["avatars"])).toBe(false);
  });

  it("空白名单一律返回 false", () => {
    expect(isBucketAllowed("avatars", [])).toBe(false);
  });
});

describe("storageKeyBelongsToUser", () => {
  const owner = "user-123";

  it("接受 generations 桶各写入方的本人键布局", () => {
    for (const key of [
      `${owner}/abc123.png`,
      `${owner}/rehost/gen-1-0.png`,
      `${owner}/requests/gen-2-1.webp`,
      `${owner}/deck.psd`,
      `support/${owner}/att-1.png`,
    ]) {
      expect(storageKeyBelongsToUser(key, owner), key).toBe(true);
    }
  });

  it("拒绝他人键，包括前缀相近与工单附件", () => {
    for (const key of [
      "user-1234/abc.png",
      "other-user/abc.png",
      `support/other-user/att-1.png`,
      `prefix-${owner}/abc.png`,
      `nested/${owner}/abc.png`,
    ]) {
      expect(storageKeyBelongsToUser(key, owner), key).toBe(false);
    }
  });

  it("空键或空用户一律拒绝", () => {
    expect(storageKeyBelongsToUser("", owner)).toBe(false);
    expect(storageKeyBelongsToUser(`${owner}/a.png`, "")).toBe(false);
  });
});
