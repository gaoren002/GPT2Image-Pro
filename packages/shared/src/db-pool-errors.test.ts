/** 真实 EventEmitter 语义：连接断开不能变成未监听异常，日志不能带凭据/SQL。 */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { observePoolErrors } from "../../database/src/pool-errors";

afterEach(() => vi.restoreAllMocks());

it("池与借出的连接错误均被接住，重复安装不重复记日志", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pool = new EventEmitter();
  const client = new EventEmitter();
  observePoolErrors(pool);
  observePoolErrors(pool);
  pool.emit("connect", client);
  pool.emit("connect", client);
  const error = Object.assign(
    new Error("Failed query params: sk-test-secret"),
    { code: "57P01" }
  );
  expect(() => client.emit("error", error)).not.toThrow();
  expect(() => pool.emit("error", error, client)).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).toContain("57P01");
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(
    /params|secret|Failed query/
  );
});

it("接住错误事件不把失败查询改成成功", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pool = new EventEmitter();
  const client = new EventEmitter();
  observePoolErrors(pool);
  pool.emit("connect", client);
  const queryError = new Error("connection closed");
  const query = new Promise<void>((_resolve, reject) => {
    reject(queryError);
    client.emit("error", queryError);
  });
  await expect(query).rejects.toBe(queryError);
});
