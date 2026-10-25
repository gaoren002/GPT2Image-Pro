/** 工作流模型回归：不引入数据库/DOM，验证导入安全、图约束、纯快照与单节点计划。 */
import { describe, expect, it } from "vitest";
import {
  buildWorkflowRunPlan,
  createWorkflowDocument,
  isWorkflowImageUrl,
  loadWorkflowDocument,
  MAX_WORKFLOW_BYTES,
  MAX_WORKFLOW_EDGES,
  MAX_WORKFLOW_IMAGES,
  MAX_WORKFLOW_NODES,
  MAX_WORKFLOW_PROMPT,
  parseWorkflowDocument,
  serializeWorkflowDocument,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowImage,
  type WorkflowNode,
  workflowConnectionError,
} from "./workflow-model";

const generationId = "5cd4d421-ff67-444d-8329-64385858c530";
const image: WorkflowImage = {
  id: "my-image",
  prompt: "本人作品",
  url: "/api/storage/generations/user/image.png?sig=abc&exp=123",
  thumbnailUrl: "/api/storage/generations/w320/user/image.png?sig=abc&exp=123",
};
/** 返回带实际提示词的独立图，测试之间不共享可变节点。 */
function sample(): WorkflowDocument {
  const document = createWorkflowDocument();
  document.nodes[0] = {
    id: "prompt-start",
    type: "workflow",
    position: { x: 0, y: 0 },
    data: { kind: "prompt", text: "  测试提示词  " },
  };
  return document;
}
/** 构造一个未运行生成节点；测试边与执行计划时不产生网络副作用。 */
function generate(id: string): WorkflowNode {
  return {
    id,
    type: "workflow",
    position: { x: 0, y: 0 },
    data: {
      kind: "generate",
      model: "gpt-image-2",
      size: "1536x1024",
      quality: "high",
    },
  };
}
/** 生成同类型端口连线，调用方可覆盖非法字段验证失败分支。 */
function imageEdge(source: string, target: string): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: "image",
    targetHandle: "image",
  };
}

describe("本站图片 URL 边界", () => {
  it("接受本站签名原图和缩略图", () => {
    expect(isWorkflowImageUrl(image.url)).toBe(true);
    expect(isWorkflowImageUrl(image.thumbnailUrl)).toBe(true);
    expect(
      isWorkflowImageUrl("/api/storage/generations/user/%E5%9B%BE.png")
    ).toBe(true);
  });
  it.each([
    "https://evil.test/api/storage/a/b.png",
    "//evil.test/api/storage/a/b.png",
    "data:image/png;base64,AA",
    "blob:https://site/a",
    "/api/storageevil/a/b",
    "/api/storage/",
    "/api/storage/a",
    "/api/storage/a//b",
    "/api/storage/a/../b",
    "/api/storage/a/%2e%2e/b",
    "/api/storage/a/%252e%252e/b",
    "/api/storage/a/%2fb",
    "/api/storage/a/%5cb",
    "/api/storage/a/\\evil",
    "/api/storage/a/%00b",
    "/api/storage/a/b#fragment",
    "/api/storage/a/\nb",
    "/api/storage/a/%zz",
    "/api/storage/a/b?x=\tfoo",
  ])("拒绝不安全地址 %s", (url) => expect(isWorkflowImageUrl(url)).toBe(false));
});

describe("工作流导入与纯快照", () => {
  it("默认图与空图合法，导出可完整恢复", () => {
    const document = sample();
    expect(loadWorkflowDocument(serializeWorkflowDocument(document))).toEqual(
      document
    );
    expect(
      parseWorkflowDocument({
        type: document.type,
        version: 1,
        nodes: [],
        edges: [],
      })
    ).toMatchObject({ nodes: [], edges: [] });
  });
  it("剔除函数、循环扩展字段、选择态和瞬时 running，保留未知任务号", () => {
    const document = sample();
    const generated = document.nodes[1];
    if (generated?.data.kind !== "generate")
      throw new Error("测试图缺少生成节点");
    generated.data.attempt = {
      generationId,
      state: "unconfirmed",
      startedAt: "2026-10-25T01:00:00.000Z",
    };
    const extras = {
      ...document,
      onRun: () => undefined,
      running: true,
      extra: document,
      nodes: document.nodes.map((node) => ({
        ...node,
        selected: true,
        measured: { width: 99 },
        data: {
          ...node.data,
          running: true,
          run: () => undefined,
          extra: document,
        },
      })),
    };
    extras.extra = extras;
    const json = serializeWorkflowDocument(extras);
    expect(json).not.toMatch(/onRun|running|selected|measured|extra/);
    expect(loadWorkflowDocument(json)).toEqual(document);
  });
  it.each([
    { version: 2 },
    { type: "excalidraw" },
    { nodes: null },
    { edges: {} },
    { viewport: { x: 0, y: 0, zoom: 0 } },
    { viewport: { x: Infinity, y: 0, zoom: 1 } },
  ])("拒绝非法顶层或视口 %j", (change) =>
    expect(() => parseWorkflowDocument({ ...sample(), ...change })).toThrow());
  it("限制节点/边数量与重复 ID", () => {
    const document = sample();
    document.nodes = Array.from({ length: MAX_WORKFLOW_NODES }, (_, index) =>
      generate(`n${index}`)
    );
    document.edges = [];
    expect(parseWorkflowDocument(document).nodes).toHaveLength(
      MAX_WORKFLOW_NODES
    );
    expect(() =>
      parseWorkflowDocument({
        ...document,
        nodes: [...document.nodes, generate("overflow")],
      })
    ).toThrow();
    expect(() =>
      parseWorkflowDocument({
        ...document,
        nodes: [generate("dup"), generate("dup")],
      })
    ).toThrow(/重复/);
    expect(() =>
      parseWorkflowDocument({
        ...sample(),
        edges: Array.from(
          { length: MAX_WORKFLOW_EDGES + 1 },
          () => sample().edges[0]
        ),
      })
    ).toThrow();
    expect(() =>
      parseWorkflowDocument({
        ...sample(),
        edges: [
          ...sample().edges,
          {
            ...imageEdge("generate-start", "generate-next"),
            id: "prompt-to-generate",
          },
        ],
      })
    ).toThrow(/重复/);
  });
  it("限制提示词长度、坐标、模型和参数枚举", () => {
    const document = sample();
    const first = document.nodes[0];
    if (first?.data.kind !== "prompt") throw new Error("缺少提示词");
    first.data.text = "文".repeat(MAX_WORKFLOW_PROMPT);
    expect(parseWorkflowDocument(document).nodes).toHaveLength(2);
    first.data.text += "字";
    expect(() => parseWorkflowDocument(document)).toThrow();
    expect(() =>
      parseWorkflowDocument({
        ...sample(),
        nodes: [{ ...generate("gen"), position: { x: NaN, y: 0 } }],
      })
    ).toThrow();
    for (const change of [
      { model: "external" },
      { size: "99999x99999" },
      { quality: "auto" },
      { attempt: { generationId: "bad", state: "running" } },
    ]) {
      expect(() =>
        parseWorkflowDocument({
          ...sample(),
          edges: [],
          nodes: [
            {
              ...generate("gen"),
              data: { ...generate("gen").data, ...change },
            },
          ],
        })
      ).toThrow();
    }
  });
  it("文件和已保存草稿的图片字段同样拒绝第三方地址", () => {
    for (const field of ["url", "thumbnailUrl"] as const) {
      const document = {
        ...sample(),
        nodes: [
          {
            id: "img",
            type: "workflow",
            position: { x: 0, y: 0 },
            data: {
              kind: "image",
              image: { ...image, [field]: "https://evil.test/x.png" },
            },
          },
        ],
        edges: [],
      };
      expect(() => loadWorkflowDocument(JSON.stringify(document))).toThrow(
        /本站/
      );
    }
  });
  it("非法文件失败不改变调用方已有草稿", () => {
    const document = sample();
    const previous = structuredClone(document);
    expect(() => loadWorkflowDocument("{broken")).toThrow(/JSON/);
    expect(document).toEqual(previous);
    expect(() =>
      loadWorkflowDocument(" ".repeat(MAX_WORKFLOW_BYTES + 1))
    ).toThrow(/4 MiB/);
    expect(() =>
      loadWorkflowDocument(`"${"文".repeat(MAX_WORKFLOW_BYTES / 2)}"`)
    ).toThrow(/4 MiB/);
  });
  it("拒绝没有完成记录的输出，以及没有输出的完成记录", () => {
    const node = generate("gen");
    if (node.data.kind !== "generate") throw new Error("缺少生成节点");
    node.data.result = image;
    expect(() =>
      parseWorkflowDocument({ ...sample(), edges: [], nodes: [node] })
    ).toThrow(/完成任务/);
    node.data.result = undefined;
    node.data.attempt = {
      generationId,
      state: "completed",
      startedAt: "2026-10-25T01:00:00.000Z",
    };
    expect(() =>
      parseWorkflowDocument({ ...sample(), edges: [], nodes: [node] })
    ).toThrow(/缺少图片/);
  });
});

describe("合法连线与循环", () => {
  it("拒绝自连接、悬空、错误端口、非生成目标及重复边", () => {
    const document = sample();
    expect(
      workflowConnectionError(
        document,
        imageEdge("generate-start", "generate-start")
      )
    ).toMatch(/自身/);
    expect(
      workflowConnectionError(document, imageEdge("missing", "generate-start"))
    ).toMatch(/不存在/);
    expect(
      workflowConnectionError(
        document,
        imageEdge("prompt-start", "generate-start")
      )
    ).toMatch(/提示词只能/);
    expect(
      workflowConnectionError(
        document,
        imageEdge("generate-start", "prompt-start")
      )
    ).toMatch(/只能连接到生成/);
    const existing = document.edges[0];
    if (!existing) throw new Error("缺少默认边");
    expect(workflowConnectionError(document, existing)).toMatch(/已经连接/);
  });
  it("每个生成节点一个提示词，图片输入受数量限制", () => {
    const document = sample();
    document.nodes.push({
      id: "prompt-other",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { kind: "prompt", text: "另一个" },
    });
    expect(
      workflowConnectionError(document, {
        source: "prompt-other",
        target: "generate-start",
        sourceHandle: "prompt",
        targetHandle: "prompt",
      })
    ).toMatch(/一个提示词/);
    for (let index = 0; index < MAX_WORKFLOW_IMAGES; index++) {
      document.nodes.push(generate(`input${index}`));
      document.edges.push(imageEdge(`input${index}`, "generate-start"));
    }
    document.nodes.push(generate("extra"));
    expect(parseWorkflowDocument(document).edges).toHaveLength(
      MAX_WORKFLOW_IMAGES + 1
    );
    expect(
      workflowConnectionError(document, imageEdge("extra", "generate-start"))
    ).toMatch(/最多连接/);
  });
  it("交互和文件恢复都拒绝多跳环，合法 DAG 不被误判", () => {
    const document = sample();
    document.nodes.push(generate("b"), generate("c"));
    document.edges.push(imageEdge("generate-start", "b"), imageEdge("b", "c"));
    expect(parseWorkflowDocument(document).edges).toHaveLength(3);
    const cycle = imageEdge("c", "generate-start");
    expect(workflowConnectionError(document, cycle)).toMatch(/循环/);
    expect(() =>
      parseWorkflowDocument({ ...document, edges: [...document.edges, cycle] })
    ).toThrow(/循环/);
    expect(
      workflowConnectionError(document, imageEdge("generate-start", "c"))
    ).toBeNull();
  });
});

describe("单节点运行计划", () => {
  it("只返回点击节点与直接输入，保留稳定边顺序，不修改原图", () => {
    const document = sample();
    document.nodes.push(
      {
        id: "img",
        type: "workflow",
        position: { x: 0, y: 0 },
        data: { kind: "image", image },
      },
      generate("unrelated")
    );
    document.edges.push(imageEdge("img", "generate-start"));
    const original = structuredClone(document);
    expect(buildWorkflowRunPlan(document, "generate-start")).toEqual({
      nodeId: "generate-start",
      prompt: "测试提示词",
      model: "gpt-image-2.5",
      size: "1024x1024",
      quality: "medium",
      images: [image],
    });
    expect(document).toEqual(original);
  });
  it("未填提示词、未选参考图、错误目标都不给运行计划", () => {
    expect(() =>
      buildWorkflowRunPlan(createWorkflowDocument(), "generate-start")
    ).toThrow(/填写/);
    expect(() => buildWorkflowRunPlan(sample(), "prompt-start")).toThrow(
      /请选择生成/
    );
    const document = sample();
    document.nodes.push({
      id: "img",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { kind: "image" },
    });
    document.edges.push(imageEdge("img", "generate-start"));
    expect(() => buildWorkflowRunPlan(document, "generate-start")).toThrow(
      /选择近期作品/
    );
  });
  it("上游没结果必须先手动运行，不自动启动依赖", () => {
    const document = sample();
    document.nodes.push(generate("upstream"));
    document.edges.push(imageEdge("upstream", "generate-start"));
    expect(() => buildWorkflowRunPlan(document, "generate-start")).toThrow(
      /先运行上游/
    );
    const upstream = document.nodes.at(-1);
    if (upstream?.data.kind !== "generate") throw new Error("缺少上游");
    upstream.data.result = image;
    upstream.data.attempt = {
      generationId,
      state: "completed",
      startedAt: "2026-10-25T01:00:00.000Z",
    };
    expect(buildWorkflowRunPlan(document, "generate-start").images).toEqual([
      image,
    ]);
    expect(() =>
      buildWorkflowRunPlan(document, "generate-start", new Set(["upstream"]))
    ).toThrow(/尚未完成/);
  });
  it("运行锁和刷新恢复后的未知任务都阻止重复提交，只有显式确认后可再运行", () => {
    const document = sample();
    expect(() =>
      buildWorkflowRunPlan(
        document,
        "generate-start",
        new Set(["generate-start"])
      )
    ).toThrow(/重复提交/);
    const node = document.nodes[1];
    if (node?.data.kind !== "generate") throw new Error("缺少生成节点");
    node.data.attempt = {
      generationId,
      state: "unconfirmed",
      startedAt: "2026-10-25T01:00:00.000Z",
    };
    const restored = loadWorkflowDocument(serializeWorkflowDocument(document));
    expect(() => buildWorkflowRunPlan(restored, "generate-start")).toThrow(
      /历史记录核对/
    );
    node.data.attempt.state = "acknowledged";
    expect(buildWorkflowRunPlan(document, "generate-start").nodeId).toBe(
      "generate-start"
    );
  });
});
