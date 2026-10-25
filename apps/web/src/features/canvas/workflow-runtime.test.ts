// @vitest-environment jsdom
/** 真运行 Hook + 真 IDB 事务：立即重跑时必须先持久化原任务的核对/完成态。 */
import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCanvasStorage } from "./persistence";
import {
  createWorkflowDocument,
  serializeWorkflowDocument,
  type WorkflowDocument,
} from "./workflow-model";
import { useWorkflowRuntime } from "./workflow-runtime";

afterEach(() => vi.unstubAllGlobals());

describe("工作流终态到下一次运行", () => {
  it.each([
    "acknowledged",
    "completed",
  ] as const)("%s 在新任务编号之前提交，不受自动保存延迟影响", async (terminal) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const storage = await openCanvasStorage(`rerun-${terminal}`, "workflow");
    const oldId = "1864fb5c-105d-45bb-a622-244cb36e7aa3";
    const initial = createWorkflowDocument();
    const prompt = initial.nodes.find((node) => node.data.kind === "prompt");
    const generate = initial.nodes.find(
      (node) => node.data.kind === "generate"
    );
    if (prompt?.data.kind !== "prompt" || generate?.data.kind !== "generate")
      throw new Error("夹具缺少节点");
    prompt.data.text = "a fixture image";
    generate.data.attempt = {
      generationId: oldId,
      state: "unconfirmed",
      startedAt: "2026-10-25T10:00:00.000Z",
    };
    await storage.write(serializeWorkflowDocument(initial));
    let workflowDocument: WorkflowDocument = structuredClone(initial);
    const recovered = workflowDocument.nodes.find(
      (node) => node.id === generate.id
    );
    if (recovered?.data.kind !== "generate" || !recovered.data.attempt)
      throw new Error("夹具缺少任务");
    recovered.data.attempt.state = terminal;
    if (terminal === "completed")
      recovered.data.result = {
        id: oldId,
        prompt: "previous fixture",
        url: "/api/storage/generations/owner/previous.png",
        thumbnailUrl: "/api/storage/generations/owner/previous.png",
      };
    const saved: string[] = [];
    const store = {
      current: () => workflowDocument,
      update: (next: WorkflowDocument) => {
        workflowDocument = next;
      },
      save: async () => {
        const node = workflowDocument.nodes.find(
          (candidate) => candidate.id === generate.id
        );
        if (node?.data.kind !== "generate") throw new Error("节点丢失");
        saved.push(node.data.attempt?.state ?? "none");
        await storage.write(serializeWorkflowDocument(workflowDocument));
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as { generationId: string };
      return new Response(
        JSON.stringify({
          generationId: input.generationId,
          imageUrl: "/api/storage/generations/owner/result.png",
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    let runtime: ReturnType<typeof useWorkflowRuntime> | undefined;
    /** 真实 React 生命周期，不替换 useEffect 或回调中的保存/执行顺序。 */
    function Probe() {
      runtime = useWorkflowRuntime(store, {
        onRefreshImages: async () => undefined,
        onContinueEditing: async () => undefined,
      });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Probe)));
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error("Hook 未挂载");
      await act(async () => activeRuntime.runNode(generate.id));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(saved).toEqual([terminal, "unconfirmed", "completed"]);
      const final = workflowDocument.nodes.find(
        (node) => node.id === generate.id
      );
      expect(
        final?.data.kind === "generate" ? final.data.attempt : undefined
      ).toMatchObject({ state: "completed" });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      storage.close();
    }
  });
});
