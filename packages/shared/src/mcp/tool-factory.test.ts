import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { bindExecute, clearRegistry, defineOperation } from "../uol/registry";
import type { Principal } from "../uol/principal";
import type { AccessRequirement, OperationDefinition } from "../uol/types";
import { buildAdminMcpTools } from "./tool-factory";
import { buildUserMcpTools } from "./user-tool-factory";
import { MCP_ADMIN_PRINCIPAL_USER_ID } from "./admin-auth";

const apiKeyPrincipal = {
  type: "apiKey",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "pro",
  relayOnly: false,
} satisfies Principal;

const adminPrincipal = {
  type: "user",
  userId: "admin-1",
  role: "super_admin",
} satisfies Principal;

function registerOperation(
  overrides: Partial<OperationDefinition> & {
    name: string;
    access: AccessRequirement;
  }
) {
  return defineOperation({
    name: overrides.name,
    domain: overrides.domain ?? "image-generation",
    title: overrides.title ?? "Test Operation",
    description: overrides.description ?? "A test operation",
    input: overrides.input ?? z.object({}),
    output: overrides.output ?? z.object({ ok: z.boolean() }),
    access: overrides.access,
    readOnly: overrides.readOnly ?? false,
    destructive: overrides.destructive ?? false,
    idempotency: overrides.idempotency ?? { kind: "natural" },
    sideEffects: overrides.sideEffects ?? [],
    execute:
      overrides.execute ??
      (async () => {
        throw new Error(`Not yet wired: ${overrides.name}`);
      }),
  });
}

describe("MCP tool factories", () => {
  beforeEach(() => {
    clearRegistry();
    delete process.env.MCP_DENIED_OPS;
    delete process.env.MCP_READ_ONLY;
  });

  it("真实用户充值工具不对管理密钥的虚拟 actor 暴露", () => {
    registerOperation({
      name: "credits.adminGrant",
      domain: "credits",
      access: { kind: "admin" },
      execute: async () => ({ ok: true }),
    });
    expect(
      buildAdminMcpTools({
        ...adminPrincipal,
        userId: MCP_ADMIN_PRINCIPAL_USER_ID,
      })
    ).toEqual([]);
    expect(buildAdminMcpTools(adminPrincipal).map((tool) => tool.name)).toEqual(
      ["credits_adminGrant"]
    );
  });

  it("hides user tools until their UOL operation is bound", () => {
    registerOperation({
      name: "image.generate",
      access: { kind: "protected" },
    });

    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);

    bindExecute("image.generate", async () => ({ ok: true }));

    expect(buildUserMcpTools(apiKeyPrincipal).map((tool) => tool.name)).toEqual(
      ["image.generate"]
    );
  });

  it("hides admin tools until their UOL operation is bound", () => {
    registerOperation({
      name: "pool.getAdminPool",
      domain: "image-backend-pool",
      access: { kind: "imageBackendPoolViewer" },
      readOnly: true,
    });

    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);

    bindExecute("pool.getAdminPool", async () => ({ ok: true }));

    expect(buildAdminMcpTools(adminPrincipal).map((tool) => tool.name)).toEqual(
      ["pool_getAdminPool"]
    );
  });
});

describe("MCP的Zod4输入契约", () => {
  beforeEach(() => clearRegistry());

  const input = z.object({
    prompt: z.string().min(1).max(8000).describe("用户提示词"),
    count: z.number().int().min(1).max(10).optional(),
    relayOnly: z.boolean().default(false),
    quality: z.enum(["low", "high"]).optional(),
    images: z.array(z.string().url()).max(3).optional(),
    extra: z.object({ seed: z.number().int() }).optional(),
  });

  it.each(["user", "admin"])("%s工具保留字段类型、约束与可选语义", (kind) => {
    const name = kind === "user" ? "image.generate" : "pool.updateApi";
    registerOperation({
      name,
      domain: kind === "user" ? "image-generation" : "image-backend-pool",
      input,
      access: { kind: kind === "user" ? "protected" : "admin" },
    });
    bindExecute(name, async () => ({ ok: true }));
    const tools =
      kind === "user"
        ? buildUserMcpTools(apiKeyPrincipal)
        : buildAdminMcpTools(adminPrincipal);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description: "用户提示词",
        },
        count: { type: "integer", minimum: 1, maximum: 10 },
        relayOnly: { type: "boolean", default: false },
        quality: { type: "string", enum: ["low", "high"] },
        images: {
          type: "array",
          maxItems: 3,
          items: { type: "string", format: "uri" },
        },
        extra: {
          type: "object",
          required: ["seed"],
          properties: { seed: { type: "integer" } },
        },
      },
    });
  });
});

it("真实image.generate契约隐藏路由注入userId，并要求generationId", async () => {
  clearRegistry();
  await import("../uol/operations/image-generation");
  bindExecute("image.generate", async (input: unknown) => input);
  const tool = buildUserMcpTools(apiKeyPrincipal).find(
    (candidate) => candidate.name === "image.generate"
  );
  expect(tool?.inputSchema.properties).not.toHaveProperty("userId");
  expect(tool?.inputSchema.required).toEqual(
    expect.arrayContaining(["prompt", "generationId"])
  );
  expect(tool?.inputSchema.required).not.toContain("userId");
});
