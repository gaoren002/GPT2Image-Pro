/** 管理员充值事务服务；供 UOL 调用，复核操作者/目标权限并原子写入资金及审计。 */
import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import {
  adminAuditLog,
  creditsBalance,
  creditsBatch,
  creditsTransaction,
  user,
} from "@repo/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { canActOnTargetRole } from "../../auth/roles";
import { getRuntimeSettingBoolean } from "../../system-settings";
import { OperationError } from "../../uol/errors";
import { MCP_ADMIN_PRINCIPAL_USER_ID } from "../../mcp/admin-auth";
import { isPrincipalAdmin, type Principal } from "../../uol/principal";
import type {
  AdminCreditGrantInput,
  AdminCreditGrantResult,
} from "../../uol/operations/credits-admin-grant";

/**
 * 接收 UOL 已校验的充值参数及可信 principal，返回本次入账量和账本 ID。
 * 服务复核管理员、目标角色和自充值开关；资金/审计任一写入失败即整笔回滚。
 * actor 只取 principal，拒绝 observer/系统等身份直接绕过网关。
 */
export async function grantAdminCredits(
  data: AdminCreditGrantInput,
  principal: Principal
): Promise<AdminCreditGrantResult> {
  if (
    principal.type !== "user" ||
    !isPrincipalAdmin(principal) ||
    !principal.userId ||
    principal.userId === MCP_ADMIN_PRINCIPAL_USER_ID
  ) {
    throw new OperationError("forbidden", "此操作需要真实管理员用户身份");
  }
  const [targetUser] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, data.userId))
    .limit(1);
  if (!targetUser) throw new OperationError("not_found", "用户不存在");
  // 超管保留自充值豁免；普通管理员先查自充值开关，随后仍受目标角色护栏约束。
  if (data.userId === principal.userId && principal.role !== "super_admin") {
    // WHY: fallback 与 defaultValue 一致(true),存量库未初始化该设置时也放行,
    // 与"默认允许、站长可关"的产品语义对齐。
    const selfGrantAllowed = await getRuntimeSettingBoolean(
      "ADMIN_SELF_CREDITS_GRANT_ENABLED",
      true
    );
    if (!selfGrantAllowed) {
      throw new OperationError(
        "forbidden",
        "不能为自己发放积分;如需允许,请在系统设置中开启「管理员给自己充值」"
      );
    }
  }
  // 目标权限护栏：普通 admin 不得向管理员及超管账户发放积分。
  if (!canActOnTargetRole(principal.role, targetUser.role)) {
    throw new OperationError(
      "forbidden",
      "无权对该账户执行积分发放：目标权限不低于操作者"
    );
  }

  // 键只按操作者和意图分桶，不能包含目标或金额，否则改参数会绕过重放核对。
  const sourceRef = `admin_grant:${principal.userId}:${data.requestId}`;
  return db.transaction(
    async (tx) => {
      // 等锁后必须读到前一请求的提交。所有资金和审计共用 tx，不能嵌套
      // 自带事务的 grantCredits，也不能在持有连接时再经全局 db 借连接。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${sourceRef}, 0))`
      );
      const [existingBatch] = await tx
        .select()
        .from(creditsBatch)
        .where(
          and(
            eq(creditsBatch.sourceType, "bonus"),
            eq(creditsBatch.sourceRef, sourceRef)
          )
        )
        .limit(1);
      const [existingTransaction] = await tx
        .select()
        .from(creditsTransaction)
        .where(
          and(
            eq(creditsTransaction.type, "admin_grant"),
            eq(creditsTransaction.sourceRef, sourceRef)
          )
        )
        .limit(1);

      if (existingBatch || existingTransaction) {
        if (
          !existingBatch ||
          !existingTransaction ||
          existingBatch.userId !== data.userId ||
          existingBatch.amount !== data.amount ||
          existingBatch.expiresAt != null ||
          existingTransaction.userId !== data.userId ||
          existingTransaction.amount !== data.amount ||
          existingTransaction.debitAccount !== `ADMIN:${principal.userId}` ||
          existingTransaction.metadata?.adminUserId !== principal.userId ||
          existingTransaction.metadata?.reason !== data.reason ||
          existingTransaction.metadata?.batchId !== existingBatch.id
        ) {
          throw new OperationError(
            "idempotency_conflict",
            "请求标识已用于不同的充值参数，请核对后重新操作"
          );
        }
        const [balance] = await tx
          .select()
          .from(creditsBalance)
          .where(eq(creditsBalance.userId, data.userId))
          .limit(1);
        return {
          batchId: existingBatch.id,
          transactionId: existingTransaction.id,
          amount: 0,
          newBalance: balance?.balance ?? 0,
          alreadyGranted: true,
        };
      }

      // 新用户钱包惰性创建；锁定钱包后检查冻结状态，避免冻结与充值交错。
      await tx
        .insert(creditsBalance)
        .values({
          id: randomUUID(),
          userId: data.userId,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          status: "active",
        })
        .onConflictDoNothing({ target: creditsBalance.userId });
      const [balance] = await tx
        .select()
        .from(creditsBalance)
        .where(eq(creditsBalance.userId, data.userId))
        .limit(1)
        .for("update");
      if (!balance) throw new Error("创建积分账户失败");
      if (balance.status === "frozen") {
        throw new OperationError("account_frozen", "用户的积分账户已被冻结");
      }

      const batchId = randomUUID();
      const transactionId = randomUUID();
      const now = new Date();
      // 唯一约束仍是资金兜底；冲突时整笔回滚，不继续更新钱包或写审计。
      const inserted = await tx
        .insert(creditsBatch)
        .values({
          id: batchId,
          userId: data.userId,
          amount: data.amount,
          remaining: data.amount,
          issuedAt: now,
          expiresAt: null,
          status: "active",
          sourceType: "bonus",
          sourceRef,
        })
        .onConflictDoNothing({
          target: [creditsBatch.sourceType, creditsBatch.sourceRef],
          where: sql`${creditsBatch.sourceRef} is not null`,
        })
        .returning({ id: creditsBatch.id });
      if (inserted.length === 0) {
        throw new OperationError(
          "idempotency_conflict",
          "充值请求状态已变化，请使用原请求重试"
        );
      }
      await tx.insert(creditsTransaction).values({
        id: transactionId,
        userId: data.userId,
        type: "admin_grant",
        amount: data.amount,
        debitAccount: `ADMIN:${principal.userId}`,
        creditAccount: `WALLET:${data.userId}`,
        sourceRef,
        description: `管理员手动充值: ${data.reason}`,
        metadata: {
          adminUserId: principal.userId,
          requestId: data.requestId,
          reason: data.reason,
          batchId,
          sourceRef,
        },
      });
      const [updatedBalance] = await tx
        .update(creditsBalance)
        .set({
          balance: sql`${creditsBalance.balance} + ${data.amount}`,
          totalEarned: sql`${creditsBalance.totalEarned} + ${data.amount}`,
          updatedAt: now,
        })
        .where(eq(creditsBalance.userId, data.userId))
        .returning({ balance: creditsBalance.balance });
      if (!updatedBalance) throw new Error("更新积分余额失败");
      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        adminUserId: principal.userId,
        targetUserId: data.userId,
        action: "credits.grant",
        reason: data.reason,
        after: {
          amount: data.amount,
          batchId,
          transactionId,
          expiresAt: null,
        },
        metadata: { requestId: data.requestId, sourceRef },
      });
      return {
        batchId,
        transactionId,
        amount: data.amount,
        newBalance: updatedBalance.balance,
        alreadyGranted: false,
      };
    },
    { isolationLevel: "read committed" }
  );
}
