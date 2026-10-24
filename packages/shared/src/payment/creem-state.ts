/** Creem 状态投影：已验签事件身份/订阅水位/投影同一短事务；不读配置，不调用 grant 事务。 */
import { createHash } from "node:crypto";
import { db } from "@repo/database";
import {
  creemSubscriptionState,
  creemWebhookEvent,
  subscription,
  user,
} from "@repo/database/schema";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { CreemSubscription, CreemWebhookEvent } from "./creem";
import { getCreemStateSnapshot, mergeCreemState } from "./creem-event";

/** 对 JSON 键排序，重投只改变字段顺序不会冲突；只落摘要，不保存用户 metadata。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 只在可信调用链（Creem webhook Principal）内使用；重复/旧状态仍返回归属供独立财务重放。 */
export async function projectCreemSubscription(
  event: CreemWebhookEvent,
  sub?: CreemSubscription,
  checkoutUserId?: string
) {
  const payloadHash = createHash("sha256")
    .update(canonicalJson(event))
    .digest("hex");
  return db.transaction(async (tx) => {
    // 所有实例共享短事务锁，既保护未建行的 tombstone，也保护重投身份检查；无网络/设置调用。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`creem:${sub?.id ?? event.id}`}, 0))`
    );
    await tx
      .insert(creemWebhookEvent)
      .values({
        eventId: event.id,
        eventCreatedAt: event.created_at,
        payloadHash,
      })
      .onConflictDoNothing();
    const [receipt] = await tx
      .select()
      .from(creemWebhookEvent)
      .where(eq(creemWebhookEvent.eventId, event.id))
      .limit(1);
    if (!receipt || receipt.payloadHash !== payloadHash)
      throw new Error("Creem event identity conflict");
    if (!sub) return { userId: checkoutUserId, projected: false };

    const [cursor] = await tx
      .select()
      .from(creemSubscriptionState)
      .where(eq(creemSubscriptionState.subscriptionId, sub.id))
      .limit(1);
    const [bound] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.subscriptionId, sub.id))
      .limit(1);
    const owners = [
      cursor?.userId,
      bound?.userId,
      sub.metadata?.userId,
      checkoutUserId,
    ].filter((id): id is string => typeof id === "string" && id.length > 0);
    const userId = owners[0];
    if (owners.some((id) => id !== userId))
      throw new Error("Creem subscription owner mismatch");

    let next = getCreemStateSnapshot(event, sub);
    let eventCreatedAt = event.created_at;
    let eventId = event.id;
    if (cursor) {
      if (cursor.eventCreatedAt > event.created_at) {
        next = cursor.snapshot;
        eventCreatedAt = cursor.eventCreatedAt;
        eventId = cursor.eventId;
      } else if (cursor.eventCreatedAt === event.created_at) {
        next = mergeCreemState(cursor.snapshot, next);
        // ID 只作稳定审计标识，不参与状态版本或权限裁决。
        eventId = cursor.eventId < event.id ? cursor.eventId : event.id;
      } else {
        // 不完整的状态同步可沿用已确认周期；从未确认周期时保持无权益状态。
        next.periodStart ??= cursor.snapshot.periodStart;
        next.periodEnd ??= cursor.snapshot.periodEnd;
      }
    } else if (bound && bound.creemEventCreatedAt === null) {
      // 旧行无 provider 水位：首次见到 active 不能直接解除既有暂停/欠费等限制。
      next = mergeCreemState(next, {
        status: bound.status,
        priceId: bound.priceId,
        periodStart:
          bound.currentPeriodStart?.toISOString() ?? next.periodStart,
        periodEnd: bound.currentPeriodEnd?.toISOString() ?? next.periodEnd,
        cancelAtPeriodEnd: bound.cancelAtPeriodEnd,
      });
    }
    await tx
      .insert(creemSubscriptionState)
      .values({
        subscriptionId: sub.id,
        userId,
        eventId,
        eventCreatedAt,
        snapshot: next,
      })
      .onConflictDoUpdate({
        target: creemSubscriptionState.subscriptionId,
        set: { userId, eventId, eventCreatedAt, snapshot: next },
        setWhere: lte(creemSubscriptionState.eventCreatedAt, eventCreatedAt),
      });
    if (!userId) return { userId, projected: false };

    // 复用现有 Epay/R08 的用户订阅锁，避免跨渠道并发改同一投影；不调用其流程或包住 grant。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(20261025, hashtext(${userId}))`
    );
    // 用户行锁序列化首次关联与同用户多订阅；锁内只做 SQL。
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!owner) throw new Error("Creem user not found");
    const [existing] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .orderBy(desc(subscription.updatedAt))
      .limit(1);
    if (
      existing &&
      existing.subscriptionId !== sub.id &&
      (existing.subscriptionId.startsWith("epay_") ||
        existing.creemEventCreatedAt === null ||
        existing.creemEventCreatedAt >= eventCreatedAt)
    ) {
      // 其他渠道或同毫秒跨订阅身份不明时不替换；不影响真实已付周期的幂等入账。
      return { userId, projected: false };
    }
    // 两条各自合法的周期也可能交集为空；保留快照/水位，但绝不能把空交集投影成有权益。
    const hasEmptyPeriod =
      next.periodStart !== null &&
      next.periodEnd !== null &&
      Date.parse(next.periodStart) >= Date.parse(next.periodEnd);
    const data = {
      subscriptionId: sub.id,
      priceId: next.priceId,
      // user-plan 只查到期日；无周期的激活或空交集须明确为 incomplete，不能授予权益。
      status:
        ["active", "trialing", "canceled"].includes(next.status) &&
        (hasEmptyPeriod || !next.periodEnd)
          ? "incomplete"
          : next.status,
      currentPeriodStart: next.periodStart ? new Date(next.periodStart) : null,
      currentPeriodEnd: next.periodEnd ? new Date(next.periodEnd) : null,
      cancelAtPeriodEnd: next.cancelAtPeriodEnd,
      creemEventCreatedAt: eventCreatedAt,
      updatedAt: new Date(),
    };
    const target = bound ?? existing;
    if (target) {
      if (
        target.creemEventCreatedAt === eventCreatedAt &&
        target.subscriptionId === sub.id &&
        target.status === data.status &&
        target.priceId === next.priceId &&
        target.cancelAtPeriodEnd === next.cancelAtPeriodEnd &&
        target.currentPeriodStart?.getTime() ===
          data.currentPeriodStart?.getTime() &&
        target.currentPeriodEnd?.getTime() === data.currentPeriodEnd?.getTime()
      )
        return { userId, projected: false };
      await tx
        .update(subscription)
        .set(data)
        .where(
          and(
            eq(subscription.id, target.id),
            or(
              isNull(subscription.creemEventCreatedAt),
              lte(subscription.creemEventCreatedAt, eventCreatedAt)
            )
          )
        );
    } else {
      await tx
        .insert(subscription)
        .values({ id: crypto.randomUUID(), userId, ...data });
    }
    return { userId, projected: true };
  });
}
