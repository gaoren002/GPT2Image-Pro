/** MCP 工具输入契约：使用 Zod4 原生转换，并同步网关幂等要求和传输层注入字段。 */
import { z } from "zod";
import type { OperationDefinition } from "../uol/types";

/**
 * 只描述调用者应提交的字段；例如用户MCP的userId由鉴权路由强制注入，不能要求模型填写。
 * 网关会校验 required 幂等键，即便原Zod字段标为optional，也应在工具描述里明确必填。
 */
export function buildMcpInputSchema(
  operation: OperationDefinition,
  injectedFields: readonly string[] = []
): Record<string, unknown> {
  const schema = z.toJSONSchema(operation.input, { io: "input" });
  if (schema.type !== "object" || !schema.properties) {
    throw new Error(
      `MCP operation ${operation.name} requires an object input schema`
    );
  }
  const properties = { ...schema.properties };
  for (const field of injectedFields) delete properties[field];
  const required = new Set(
    (schema.required || []).filter((field) => !injectedFields.includes(field))
  );
  if (operation.idempotency.kind === "required") {
    const key = operation.idempotency.keyField;
    if (!injectedFields.includes(key)) {
      if (!(key in properties))
        throw new Error(
          `MCP operation ${operation.name} has no idempotency input ${key}`
        );
      required.add(key);
    }
  }
  return {
    ...schema,
    properties,
    ...(required.size > 0 ? { required: [...required] } : { required: [] }),
  };
}
