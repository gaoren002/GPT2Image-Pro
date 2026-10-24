/** 生成错误脱敏回归：真实 Drizzle 包装与驱动错误不得将 SQL、凭据或原始 cause 写入日志。 */
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@repo/shared/logger", () => ({ logError }));

import {
  isInternalDatabaseError,
  toClientErrorMessage,
} from "./error-sanitize";

const ACCESS_TOKEN = "test_access_token_error_sanitize";
const REFRESH_TOKEN = "rt_test_error_sanitize";
const QUERY =
  'update "image_backend_account" set "access_token" = $1, "refresh_token" = $2';

/** 真实 DrizzleQueryError 不设置 name，且断连 cause 可以没有 code。 */
function drizzleError(): DrizzleQueryError {
  return new DrizzleQueryError(
    QUERY,
    [ACCESS_TOKEN, REFRESH_TOKEN],
    new Error(`connection closed ${REFRESH_TOKEN}`)
  );
}

// node-postgres 原始错误：带 5 位 SQLSTATE code（42703=undefined_column）。
function pgError(code = "42703"): Error {
  const e = new Error("column does not exist");
  (e as Error & { code: string }).code = code;
  return e;
}

afterEach(() => vi.clearAllMocks());

describe("isInternalDatabaseError", () => {
  it("识别 Drizzle Failed query 与 Postgres SQLSTATE/severity", () => {
    expect(isInternalDatabaseError(drizzleError())).toBe(true);
    expect(isInternalDatabaseError(pgError("42703"))).toBe(true);
    expect(isInternalDatabaseError(pgError("57P01"))).toBe(true);
    const sev = new Error("db down");
    (sev as Error & { severity: string }).severity = "FATAL";
    expect(isInternalDatabaseError(sev)).toBe(true);
  });

  it("放行已知用户级错误与非 DB 错误", () => {
    expect(isInternalDatabaseError(new Error("Insufficient credits"))).toBe(
      false
    );
    expect(isInternalDatabaseError(new Error("分组无可用后端"))).toBe(false);
    // Node 系统错误码（非 5 位 SQLSTATE）不应误判。
    const enoent = new Error("ENOENT");
    (enoent as Error & { code: string }).code = "ENOENT";
    expect(isInternalDatabaseError(enoent)).toBe(false);
    expect(isInternalDatabaseError("plain string")).toBe(false);
    expect(isInternalDatabaseError(null)).toBe(false);
  });
});

describe("toClientErrorMessage", () => {
  const ctx = { source: "test", generationId: "g1" };

  it("DB/内部错误回 fallback（不暴露裸 SQL）", () => {
    const msg = toClientErrorMessage(drizzleError(), ctx, "请稍后重试");
    expect(msg).toBe("请稍后重试");
    expect(msg).not.toContain("Failed query");
    expect(msg).not.toContain("api_key");
    expect(toClientErrorMessage(pgError(), ctx, "请稍后重试")).toBe(
      "请稍后重试"
    );
  });

  it.each([
    false,
    true,
  ])("无 code 的真实 Drizzle 错误及其 cause 包装不进入日志（wrapped=%s）", (wrapped) => {
    const original = drizzleError();
    expect(original.name).toBe("Error");
    expect(original.cause).not.toHaveProperty("code");
    expect(original.message).toContain(ACCESS_TOKEN);
    const error = wrapped
      ? new Error("生成服务失败", { cause: original })
      : original;

    expect(toClientErrorMessage(error, ctx, "请稍后重试")).toBe("请稍后重试");
    expect(logError).toHaveBeenCalledTimes(1);
    const [reported, context] = logError.mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBe(error);
    expect(reported).not.toBe(original);
    expect(reported.name).toBe("DatabaseError");
    expect(reported.message).toBe("DatabaseError");
    expect(reported).not.toHaveProperty("cause");
    expect(reported).not.toHaveProperty("query");
    expect(reported).not.toHaveProperty("params");
    expect(context).toEqual(ctx);
    const logged = JSON.stringify({
      reported: Object.getOwnPropertyDescriptors(reported),
      context,
    });
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logged).not.toContain(QUERY);
    expect(logged).not.toContain("params:");
  });

  it("仅有 severity 的驱动错误也重建安全日志对象", () => {
    const error = Object.assign(new Error(`db down ${REFRESH_TOKEN}`), {
      severity: "FATAL",
    });
    expect(toClientErrorMessage(error, ctx, "请稍后重试")).toBe("请稍后重试");
    const [reported, context] = logError.mock.calls[0] ?? [];
    expect(reported).not.toBe(error);
    expect(reported).toMatchObject({
      name: "DatabaseError",
      message: "DatabaseError",
    });
    expect(reported.stack).not.toContain(REFRESH_TOKEN);
    expect(reported).not.toHaveProperty("cause");
    expect(context).toEqual(ctx);
  });

  it("数据库日志保留错误码与可定位 context", () => {
    toClientErrorMessage(pgError(), { source: "test" }, "fallback");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DatabaseError",
        message: "DatabaseError(code=42703)",
      }),
      { source: "test" }
    );
  });

  it("用户级错误原样透传", () => {
    expect(
      toClientErrorMessage(new Error("Insufficient credits"), ctx, "fallback")
    ).toBe("Insufficient credits");
  });

  it("非 Error 回 fallback", () => {
    expect(toClientErrorMessage("boom", ctx, "fallback")).toBe("fallback");
  });
});
