/** 画布服务回归；保留真实 UOL、Drizzle SQL 构造和 HMAC，只替换数据库驱动。 */
import { verifySignedImageUrl } from "@repo/shared/storage/signed-url";
import { invokeOperation, type Principal } from "@repo/shared/uol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as { sql: string; params: unknown[] }[],
  rows: [] as [string, string, string | null, string | null][],
  failure: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql: string, params: unknown[]) => {
      state.queries.push({ sql, params });
      if (state.failure) throw new Error("private database failure");
      return { rows: state.rows };
    }),
  };
});

import { listCanvasImagesForUser } from "./server";

const expectedSql =
  'select "id", "prompt", "storage_key", "storage_bucket" from "generation" ' +
  'where ("generation"."user_id" = $1 and "generation"."status" = $2 ' +
  'and "generation"."storage_key" is not null ' +
  'and btrim("generation"."storage_key") <> \'\') ' +
  'order by "generation"."created_at" desc, "generation"."id" desc limit $3';

beforeEach(() => {
  state.queries = [];
  state.rows = [];
  state.failure = false;
  vi.stubEnv("BETTER_AUTH_SECRET", "canvas-test-signing-secret");
  vi.stubEnv("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME", "generations");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("画布服务经真实 UOL 查询", () => {
  it("SQL 先限制本人、completed 和非空主图，再稳定倒序并限制 36 条", async () => {
    await expect(listCanvasImagesForUser("owner")).resolves.toEqual([]);
    expect(state.queries).toEqual([
      {
        sql: expectedSql,
        params: ["owner", "completed", 36],
      },
    ]);
  });

  it.each([
    "owner-a",
    "owner-b",
    "' OR true --",
  ])("归属来自服务端 principal，用户 %s 始终是绑定参数", async (userId) => {
    await listCanvasImagesForUser(userId);
    expect(state.queries).toEqual([
      {
        sql: expectedSql,
        params: [userId, "completed", 36],
      },
    ]);
  });

  it.each<Principal>([
    { type: "user", userId: "admin-owner", role: "admin" },
    { type: "user", userId: "super-owner", role: "super_admin" },
    { type: "user", userId: "observer-owner", role: "observer_admin" },
    {
      type: "apiKey",
      userId: "key-owner",
      apiKeyId: "key",
      plan: "free",
      relayOnly: false,
    },
  ])("$type 调用也只查询自己的行，没有管理员全局分支", async (principal) => {
    await invokeOperation("canvas.listImages", {}, principal);
    expect(state.queries).toEqual([
      {
        sql: expectedSql,
        params: [
          "userId" in principal ? principal.userId : undefined,
          "completed",
          36,
        ],
      },
    ]);
  });

  it.each<Principal>([
    { type: "system", reason: "no owner" },
    { type: "cron", job: "no owner" },
    { type: "webhook", provider: "creem" },
    { type: "proxy", secretKind: "proxy" },
    { type: "user", userId: "", role: "user" },
    { type: "user", userId: "   ", role: "user" },
  ])("没有有效用户的身份被拒绝且不访问数据库：%j", async (principal) => {
    await expect(
      invokeOperation("canvas.listImages", {}, principal)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(state.queries).toEqual([]);
  });

  it("试图传入他人 userId 或更大 limit 时在查询前拒绝", async () => {
    const principal: Principal = {
      type: "user",
      userId: "owner",
      role: "user",
    };
    for (const input of [{ userId: "victim" }, { limit: 37 }]) {
      await expect(
        invokeOperation("canvas.listImages", input, principal)
      ).rejects.toMatchObject({ code: "validation_error" });
    }
    expect(state.queries).toEqual([]);
  });

  it("只返回主图的四个字段，生成真实有效的同源签名和 320 缩略图", async () => {
    state.rows = [["main-1", "原始提示词", "owner/main.png", "private-images"]];
    const images = await listCanvasImagesForUser("owner");
    expect(images).toHaveLength(1);
    const source = images[0];
    if (!source) throw new Error("缺少主图");
    expect(Object.keys(source).sort()).toEqual([
      "id",
      "prompt",
      "thumbnailUrl",
      "url",
    ]);
    expect(source).toMatchObject({ id: "main-1", prompt: "原始提示词" });
    expect(source.url).toMatch(
      /^\/api\/storage\/private-images\/owner\/main\.png\?sig=/
    );
    const original = new URL(source.url, "https://canvas.example");
    const thumbnail = new URL(source.thumbnailUrl, original);
    expect(original.origin).toBe("https://canvas.example");
    expect(thumbnail.origin).toBe(original.origin);
    expect(thumbnail.pathname).toBe(
      "/api/storage/private-images/w320/owner/main.png"
    );
    expect(thumbnail.search).toBe(original.search);
    expect(
      verifySignedImageUrl(
        "private-images",
        "owner/main.png",
        original.searchParams.get("sig") ?? "",
        Number(original.searchParams.get("exp"))
      )
    ).toBe("valid");
  });

  it("保留 SQL 返回的最近 36 张主图顺序；缺省桶沿用现有签名函数", async () => {
    state.rows = Array.from({ length: 36 }, (_, index) => [
      `main-${36 - index}`,
      `prompt-${index}`,
      `owner/${index}.png`,
      null,
    ]);
    const images = await listCanvasImagesForUser("owner");
    expect(images.map(({ id }) => id)).toEqual(state.rows.map(([id]) => id));
    expect(images).toHaveLength(36);
    expect(
      images.every(
        ({ url, thumbnailUrl }) =>
          url.startsWith("/api/storage/generations/owner/") &&
          thumbnailUrl.startsWith("/api/storage/generations/w320/owner/")
      )
    ).toBe(true);
    expect(state.queries[0]?.params).toEqual(["owner", "completed", 36]);
  });

  it("数据库失败经真实网关隐藏内部错误，不返回部分数据", async () => {
    state.failure = true;
    await expect(listCanvasImagesForUser("owner")).rejects.toMatchObject({
      code: "internal_error",
      message: "An unexpected error occurred",
    });
  });
});
