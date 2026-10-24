/** R24 UI 接线回归：转译真实组件的事件处理器，替换表单状态和网络边界，不复制处理器实现。 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createAdminGrantIntent } from "./admin-grant-intent";

type Request = {
  userId: string;
  amount: number;
  reason: string;
  requestId: string;
};
type Response = { data?: { message: string }; serverError?: string };
type Handlers = {
  openGrantDialog: (target: { id: string }) => void;
  handleGrant: () => Promise<void>;
  changeAmount: (event: { target: { value: string } }) => void;
  changeReason: (event: { target: { value: string } }) => void;
};

/** 从真实 TSX AST 提取充值闭包和输入事件；仅擦除类型，保留原执行顺序与失败处理。 */
function ui() {
  const path =
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: 仅供直接运行 Vitest 对照旧源码，不经过 Turbo 缓存。
    process.env.ADMIN_GRANT_UI_BASELINE ??
    new URL("./admin-users-management.tsx", import.meta.url);
  const source = ts.createSourceFile(
    "ui.tsx",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const functions: string[] = [];
  const changes: Record<string, string> = {};
  /** 只选择实际绑定的充值输入，避免误测与组件无关的测试替身。 */
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ["handleGrant", "openGrantDialog"].includes(node.name.getText(source))
    ) {
      functions.push(`const ${node.getText(source)};`);
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const id = attributes.find(
        (attribute) => attribute.name.getText(source) === "id"
      )?.initializer;
      if (
        id &&
        ts.isStringLiteral(id) &&
        ["grantAmount", "grantReason"].includes(id.text)
      ) {
        const handler = attributes.find(
          (attribute) => attribute.name.getText(source) === "onChange"
        )?.initializer;
        if (handler && ts.isJsxExpression(handler) && handler.expression)
          changes[id.text] = handler.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(functions).toHaveLength(2);
  expect(Object.keys(changes)).toHaveLength(2);
  const action = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue({ data: { message: "成功" } });
  const intent = createAdminGrantIntent();
  const env = {
    selectedUser: null as { id: string } | null,
    grantAmount: "",
    grantReason: "",
    isGranting: false,
    grantOpen: false,
    grantIntent: { current: intent },
    adminGrantCreditsAction: action,
    toast: { success: vi.fn(), error: vi.fn() },
    reloadCurrent: vi.fn().mockResolvedValue(undefined),
    setSelectedUser: (value: { id: string }) => {
      env.selectedUser = value;
    },
    setGrantAmount: (value: string) => {
      env.grantAmount = value;
    },
    setGrantReason: (value: string) => {
      env.grantReason = value;
    },
    setIsGranting: (value: boolean) => {
      env.isGranting = value;
    },
    setGrantOpen: (value: boolean) => {
      env.grantOpen = value;
    },
    handlers: undefined as Handlers | undefined,
  };
  const code = `${functions.join("\n")}\nglobalThis.handlers = { openGrantDialog, handleGrant, changeAmount: ${changes.grantAmount}, changeReason: ${changes.grantReason} };`;
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    env
  );
  const handlers = env.handlers;
  if (!handlers) throw new Error("未找到真实 UI 处理器");
  const boundHandlers: Handlers = handlers;
  /** 通过真实打开及输入处理器填写表单。 */
  function fill(userId = "u1") {
    boundHandlers.openGrantDialog({ id: userId });
    boundHandlers.changeAmount({ target: { value: "20" } });
    boundHandlers.changeReason({ target: { value: "客服补偿" } });
  }
  return { handlers, fill, action, env };
}

describe("真实充值 UI 事件接线", () => {
  it("同步双击只发出一个请求；网络失败重试沿用 UUID", async () => {
    const form = ui();
    form.fill();
    form.action.mockRejectedValueOnce(new Error("network lost"));
    await Promise.all([
      form.handlers.handleGrant(),
      form.handlers.handleGrant(),
    ]);
    expect(form.action).toHaveBeenCalledTimes(1);
    const first = form.action.mock.calls[0]?.[0];
    expect(first?.requestId).toMatch(/^[a-f0-9-]{36}$/);
    await form.handlers.handleGrant();
    expect(form.action.mock.calls[1]?.[0]).toEqual(first);
  });
  it("服务端错误保留键，成功后的下一次充值换键", async () => {
    const form = ui();
    form.fill();
    form.action.mockResolvedValueOnce({ serverError: "稍后重试" });
    await form.handlers.handleGrant();
    await form.handlers.handleGrant();
    const first = form.action.mock.calls[0]?.[0];
    expect(form.action.mock.calls[1]?.[0]).toEqual(first);
    form.fill();
    await form.handlers.handleGrant();
    expect(form.action.mock.calls[2]?.[0].requestId).not.toBe(first?.requestId);
  });
  it("金额或原因编辑后再改回原值，仍不能沿用失败请求的键", async () => {
    const form = ui();
    form.fill();
    form.action.mockResolvedValue({ serverError: "稍后重试" });
    await form.handlers.handleGrant();
    form.handlers.changeAmount({ target: { value: "21" } });
    form.handlers.changeAmount({ target: { value: "20" } });
    await form.handlers.handleGrant();
    form.handlers.changeReason({ target: { value: "活动奖励" } });
    form.handlers.changeReason({ target: { value: "客服补偿" } });
    await form.handlers.handleGrant();
    expect(
      new Set(form.action.mock.calls.map(([request]) => request.requestId)).size
    ).toBe(3);
  });
  it("新目标获得新键；在途不能打开另一个目标或编辑金额", async () => {
    const form = ui();
    form.fill();
    let finish = (_value: Response) => {};
    form.action.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    const pending = form.handlers.handleGrant();
    form.fill("u2");
    expect(form.env.selectedUser?.id).toBe("u1");
    finish({ serverError: "稍后重试" });
    await pending;
    form.fill("u2");
    await form.handlers.handleGrant();
    expect(form.action.mock.calls[1]?.[0].userId).toBe("u2");
    expect(form.action.mock.calls[1]?.[0].requestId).not.toBe(
      form.action.mock.calls[0]?.[0].requestId
    );
  });
});
