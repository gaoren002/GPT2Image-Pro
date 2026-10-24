/** SafeAction 集成回归：真实中间件与 Drizzle 错误，认证、日志和监控使用边界替身。 */
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const sinks = vi.hoisted(() => ({
  logError: vi.fn(),
  captureError: vi.fn(),
  info: vi.fn(),
}));
vi.mock("./auth/index", () => ({ auth: { api: {} } }));
vi.mock("./auth/role-server", () => ({ getUserRoleById: vi.fn() }));
vi.mock("./logger/index", () => ({
  logError: sinks.logError,
  logger: { info: sinks.info, debug: vi.fn() },
}));
vi.mock("./monitoring/index", () => ({ captureError: sinks.captureError }));

import { ActionUserError, actionClient } from "./safe-action";

const SECRET = "rt_safe_action_regression_secret";
const SQL = 'insert into "image_backend_account" ("refresh_token") values ($1)';

/** 真实构造器不设置 name；无驱动码的断连也必须识别为数据库错误。 */
function queryError(code?: string) {
  return new DrizzleQueryError(
    SQL,
    [SECRET],
    Object.assign(new Error(`driver detail ${SECRET}`), {
      ...(code ? { code } : {}),
      constraint: "account_token_unique",
      table: "image_backend_account",
    })
  );
}

/** 通过真实 next-safe-action 执行失败路径，包含外层完成日志。 */
async function failAction(error: Error) {
  const action = actionClient
    .metadata({ action: "regression.failure" })
    .schema(z.object({}))
    .action(async () => {
      throw error;
    });
  return action({});
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("SafeAction 数据库错误脱敏", () => {
  it.each([
    "development",
    "test",
    "production",
  ])("%s 环境中 SQL、参数、原始 cause/stack 均不进入响应或监控", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const original = queryError("23505");
    expect(original.name).toBe("Error");
    expect(original.message).toContain(SECRET);
    const result = await failAction(original);
    expect(result?.serverError).toBe("数据库操作失败，请稍后重试");
    expect(sinks.logError).toHaveBeenCalledTimes(1);
    expect(sinks.captureError).toHaveBeenCalledTimes(1);
    for (const sink of [sinks.logError, sinks.captureError]) {
      const [reported, context] = sink.mock.calls[0] ?? [];
      expect(reported).toBeInstanceOf(Error);
      expect(reported).not.toBe(original);
      expect(reported).toMatchObject({
        name: "DatabaseError",
        message:
          "DatabaseError(code=23505, constraint=account_token_unique, table=image_backend_account)",
      });
      expect(reported.cause).toBeUndefined();
      expect(reported.query).toBeUndefined();
      expect(reported.params).toBeUndefined();
      expect(context).toEqual({ source: "server-action" });
      expect(reported.stack).not.toContain(SECRET);
      expect(reported.stack).not.toContain(SQL);
    }
    const serialized = JSON.stringify({
      result,
      log: sinks.logError.mock.calls,
      sentry: sinks.captureError.mock.calls,
      completed: sinks.info.mock.calls,
    });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SQL);
    expect(serialized).not.toContain("params:");
  });

  it.each([
    undefined,
    "55P03",
  ])("无驱动码或锁超时 %s 也只返回安全提示", async (code) => {
    const result = await failAction(queryError(code));
    expect(result?.serverError).toBe("数据库操作失败，请稍后重试");
    expect(sinks.captureError.mock.calls[0]?.[0]).not.toHaveProperty("params");
  });

  it("业务错误包装了数据库 cause 时不能绕过脱敏", async () => {
    const error = Object.assign(new ActionUserError(`导入失败 ${SECRET}`), {
      cause: queryError("23505"),
    });
    const result = await failAction(error);
    expect(result?.serverError).toBe("数据库操作失败，请稍后重试");
    expect(sinks.captureError.mock.calls[0]?.[0]).not.toBe(error);
  });

  it("生产环境仍保留已知业务错误的可用文案", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = await failAction(
      new ActionUserError("余额不足，请充值后重试")
    );
    expect(result?.serverError).toBe("余额不足，请充值后重试");
    expect(sinks.logError).not.toHaveBeenCalled();
    expect(sinks.captureError).not.toHaveBeenCalled();
  });

  it("带普通业务码的已知错误也不误判成数据库错误", async () => {
    const error = Object.assign(new ActionUserError("套餐额度已用尽"), {
      code: "QUOTA_EXCEEDED",
    });
    expect((await failAction(error))?.serverError).toBe("套餐额度已用尽");
  });

  it("非数据库未知错误沿用现有环境规则", async () => {
    const error = new Error("upstream refused");
    expect((await failAction(error))?.serverError).toBe("upstream refused");
    vi.stubEnv("NODE_ENV", "production");
    expect((await failAction(error))?.serverError).toBe(
      "服务器错误，请稍后重试"
    );
  });
});
