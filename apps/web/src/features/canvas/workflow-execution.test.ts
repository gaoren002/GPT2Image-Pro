/** HTTP 替身验证工作流只走既有 API、提交屏障、编辑参数、凭据边界与未知结果不重试。 */
import { describe, expect, it, vi } from "vitest";
import {
  executeWorkflowNode,
  fetchWorkflowImage,
  MAX_WORKFLOW_IMAGE_BYTES,
  WorkflowExecutionError,
} from "./workflow-execution";
import {
  buildWorkflowRunPlan,
  createWorkflowDocument,
  type WorkflowImage,
} from "./workflow-model";

const generationId = "5cd4d421-ff67-444d-8329-64385858c530";
const image: WorkflowImage = {
  id: "my-image",
  prompt: "本人作品",
  url: "/api/storage/generations/user/source.png?sig=abc&exp=123",
  thumbnailUrl: "/api/storage/generations/user/source.png?sig=abc&exp=123",
};
/** 创建独立单节点计划，不通过真实路由调用上游或扣费。 */
function plan() {
  const document = createWorkflowDocument();
  const prompt = document.nodes[0];
  if (prompt?.data.kind !== "prompt") throw new Error("缺少提示词");
  prompt.data.text = "测试图片";
  return buildWorkflowRunPlan(document, "generate-start");
}
/** 用单个站内输出模拟真实 route 的 JSON 响应形状。 */
function success() {
  return Response.json({
    generationId,
    imageUrl: "/api/storage/generations/user/output.png?sig=out&exp=123",
    imageBase64: "ignored",
    creditsConsumed: 1.31,
  });
}

describe("工作流执行 HTTP 适配", () => {
  it("先完成任务编号落盘屏障，再以单张非流式 JSON 调用现有 generate", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      order.push("POST");
      return success();
    });
    const beforeSubmit = vi.fn(async () => {
      order.push("save-start");
      await checkpoint;
      order.push("save-complete");
    });
    const promise = executeWorkflowNode({
      plan: plan(),
      generationId,
      signal: new AbortController().signal,
      beforeSubmit,
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    release?.();
    const result = await promise;
    expect(order).toEqual(["save-start", "save-complete", "POST"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/api/images/generate");
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      prompt: "测试图片",
      model: "gpt-image-2.5",
      size: "1024x1024",
      quality: "medium",
      count: 1,
      generationId,
      stream: false,
    });
    expect(result).toMatchObject({
      id: generationId,
      url: "/api/storage/generations/user/output.png?sig=out&exp=123",
    });
    expect(result).not.toHaveProperty("imageBase64");
  });
  it("有多张输入时下载本站签名图并传 File[]，不手动覆盖 multipart boundary", async () => {
    const input = plan();
    input.images = [
      image,
      {
        ...image,
        id: "other",
        url: "/api/storage/generations/user/second.jpg",
      },
    ];
    const order: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      order.push(String(url));
      return String(url).startsWith("/api/storage/")
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: { "Content-Type": "image/png" },
          })
        : success();
    });
    await executeWorkflowNode({
      plan: input,
      generationId,
      signal: new AbortController().signal,
      beforeSubmit: async () => {
        order.push("saved");
      },
      fetcher,
    });
    expect(order).toEqual([
      image.url,
      input.images[1]?.url,
      "saved",
      "/api/images/edit",
    ]);
    const options = fetcher.mock.calls[2]?.[1];
    expect(options?.headers).toEqual({ Accept: "application/json" });
    expect(options?.credentials).toBe("same-origin");
    expect(options?.redirect).toBe("error");
    const form = options?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("缺少 FormData");
    expect(
      Object.fromEntries(
        [...form.entries()].filter(([key]) => key !== "image[]")
      )
    ).toEqual({
      prompt: "测试图片",
      model: "gpt-image-2.5",
      size: "1024x1024",
      quality: "medium",
      count: "1",
      generationId,
      stream: "false",
    });
    const files = form.getAll("image[]");
    expect(files).toHaveLength(2);
    expect(
      files.every(
        (file) =>
          file instanceof File && file.type === "image/png" && file.size === 3
      )
    ).toBe(true);
    for (const [, settings] of fetcher.mock.calls) {
      const headers = new Headers(settings?.headers);
      expect(headers.has("Cookie")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
    }
  });
  it("存储屏障失败时不提交、不消耗网络请求", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      executeWorkflowNode({
        plan: plan(),
        generationId,
        signal: new AbortController().signal,
        beforeSubmit: async () => {
          throw new Error("quota exceeded");
        },
        fetcher,
      })
    ).rejects.toMatchObject({ submitted: false, message: "quota exceeded" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("屏障等待期间离开/abort，不发出付费 POST", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      executeWorkflowNode({
        plan: plan(),
        generationId,
        signal: controller.signal,
        beforeSubmit: async () => {
          controller.abort();
        },
        fetcher,
      })
    ).rejects.toMatchObject({ submitted: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("网络确认丢失保留 submitted=true，不自动重试", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      executeWorkflowNode({
        plan: plan(),
        generationId,
        signal: new AbortController().signal,
        beforeSubmit: async () => undefined,
        fetcher,
      })
    ).rejects.toMatchObject({
      name: "WorkflowExecutionError",
      submitted: true,
      message: "Failed to fetch",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("已提交后 abort 仍是未知结果，不声称任务撤销", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      executeWorkflowNode({
        plan: plan(),
        generationId,
        signal: controller.signal,
        beforeSubmit: async () => undefined,
        fetcher,
      })
    ).rejects.toMatchObject({ submitted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => new Response("<html>gateway error</html>", { status: 502 }),
    () => Response.json({ error: "积分不足" }, { status: 400 }),
    () =>
      Response.json({ generationId, imageUrl: "https://evil.test/output.png" }),
    () => Response.json({ generationId: "different", imageUrl: image.url }),
    () => Response.json({ generationId }),
    () =>
      Response.json({ generationId, imageUrl: image.url, error: "任务失败" }),
  ])("非法/失败返回不作为图片结果，也不自动重试", async (response) => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    await expect(
      executeWorkflowNode({
        plan: plan(),
        generationId,
        signal: new AbortController().signal,
        beforeSubmit: async () => undefined,
        fetcher,
      })
    ).rejects.toBeInstanceOf(WorkflowExecutionError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("参考图失败时不落盘任务，也不 POST", async () => {
    const input = plan();
    input.images = [image];
    const beforeSubmit = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("expired", { status: 403 })
    );
    await expect(
      executeWorkflowNode({
        plan: input,
        generationId,
        signal: new AbortController().signal,
        beforeSubmit,
        fetcher,
      })
    ).rejects.toMatchObject({ submitted: false });
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(image.url);
  });
});

describe("图片下载安全与限额", () => {
  it("外域/路径穿越在网络访问前就被拒绝", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const url of ["https://evil.test/x", "/api/storage/a/%2e%2e/evil"]) {
      await expect(
        fetchWorkflowImage(url, new AbortController().signal, fetcher)
      ).rejects.toThrow(/本站/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("拒绝不支持的 MIME、空图和声明超大响应", async () => {
    for (const response of [
      new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
      new Response(new Uint8Array(), {
        headers: { "Content-Type": "image/png" },
      }),
      new Response(new Uint8Array([1]), {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(MAX_WORKFLOW_IMAGE_BYTES + 1),
        },
      }),
    ]) {
      await expect(
        fetchWorkflowImage(
          image.url,
          new AbortController().signal,
          vi.fn<typeof fetch>(async () => response)
        )
      ).rejects.toThrow();
    }
  });
  it("拒绝 fetch 已经跟随的重定向，即使替身无视 redirect:error", async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "Content-Type": "image/png" },
    });
    Object.defineProperty(response, "redirected", { value: true });
    await expect(
      fetchWorkflowImage(
        image.url,
        new AbortController().signal,
        vi.fn<typeof fetch>(async () => response)
      )
    ).rejects.toThrow(/跳转/);
  });
  it("流式下载不信任 Content-Length，在实际超限时取消剩余响应", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_WORKFLOW_IMAGE_BYTES + 1));
      },
      cancel,
    });
    await expect(
      fetchWorkflowImage(
        image.url,
        new AbortController().signal,
        vi.fn<typeof fetch>(
          async () =>
            new Response(body, { headers: { "Content-Type": "image/png" } })
        )
      )
    ).rejects.toThrow(/大小限制/);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
