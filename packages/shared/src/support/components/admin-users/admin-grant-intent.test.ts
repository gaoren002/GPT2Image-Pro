/** 充值 UI 请求意图回归：重试/双击复用、成功后换键、编辑或切换目标不能复用旧键。 */
import { describe, expect, it } from "vitest";
import { createAdminGrantIntent } from "./admin-grant-intent";

const input = { userId: "u1", amount: 20, reason: "客服补偿" };

describe("管理员充值请求意图", () => {
  it("网络失败保留 UUID，同步双击只允许一次开始，成功后生成新 UUID", () => {
    const intent = createAdminGrantIntent();
    const first = intent.begin(input);
    expect(first?.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(intent.begin(input)).toBeNull();
    if (!first) throw new Error("未创建充值意图");
    intent.finish(first.requestId, false);
    const retry = intent.begin(input);
    expect(retry).toEqual(first);
    intent.finish(first.requestId, true);
    expect(intent.begin(input)?.requestId).not.toBe(first.requestId);
  });
  it.each([
    { amount: 21 },
    { userId: "u2" },
    { reason: "活动奖励" },
  ])("修改参数换键 %j", (changed) => {
    const intent = createAdminGrantIntent();
    const first = intent.begin(input);
    if (!first) throw new Error("未创建充值意图");
    intent.finish(first.requestId, false);
    expect(intent.begin({ ...input, ...changed })?.requestId).not.toBe(
      first.requestId
    );
  });
  it("编辑后再改回原值，以及显式重新打开表单，均是新意图", () => {
    const intent = createAdminGrantIntent();
    const first = intent.begin(input);
    if (!first) throw new Error("未创建充值意图");
    intent.finish(first.requestId, false);
    intent.reset();
    expect(intent.begin(input)?.requestId).not.toBe(first.requestId);
  });
  it("在途不能重置或提交另一目标；过期回调不能清除在途请求", () => {
    const intent = createAdminGrantIntent();
    const first = intent.begin(input);
    if (!first) throw new Error("未创建充值意图");
    expect(intent.reset()).toBe(false);
    intent.finish("stale-request", true);
    expect(intent.begin({ ...input, userId: "u2" })).toBeNull();
    intent.finish(first.requestId, false);
    expect(intent.begin(input)).toEqual(first);
  });
});
