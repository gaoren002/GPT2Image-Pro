/** PostgreSQL 升级预留 store；每个入口仅创建一个事务，批次和余额修改不调用 credits/core。 */
import { db } from "@repo/database";
import {
  creditsBalance,
  creditsBatch,
  creditsTransaction,
  epayOrder,
  subscription,
  upgradeReservation,
  upgradeReservationBatch,
  upgradeReservationRequest,
} from "@repo/database/schema";
import { and, asc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  creditAmount,
  type ReservedBatch,
  type UpgradeOrder,
  type UpgradeReservation,
  type UpgradeSnapshot,
  type UpgradeStore,
  type UpgradeSubscription,
} from "./upgrade-reservation-service";

/** JSON 保留 ISO 日期；仅可信的本地财务快照在这里恢复日期类型。 */
function reservationFromRow(
  row: typeof upgradeReservation.$inferSelect
): UpgradeReservation {
  const snapshot = row.snapshot as unknown as UpgradeSnapshot;
  const prior = snapshot.subscription;
  return {
    ...row,
    state: row.state as UpgradeReservation["state"],
    snapshot: {
      ...snapshot,
      subscription: {
        ...prior,
        currentPeriodStart: prior.currentPeriodStart
          ? new Date(prior.currentPeriodStart)
          : null,
        currentPeriodEnd: prior.currentPeriodEnd
          ? new Date(prior.currentPeriodEnd)
          : null,
      },
    },
  };
}
/** 使用同一用户事务锁串行化预留、释放、支付和退款；跨用户互不阻塞。 */
export const upgradeStore: UpgradeStore = {
  async findOrder(outTradeNo) {
    const [row] = await db
      .select()
      .from(epayOrder)
      .where(eq(epayOrder.outTradeNo, outTradeNo))
      .limit(1);
    return row ?? null;
  },
  async expired(now, limit) {
    const rows = await db
      .select({ outTradeNo: upgradeReservation.outTradeNo })
      .from(upgradeReservation)
      .where(
        and(
          eq(upgradeReservation.state, "held"),
          lte(upgradeReservation.expiresAt, now)
        )
      )
      .orderBy(asc(upgradeReservation.expiresAt))
      .limit(limit);
    return rows.map((row) => row.outTradeNo);
  },
  async transaction(userId, run) {
    return db.transaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(20261025, hashtext(${userId}))`
        );
        /** 只按本人读取预留，防止用户级锁与归属不一致。 */
        async function reservationWhere(condition: ReturnType<typeof eq>) {
          const [row] = await tx
            .select()
            .from(upgradeReservation)
            .where(and(eq(upgradeReservation.userId, userId), condition))
            .limit(1)
            .for("update");
          return row ? reservationFromRow(row) : null;
        }
        return run({
          getReservation: (outTradeNo) =>
            reservationWhere(eq(upgradeReservation.outTradeNo, outTradeNo)),
          getRequest: (requestId) =>
            reservationWhere(sql`EXISTS (SELECT 1 FROM upgrade_reservation_request r
          WHERE r.user_id = ${userId} AND r.client_request_id = ${requestId} AND r.out_trade_no = ${upgradeReservation.outTradeNo})`),
          async linkRequest(clientRequestId, reservation) {
            await tx.insert(upgradeReservationRequest).values({
              userId,
              clientRequestId,
              outTradeNo: reservation.outTradeNo,
            });
          },
          getHeld: () =>
            reservationWhere(
              sql`(${upgradeReservation.state} = 'held' OR (${upgradeReservation.state} = 'refund_pending' AND ${upgradeReservation.settledAt} IS NOT NULL))`
            ),
          async getOrder(outTradeNo) {
            const [row] = await tx
              .select()
              .from(epayOrder)
              .where(
                and(
                  eq(epayOrder.userId, userId),
                  eq(epayOrder.outTradeNo, outTradeNo)
                )
              )
              .limit(1)
              .for("update");
            return row ?? null;
          },
          async saveOrder(order: UpgradeOrder) {
            if (order.userId !== userId) throw new Error("订单归属不匹配");
            await tx
              .insert(epayOrder)
              .values({ ...order, businessType: "subscription" })
              .onConflictDoUpdate({
                target: epayOrder.outTradeNo,
                set: {
                  status: order.status,
                  metadata: order.metadata,
                  paymentTradeNo: order.paymentTradeNo,
                  paidAmount: order.paidAmount,
                  updatedAt: new Date(),
                },
                setWhere: eq(epayOrder.userId, userId),
              });
          },
          async saveReservation(reservation) {
            if (reservation.userId !== userId)
              throw new Error("预留归属不匹配");
            const values = {
              ...reservation,
              snapshot: reservation.snapshot as unknown as Record<
                string,
                unknown
              >,
              updatedAt: new Date(),
            };
            await tx
              .insert(upgradeReservation)
              .values(values)
              .onConflictDoUpdate({
                target: upgradeReservation.outTradeNo,
                set: {
                  state: reservation.state,
                  settledAt: reservation.settledAt,
                  releaseReason: reservation.releaseReason,
                  refundRef: reservation.refundRef,
                  updatedAt: new Date(),
                },
              });
            for (const batch of reservation.snapshot.batches) {
              await tx
                .insert(upgradeReservationBatch)
                .values({
                  batchId: batch.id,
                  outTradeNo: reservation.outTradeNo,
                  amount: batch.amount,
                })
                .onConflictDoNothing();
            }
          },
          async getSubscription() {
            const rows = await tx
              .select()
              .from(subscription)
              .where(eq(subscription.userId, userId))
              .for("update");
            if (rows.length > 1) throw new Error("订阅记录不唯一，需人工核对");
            return rows[0] ?? null;
          },
          async saveSubscription(value: UpgradeSubscription) {
            const rows = await tx
              .update(subscription)
              .set({
                subscriptionId: value.subscriptionId,
                priceId: value.priceId,
                status: value.status,
                currentPeriodStart: value.currentPeriodStart,
                currentPeriodEnd: value.currentPeriodEnd,
                cancelAtPeriodEnd: value.cancelAtPeriodEnd,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(subscription.id, value.id),
                  eq(subscription.userId, userId)
                )
              )
              .returning({ id: subscription.id });
            if (rows.length !== 1) throw new Error("订阅记录丢失");
          },
          async takeBatches(now) {
            // 与普通消费保持到期顺序；行锁后使用实际剩余值，先发生的消费会减少折抵。
            const rows = await tx
              .select()
              .from(creditsBatch)
              .where(
                and(
                  eq(creditsBatch.userId, userId),
                  eq(creditsBatch.sourceType, "subscription"),
                  eq(creditsBatch.status, "active"),
                  gt(creditsBatch.remaining, 0),
                  or(
                    isNull(creditsBatch.expiresAt),
                    gt(creditsBatch.expiresAt, now)
                  )
                )
              )
              .orderBy(
                sql`${creditsBatch.expiresAt} IS NULL`,
                asc(creditsBatch.expiresAt),
                asc(creditsBatch.issuedAt),
                asc(creditsBatch.id)
              )
              .for("update");
            const batches: ReservedBatch[] = [];
            for (const row of rows) {
              await tx
                .update(creditsBatch)
                .set({ remaining: 0, status: "consumed", updatedAt: now })
                .where(eq(creditsBatch.id, row.id));
              batches.push({
                id: row.id,
                amount: row.remaining,
                issuedAt: row.issuedAt.toISOString(),
                expiresAt: row.expiresAt?.toISOString() ?? null,
              });
            }
            return batches;
          },
          async restoreBatches(batches, now) {
            let amount = 0;
            for (const batch of batches) {
              const valid = !batch.expiresAt || new Date(batch.expiresAt) > now;
              const [restored] = await tx
                .update(creditsBatch)
                .set({
                  remaining: valid ? batch.amount : 0,
                  status: valid ? "active" : "expired",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(creditsBatch.id, batch.id),
                    eq(creditsBatch.userId, userId),
                    eq(creditsBatch.status, "consumed"),
                    eq(creditsBatch.remaining, 0)
                  )
                )
                .returning({ id: creditsBatch.id });
              if (!restored) throw new Error("原积分批次已变更，释放失败");
              if (valid) amount = creditAmount(amount + batch.amount);
            }
            return amount;
          },
          async freezeGrant(reservation, now) {
            const [batch] = await tx
              .update(creditsBatch)
              .set({ remaining: 0, status: "consumed", updatedAt: now })
              .where(
                and(
                  eq(creditsBatch.userId, userId),
                  eq(creditsBatch.sourceType, "subscription"),
                  eq(
                    creditsBatch.sourceRef,
                    `epay_subscription:${reservation.outTradeNo}`
                  ),
                  eq(creditsBatch.status, "active"),
                  eq(creditsBatch.amount, reservation.snapshot.targetCredits),
                  eq(
                    creditsBatch.remaining,
                    reservation.snapshot.targetCredits
                  ),
                  gt(creditsBatch.expiresAt, now)
                )
              )
              .returning({ id: creditsBatch.id });
            if (!batch) throw new Error("新权益已使用或到期，不能自动全退");
          },
          async grant(reservation, periodEnd, now) {
            const batchId = crypto.randomUUID();
            const amount = reservation.snapshot.targetCredits;
            const sourceRef = `epay_subscription:${reservation.outTradeNo}`;
            // 不用 ON CONFLICT 忽略异常：若出现账本与预留状态不一致，整笔回滚供人工排查。
            await tx.insert(creditsBatch).values({
              id: batchId,
              userId,
              amount,
              remaining: amount,
              issuedAt: now,
              expiresAt: periodEnd,
              status: "active",
              sourceType: "subscription",
              sourceRef,
            });
            await tx.insert(creditsTransaction).values({
              id: crypto.randomUUID(),
              userId,
              type: "monthly_grant",
              amount,
              debitAccount: `SUBSCRIPTION:epay_${reservation.outTradeNo}`,
              creditAccount: `WALLET:${userId}`,
              sourceRef,
              description: "易支付升级订阅积分",
              metadata: {
                batchId,
                sourceRef,
                checkoutMode: "upgrade",
                outTradeNo: reservation.outTradeNo,
                priceId: reservation.snapshot.targetPriceId,
                periodStart: now.toISOString(),
                periodEnd: periodEnd.toISOString(),
              },
            });
            await tx
              .update(creditsBalance)
              .set({
                balance: sql`${creditsBalance.balance} + ${amount}`,
                totalEarned: sql`${creditsBalance.totalEarned} + ${amount}`,
                updatedAt: now,
              })
              .where(eq(creditsBalance.userId, userId));
          },
          async moveBalance(amount, earned = false) {
            const [row] = await tx
              .update(creditsBalance)
              .set({
                balance: sql`${creditsBalance.balance} + ${amount}`,
                ...(earned
                  ? {
                      totalEarned: sql`${creditsBalance.totalEarned} + ${amount}`,
                    }
                  : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(creditsBalance.userId, userId),
                  amount < 0 ? gte(creditsBalance.balance, -amount) : sql`true`,
                  amount < 0 ? eq(creditsBalance.status, "active") : sql`true`
                )
              )
              .returning({ userId: creditsBalance.userId });
            if (!row) throw new Error("积分账户冻结、余额不足或不存在");
          },
          async ledger(amount, type, debitAccount, creditAccount, sourceRef) {
            if (amount <= 0) return;
            await tx.insert(creditsTransaction).values({
              id: crypto.randomUUID(),
              userId,
              amount,
              type,
              debitAccount,
              creditAccount,
              sourceRef,
              description: "订阅升级预留结算",
              metadata: { reason: "subscription_upgrade_reservation" },
            });
          },
        });
      },
      { isolationLevel: "read committed" }
    );
  },
};
