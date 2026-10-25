/** 画布契约回归；使用真实注册表和网关，验证权限、严格空输入与未绑定行为。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import {
  bindExecute,
  clearRegistry,
  defineOperation,
  getOperation,
} from "../registry";
import { canvasListImages } from "./canvas";

const user: Principal = { type: "user", userId: "owner", role: "user" };
const unboundExecute = canvasListImages.execute;
const execute = vi.fn(async () => []);

beforeEach(() => {
  clearRegistry();
  defineOperation({ ...canvasListImages, execute: unboundExecute });
  execute.mockClear();
});

describe("canvas.listImages 契约", () => {
  it("注册受保护的无副作用、天然幂等只读操作", () => {
    expect(getOperation("canvas.listImages")).toMatchObject({
      access: { kind: "protected" },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
  });

  it("真实网关在未绑定时返回 not_implemented", async () => {
    await expect(
      invokeOperation("canvas.listImages", {}, user)
    ).rejects.toMatchObject({ code: "not_implemented" });
  });

  it("真实网关接受空对象并将原 principal 传入绑定", async () => {
    bindExecute("canvas.listImages", execute);
    await expect(
      invokeOperation("canvas.listImages", {}, user)
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledWith(
      {},
      user,
      expect.objectContaining({
        requestId: expect.any(String),
        assertOwnership: expect.any(Function),
      })
    );
  });

  it.each([
    { userId: "victim" },
    { limit: 1000 },
    { cursor: "older" },
    undefined,
    null,
  ])("拒绝客户端输入 %j，不能选择他人或扩大查询", async (input) => {
    bindExecute("canvas.listImages", execute);
    await expect(
      invokeOperation("canvas.listImages", input, user)
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each<Principal>([
    { type: "cron", job: "canvas" },
    { type: "webhook", provider: "creem" },
    { type: "proxy", secretKind: "gateway" },
  ])("真实 protected 权限拒绝 $type", async (principal) => {
    bindExecute("canvas.listImages", execute);
    await expect(
      invokeOperation("canvas.listImages", {}, principal)
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(execute).not.toHaveBeenCalled();
  });
});
