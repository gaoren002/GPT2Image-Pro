/** 真实 IndexedDB 事务回归：旧恢复稿不得覆盖其他标签页已提交任务并重复发出付费 POST。 */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanvasStorage } from "./persistence";
import { assertWorkflowAttemptTransition } from "./workflow-attempt-guard";
import { executeWorkflowNode } from "./workflow-execution";

const firstId = "92c237cf-0d2d-47d7-9a7a-b376ddf9a923";
const secondId = "37b4d965-ac0b-4b81-82fb-1e1491ba7856";
const plan = {
  nodeId: "generate",
  prompt: "fixture",
  model: "gpt-image-2.5" as const,
  size: "1024x1024" as const,
  quality: "medium" as const,
  images: [],
};

/** 使用存储支持的最小 JSON 文档构造任务交错，省略无关的画布几何和组件。 */
function scene(id?: string, state = "unconfirmed") {
  return JSON.stringify({
    type: "gpt2image-workflow",
    version: 1,
    nodes: [
      {
        id: "generate",
        data: {
          kind: "generate",
          ...(id
            ? {
                attempt: {
                  generationId: id,
                  state,
                  startedAt: "2026-10-25T10:00:00Z",
                },
              }
            : {}),
        },
      },
    ],
    edges: [],
  });
}
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("工作流持久任务保护", () => {
  it.each([
    scene(),
    scene(secondId),
    JSON.stringify({
      type: "gpt2image-workflow",
      version: 1,
      nodes: [],
      edges: [],
    }),
  ])("拒绝旧草稿删除或替换未知任务", (next) => {
    expect(() => assertWorkflowAttemptTransition(scene(firstId), next)).toThrow(
      "未确认任务"
    );
  });
  it.each([
    "unconfirmed",
    "completed",
    "acknowledged",
  ])("同编号可以转换为 %s", (state) => {
    expect(() =>
      assertWorkflowAttemptTransition(scene(firstId), scene(firstId, state))
    ).not.toThrow();
  });
  it("已完成或已核对的任务允许下一次显式生成", () => {
    expect(() =>
      assertWorkflowAttemptTransition(
        scene(firstId, "completed"),
        scene(secondId)
      )
    ).not.toThrow();
    expect(() =>
      assertWorkflowAttemptTransition(
        scene(firstId, "acknowledged"),
        scene(secondId)
      )
    ).not.toThrow();
  });
  it("同事务保护旧值：旧标签保存被拒，原任务仍可读取", async () => {
    const first = await openCanvasStorage("owner", "workflow");
    const second = await openCanvasStorage("owner", "workflow");
    try {
      await first.write(scene());
      await second.write(scene(firstId));
      await expect(first.write(scene())).rejects.toThrow("未确认任务");
      expect(await second.read()).toBe(scene(firstId));
      await second.write(scene(firstId, "completed"));
      await first.write(scene(secondId));
      expect(await first.read()).toBe(scene(secondId));
    } finally {
      first.close();
      second.close();
    }
  });
  it("另一页已提交后，旧恢复稿在 beforeSubmit 被拒，实际只发一次 POST", async () => {
    const a = await openCanvasStorage("two-tabs", "workflow");
    const b = await openCanvasStorage("two-tabs", "workflow");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("ACK lost"));
    try {
      await a.write(scene());
      await expect(
        executeWorkflowNode({
          plan,
          generationId: firstId,
          signal: new AbortController().signal,
          fetcher,
          beforeSubmit: () => b.write(scene(firstId)),
        })
      ).rejects.toMatchObject({ submitted: true });
      await expect(
        executeWorkflowNode({
          plan,
          generationId: secondId,
          signal: new AbortController().signal,
          fetcher,
          beforeSubmit: () => a.write(scene(secondId)),
        })
      ).rejects.toMatchObject({ submitted: false });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await a.read()).toBe(scene(firstId));
    } finally {
      a.close();
      b.close();
    }
  });
});
