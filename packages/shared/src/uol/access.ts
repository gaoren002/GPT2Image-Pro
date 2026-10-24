/**
 * UOL Access Control - 声明式权限断言
 *
 * 职责：根据操作的 AccessRequirement 与调用者 Principal，
 * 在 invoke 网关单点执行鉴权，拒绝不满足条件的调用。
 *
 * 使用方：invoke.ts 在 execute 前调用 assertAccess
 * 关键依赖：types.ts（AccessRequirement）、principal.ts（Principal）、errors.ts
 *
 * 设计决策：
 * - system Principal 始终放行（系统内部调用不受限制）
 * - owner 类操作此处仅验证调用者具有身份（userId），
 *   实际归属校验延迟到 execute 内通过 ctx.assertOwnership 执行
 *   （因为此处尚无资源信息）
 */
import type { AccessRequirement, OperationDefinition } from "./types";
import type { Principal } from "./principal";
import { OperationError } from "./errors";

/**
 * 断言调用者 Principal 满足操作的 AccessRequirement。
 * 不满足时抛出 OperationError（forbidden / unauthenticated）。
 *
 * @param access - 操作声明的权限要求
 * @param principal - 当前调用者身份
 * @param operation - 操作的只读声明；观察员缺少声明时拒绝，防止绕过网关后默认放行
 * @throws OperationError 权限不足时
 */
export function assertAccess(
  access: AccessRequirement,
  principal: Principal,
  operation?: Pick<
    OperationDefinition,
    "readOnly" | "destructive" | "hasMaintenanceWrite"
  >,
): void {
  // 只读角色的约束先于访问级别检查，防止 public/protected/viewer 写操作绕过。
  // readOnly 与维护性写入/破坏性标记冲突时失败关闭；只读也不授予超管等更高访问级别。
  if (
    principal.type === "user" &&
    principal.role === "observer_admin" &&
    (operation?.readOnly !== true ||
      operation.destructive !== false ||
      operation.hasMaintenanceWrite === true)
  ) {
    throw new OperationError(
      "forbidden",
      "Observer admin access is read-only",
    );
  }

  switch (access.kind) {
    case "public":
      // 无需身份验证
      return;

    case "protected":
      // 需要用户身份（user 或 apiKey），system 也可通过
      if (principal.type === "system") return;
      if (
        principal.type === "cron" ||
        principal.type === "webhook" ||
        principal.type === "proxy"
      ) {
        throw new OperationError(
          "forbidden",
          "This operation requires user authentication",
        );
      }
      return;

    case "admin":
      if (principal.type === "system") return;
      if (principal.type !== "user") {
        throw new OperationError(
          "forbidden",
          "Admin access required",
        );
      }
      if (
        principal.role !== "admin" &&
        principal.role !== "super_admin" &&
        principal.role !== "observer_admin"
      ) {
        throw new OperationError(
          "forbidden",
          "Admin access required",
        );
      }
      return;

    case "superAdmin":
      if (principal.type === "system") return;
      if (
        principal.type !== "user" ||
        principal.role !== "super_admin"
      ) {
        throw new OperationError(
          "forbidden",
          "Super admin access required",
        );
      }
      return;

    case "imageBackendPoolViewer":
      if (principal.type === "system") return;
      if (principal.type !== "user") {
        throw new OperationError(
          "forbidden",
          "Admin access required",
        );
      }
      // observer_admin, admin, super_admin 均可查看
      if (
        !["observer_admin", "admin", "super_admin"].includes(
          principal.role,
        )
      ) {
        throw new OperationError(
          "forbidden",
          "Image backend pool viewer access required",
        );
      }
      return;

    case "apiKey":
      if (principal.type === "system") return;
      if (principal.type !== "apiKey") {
        throw new OperationError(
          "unauthenticated",
          "API key authentication required",
        );
      }
      return;

    case "cron":
      if (principal.type === "system") return;
      if (principal.type !== "cron") {
        throw new OperationError(
          "forbidden",
          "Cron authentication required",
        );
      }
      return;

    case "webhook":
      if (principal.type === "system") return;
      if (
        principal.type !== "webhook" ||
        principal.provider !== access.provider
      ) {
        throw new OperationError(
          "forbidden",
          `Webhook authentication required (provider: ${access.provider})`,
        );
      }
      return;

    case "proxySecret":
      if (principal.type === "system") return;
      if (principal.type !== "proxy") {
        throw new OperationError(
          "forbidden",
          "Proxy secret authentication required",
        );
      }
      return;

    case "owner":
      // owner 归属校验延迟到 execute 内由 ctx.assertOwnership 执行，
      // 此处仅确保调用者拥有可追溯的用户身份
      if (principal.type === "system") return;
      if (
        principal.type === "cron" ||
        principal.type === "webhook" ||
        principal.type === "proxy"
      ) {
        throw new OperationError(
          "forbidden",
          "Owner-scoped operations require user identity",
        );
      }
      return;

    case "system":
      if (principal.type !== "system") {
        throw new OperationError(
          "forbidden",
          "System-only operation, not accessible via external transport",
        );
      }
      return;
  }
}
