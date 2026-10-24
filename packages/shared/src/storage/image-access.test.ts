/** 不可信图片引用不能为他人的链接续签；所有调用均使用真实签名实现。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublicImageUrl,
  generateSignedImageUrl,
  buildStorageThumbnailUrl,
  verifySignedImageUrl,
} from "./signed-url";

const base = "https://app.example.test";
// 安全上下文使归属与有效签名成为重签边界。
const build = buildPublicImageUrl;

beforeEach(() =>
  vi.stubEnv("BETTER_AUTH_SECRET", "test-image-reference-secret")
);
afterEach(() => vi.unstubAllEnvs());

describe("不可信存储图片地址", () => {
  it("自己的过期链接允许续签", () => {
    const old = generateSignedImageUrl("generations", "alice/image.png", -5);
    const renewed = new URL(build(old, base, 3600, { userId: "alice" }) ?? "");
    expect(Number(renewed.searchParams.get("exp"))).toBeGreaterThan(
      Date.now() / 1000
    );
  });

  it.each([
    "/api/storage/generations/bob/image.png",
    generateForeignExpired,
  ])("他人的裸链接或过期链接不能续签: %s", (value) => {
    const url = typeof value === "function" ? value() : value;
    expect(() => build(url, base, 3600, { userId: "alice" })).toThrow(
      /permission|signature|access/i
    );
  });

  it("他人有效签名可作为访问凭证，但不延长其有效期", () => {
    const signed = generateSignedImageUrl("generations", "bob/image.png", 30);
    const result = new URL(
      build(signed, base, 3600, { userId: "alice" }) ?? ""
    );
    const original = new URL(signed, base);
    expect(result.searchParams.get("exp")).toBe(
      original.searchParams.get("exp")
    );
    expect(result.searchParams.get("sig")).toBe(
      original.searchParams.get("sig")
    );
  });

  it("未知私有桶即使签名正确也不能透传或读取", () => {
    const signed = generateSignedImageUrl("private-backups", "alice/image.png");
    expect(() => build(signed, base, 3600, { userId: "alice" })).toThrow(
      /bucket|access/i
    );
  });

  it("本人缩略图续签使用原始对象键，保留宽度路径", () => {
    const input = buildStorageThumbnailUrl(
      generateSignedImageUrl("generations", "alice/image.png"),
      320
    );
    const renewed = new URL(
      build(input, base, 3600, { userId: "alice" }) ?? ""
    );
    expect(renewed.pathname).toContain("/w320/alice/image.png");
    expect(
      verifySignedImageUrl(
        "generations",
        "alice/image.png",
        renewed.searchParams.get("sig") ?? "",
        Number(renewed.searchParams.get("exp"))
      )
    ).toBe("valid");
  });

  it("公开头像与外部图片保持可用", () => {
    expect(build("/api/storage/avatars/icon.png", base, 3600, {})).toBe(
      `${base}/api/storage/avatars/icon.png`
    );
    expect(build("https://cdn.example.test/image.png", base, 3600, {})).toBe(
      "https://cdn.example.test/image.png"
    );
  });
});

function generateForeignExpired() {
  return generateSignedImageUrl("generations", "bob/image.png", -5);
}
