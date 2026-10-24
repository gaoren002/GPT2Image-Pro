/**
 * 升级预留状态机。由 UOL 和支付回调共用，通过事务 store 原子修改订单、批次与账本。
 * 不调用自带事务的积分核心服务；仅保存财务元数据，不接触生成内容或凭据。
 */
export type UpgradeSubscription = {
  id: string;
  userId: string;
  subscriptionId: string;
  priceId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};
export type ReservedBatch = {
  id: string;
  amount: number;
  issuedAt: string;
  expiresAt: string | null;
};
export type UpgradeQuote = {
  amountDue: number;
  originalAmount: number;
  prorationCredit: number;
  remainingDays: number;
  periodDays: number;
};
export type UpgradeSnapshot = {
  subscription: UpgradeSubscription;
  batches: ReservedBatch[];
  quote: UpgradeQuote;
  targetPriceId: string;
  targetCredits: number;
  yearly: boolean;
};
export type UpgradeState =
  | "held"
  | "settled"
  | "released"
  | "refund_pending"
  | "refunded";
export type UpgradeReservation = {
  outTradeNo: string;
  userId: string;
  clientRequestId: string;
  state: UpgradeState;
  snapshot: UpgradeSnapshot;
  expiresAt: Date;
  settledAt: Date | null;
  releaseReason: string | null;
  refundRef: string | null;
};
export type UpgradeOrder = {
  outTradeNo: string;
  userId: string;
  amount: number;
  status: string;
  metadata: Record<string, unknown>;
  paymentTradeNo: string | null;
  paidAmount: number | null;
};
export type UpgradePayment = {
  outTradeNo: string;
  tradeNo: string;
  money: string;
  verifyStatus: boolean;
  tradeStatus: string;
};
export interface UpgradeTransaction {
  getReservation(outTradeNo: string): Promise<UpgradeReservation | null>;
  getRequest(clientRequestId: string): Promise<UpgradeReservation | null>;
  getHeld(): Promise<UpgradeReservation | null>;
  linkRequest(
    clientRequestId: string,
    reservation: UpgradeReservation
  ): Promise<void>;
  getOrder(outTradeNo: string): Promise<UpgradeOrder | null>;
  saveOrder(order: UpgradeOrder): Promise<void>;
  saveReservation(reservation: UpgradeReservation): Promise<void>;
  getSubscription(): Promise<UpgradeSubscription | null>;
  saveSubscription(subscription: UpgradeSubscription): Promise<void>;
  takeBatches(now: Date): Promise<ReservedBatch[]>;
  restoreBatches(batches: ReservedBatch[], now: Date): Promise<number>;
  freezeGrant(reservation: UpgradeReservation, now: Date): Promise<void>;
  grant(
    reservation: UpgradeReservation,
    periodEnd: Date,
    now: Date
  ): Promise<void>;
  moveBalance(amount: number, earned?: boolean): Promise<void>;
  ledger(
    amount: number,
    type: "expiration" | "refund",
    debit: string,
    credit: string,
    sourceRef: string
  ): Promise<void>;
}
export interface UpgradeStore {
  findOrder(outTradeNo: string): Promise<UpgradeOrder | null>;
  transaction<T>(
    userId: string,
    run: (tx: UpgradeTransaction) => Promise<T>
  ): Promise<T>;
  expired(now: Date, limit: number): Promise<string[]>;
}
export type UpgradeQuoteCalculator = (
  current: UpgradeSubscription,
  remaining: number,
  now: Date
) => UpgradeQuote & { targetCredits: number; yearly: boolean };
export type UpgradeQuoteFactory = (
  targetPriceId: string
) => Promise<UpgradeQuoteCalculator>;

/** 金额/积分以两位小数归一化，禁止非有限及负值进入账本。 */
export function creditAmount(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("无效的财务数量");
  return Math.round(value * 100) / 100;
}
/** 将数据库 JSON 日期重新归一化，比较的是周期值而非对象引用。 */
function dateValue(value: Date | null): number | null {
  return value ? new Date(value).getTime() : null;
}
/** 仅同一订阅周期可兑现旧折抵，续费、其他支付或管理员变更都使旧预留失效。 */
function sameSubscription(
  a: UpgradeSubscription | null,
  b: UpgradeSubscription
): boolean {
  return Boolean(
    a &&
      a.id === b.id &&
      a.subscriptionId === b.subscriptionId &&
      a.priceId === b.priceId &&
      a.status === b.status &&
      dateValue(a.currentPeriodStart) === dateValue(b.currentPeriodStart) &&
      dateValue(a.currentPeriodEnd) === dateValue(b.currentPeriodEnd)
  );
}
/** 汇总已移出钱包的预留金额。 */
function heldAmount(reservation: UpgradeReservation): number {
  return creditAmount(
    reservation.snapshot.batches.reduce((sum, batch) => sum + batch.amount, 0)
  );
}
/** 服务工厂允许 DB-free 测试使用事务内存 store；生产使用 PostgreSQL store。 */
export function createUpgradeReservationService(
  store: UpgradeStore,
  quote: UpgradeQuoteFactory,
  clock: () => Date = () => new Date()
) {
  /** 释放只恢复原有效期内积分；已过期部分从预留账户转入过期账户。调用方必须在事务内。 */
  async function release(
    tx: UpgradeTransaction,
    reservation: UpgradeReservation,
    reason: string,
    now: Date
  ) {
    if (reservation.state !== "held") return;
    const restored = await tx.restoreBatches(reservation.snapshot.batches, now);
    await tx.moveBalance(restored);
    const hold = `RESERVATION:${reservation.outTradeNo}`;
    await tx.ledger(
      restored,
      "refund",
      hold,
      `WALLET:${reservation.userId}`,
      `upgrade:${reservation.outTradeNo}:release`
    );
    await tx.ledger(
      creditAmount(heldAmount(reservation) - restored),
      "expiration",
      hold,
      "SYSTEM:expired",
      `upgrade:${reservation.outTradeNo}:release-expired`
    );
    reservation.state = "released";
    reservation.releaseReason = reason;
    await tx.saveReservation(reservation);
    const order = await tx.getOrder(reservation.outTradeNo);
    if (!order) throw new Error("预留订单丢失");
    order.status = reason === "cancelled" ? "cancelled" : "expired";
    await tx.saveOrder(order);
  }
  return {
    /** 同一用户只允许一笔在途升级；相同套餐返回原订单，相同幂等键不得复活终态。 */
    async reserve(input: {
      userId: string;
      targetPriceId: string;
      clientRequestId: string;
    }) {
      // 费率配置可能在冷缓存时借用全局连接；必须在占用任何事务连接之前完成。
      const calculateQuote = await quote(input.targetPriceId);
      return store.transaction(input.userId, async (tx) => {
        const now = clock();
        const previous = await tx.getRequest(input.clientRequestId);
        if (previous) {
          if (previous.snapshot.targetPriceId !== input.targetPriceId)
            throw new Error("幂等键已用于其他套餐");
          if (previous.state !== "held" || previous.expiresAt <= now) {
            await release(tx, previous, "expired", now);
            return { reservation: previous, payable: false };
          }
          return { reservation: previous, payable: true };
        }
        const active = await tx.getHeld();
        if (active?.state === "refund_pending")
          throw new Error("请先完成正在进行的退款");
        if (active && active.expiresAt <= now)
          await release(tx, active, "expired", now);
        else if (active) {
          if (active.snapshot.targetPriceId !== input.targetPriceId)
            throw new Error("请先取消当前升级订单");
          await tx.linkRequest(input.clientRequestId, active);
          return { reservation: active, payable: true };
        }
        const current = await tx.getSubscription();
        if (
          !current ||
          !["active", "trialing", "canceled", "lifetime"].includes(
            current.status
          ) ||
          (current.status !== "lifetime" &&
            (!current.currentPeriodEnd || current.currentPeriodEnd <= now))
        ) {
          throw new Error("当前订阅不可升级");
        }
        // UPDATE 返回前的批次行已锁定；并发旧积分消费要么先完成、要么条件更新失败后重新选批。
        const batches = await tx.takeBatches(now);
        const remaining = creditAmount(
          batches
            .filter(
              (batch) =>
                (!current.currentPeriodStart ||
                  new Date(batch.issuedAt) >= current.currentPeriodStart) &&
                (!current.currentPeriodEnd ||
                  new Date(batch.issuedAt) < current.currentPeriodEnd)
            )
            .reduce((sum, batch) => sum + batch.amount, 0)
        );
        const pricing = calculateQuote(current, remaining, now);
        if (
          creditAmount(pricing.amountDue) <= 0 ||
          creditAmount(pricing.targetCredits) <= 0
        )
          throw new Error("无效的升级价格或积分");
        const reservation: UpgradeReservation = {
          outTradeNo: `SUB${crypto.randomUUID().replaceAll("-", "")}`,
          userId: input.userId,
          clientRequestId: input.clientRequestId,
          state: "held",
          snapshot: {
            subscription: current,
            batches,
            quote: pricing,
            targetPriceId: input.targetPriceId,
            targetCredits: creditAmount(pricing.targetCredits),
            yearly: pricing.yearly,
          },
          expiresAt: new Date(
            Math.min(
              now.getTime() + 15 * 60_000,
              current.currentPeriodEnd?.getTime() ?? Infinity
            )
          ),
          settledAt: null,
          releaseReason: null,
          refundRef: null,
        };
        await tx.moveBalance(-heldAmount(reservation));
        await tx.saveOrder({
          outTradeNo: reservation.outTradeNo,
          userId: input.userId,
          amount: pricing.amountDue,
          status: "pending",
          paymentTradeNo: null,
          paidAmount: null,
          metadata: {
            type: "subscription",
            userId: input.userId,
            outTradeNo: reservation.outTradeNo,
            priceId: input.targetPriceId,
            checkoutMode: "upgrade",
            expectedAmount: pricing.amountDue,
            originalAmount: pricing.originalAmount,
            prorationCredit: pricing.prorationCredit,
            remainingDays: pricing.remainingDays,
            periodDays: pricing.periodDays,
            upgradeFromPriceId: current.priceId,
          },
        });
        await tx.saveReservation(reservation);
        await tx.linkRequest(input.clientRequestId, reservation);
        await tx.ledger(
          heldAmount(reservation),
          "expiration",
          `WALLET:${input.userId}`,
          `RESERVATION:${reservation.outTradeNo}`,
          `upgrade:${reservation.outTradeNo}:hold`
        );
        return { reservation, payable: true };
      });
    },
    /** 校验已验签支付与本地订单；整笔履约同事务，已释放/旧周期/存量无预留订单只待退款。 */
    async settle(payment: UpgradePayment) {
      if (
        !payment.verifyStatus ||
        payment.tradeStatus !== "TRADE_SUCCESS" ||
        !payment.tradeNo.trim()
      )
        throw new Error("无效的支付确认");
      const found = await store.findOrder(payment.outTradeNo);
      if (!found) throw new Error("订单不存在");
      return store.transaction(found.userId, async (tx) => {
        const now = clock();
        const order = await tx.getOrder(payment.outTradeNo);
        if (order?.metadata.checkoutMode !== "upgrade")
          throw new Error("不是升级订单");
        if (!/^\d+(?:\.\d{1,2})?$/.test(payment.money))
          throw new Error("支付金额格式不正确");
        const paid = creditAmount(Number(payment.money));
        if (
          !payment.money.trim() ||
          paid < order.amount ||
          Math.round((paid - order.amount) * 100) > 10
        )
          throw new Error("支付金额不匹配");
        if (
          order.paymentTradeNo &&
          (order.paymentTradeNo !== payment.tradeNo ||
            order.paidAmount !== paid)
        )
          throw new Error("支付凭据冲突");
        const reservation = await tx.getReservation(payment.outTradeNo);
        if (!reservation && order.status === "success")
          return { state: order.status, metadata: order.metadata };
        if (order.paymentTradeNo)
          return { state: order.status, metadata: order.metadata };
        if (
          reservation?.state === "held" &&
          (reservation.expiresAt <= now ||
            !sameSubscription(
              await tx.getSubscription(),
              reservation.snapshot.subscription
            ))
        ) {
          await release(
            tx,
            reservation,
            reservation.expiresAt <= now ? "expired" : "subscription_changed",
            now
          );
        }
        order.paymentTradeNo = payment.tradeNo;
        order.paidAmount = paid;
        if (reservation?.state !== "held") {
          order.status = "refund_pending";
          if (reservation) {
            reservation.state = "refund_pending";
            await tx.saveReservation(reservation);
          }
        } else {
          const periodEnd = new Date(now);
          if (reservation.snapshot.yearly)
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
          else periodEnd.setMonth(periodEnd.getMonth() + 1);
          await tx.grant(reservation, periodEnd, now);
          await tx.saveSubscription({
            ...reservation.snapshot.subscription,
            subscriptionId: `epay_${reservation.outTradeNo}`,
            priceId: reservation.snapshot.targetPriceId,
            status: "canceled",
            cancelAtPeriodEnd: true,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          });
          await tx.ledger(
            heldAmount(reservation),
            "expiration",
            `RESERVATION:${reservation.outTradeNo}`,
            "SYSTEM:subscription_upgrade",
            `upgrade:${reservation.outTradeNo}:settle`
          );
          reservation.state = "settled";
          reservation.settledAt = now;
          await tx.saveReservation(reservation);
          order.status = "success";
        }
        await tx.saveOrder(order);
        return { state: order.status, metadata: order.metadata };
      });
    },
    /** 归属在事务内复核；已付款或其他终态不重复释放。 */
    async cancel(userId: string, outTradeNo: string) {
      return store.transaction(userId, async (tx) => {
        const reservation = await tx.getReservation(outTradeNo);
        if (!reservation || reservation.userId !== userId)
          throw new Error("订单不存在");
        await release(tx, reservation, "cancelled", clock());
        return { state: reservation.state };
      });
    },
    /** 有界扫描，逐用户短事务；不删除财务行，保留迟到支付、退款和重复请求的终态证据。 */
    async expire(limit = 100) {
      const orders = await store.expired(
        clock(),
        Math.max(1, Math.min(500, limit))
      );
      let released = 0;
      for (const outTradeNo of orders) {
        const order = await store.findOrder(outTradeNo);
        if (!order) continue;
        await store.transaction(order.userId, async (tx) => {
          const reservation = await tx.getReservation(outTradeNo);
          if (
            reservation?.state === "held" &&
            reservation.expiresAt <= clock()
          ) {
            await release(tx, reservation, "expired", clock());
            released++;
          }
        });
      }
      return { released };
    },
    /** 外部全退前冻结未使用的新权益；已消费/已变更订阅拒绝全退，防止先退款后发现无法收回。 */
    async prepareRefund(outTradeNo: string) {
      const order = await store.findOrder(outTradeNo);
      if (!order) throw new Error("订单不存在");
      return store.transaction(order.userId, async (tx) => {
        const currentOrder = await tx.getOrder(outTradeNo);
        const reservation = await tx.getReservation(outTradeNo);
        if (!currentOrder?.paymentTradeNo || currentOrder.paidAmount === null)
          throw new Error("订单尚未付款");
        if (reservation?.state === "settled") {
          const current = await tx.getSubscription();
          if (current?.subscriptionId !== `epay_${outTradeNo}`)
            throw new Error("订阅已变更，不能自动全退");
          if (await tx.getHeld()) throw new Error("请先取消正在进行的升级");
          await tx.freezeGrant(reservation, clock());
          await tx.moveBalance(-reservation.snapshot.targetCredits);
          await tx.ledger(
            reservation.snapshot.targetCredits,
            "expiration",
            `WALLET:${order.userId}`,
            `REFUND:${outTradeNo}`,
            `upgrade:${outTradeNo}:refund-hold`
          );
          // 待退款期间立即撤销套餐能力；退款完成前不能继续使用新套餐权限。
          await tx.saveSubscription({
            ...current,
            status: "unpaid",
            currentPeriodEnd: clock(),
          });
          reservation.state = "refund_pending";
          await tx.saveReservation(reservation);
          currentOrder.status = "refund_pending";
          await tx.saveOrder(currentOrder);
        } else if (
          currentOrder.status !== "refund_pending" &&
          currentOrder.status !== "refunded"
        ) {
          throw new Error("订单不可退款");
        }
        return { amount: currentOrder.paidAmount, state: currentOrder.status };
      });
    },
    /** 仅记录已完成的外部全退凭据，不发起网关退款；重复同凭据幂等，旧积分只恢复一次。 */
    async confirmRefund(outTradeNo: string, refundRef: string, amount: number) {
      if (!refundRef.trim()) throw new Error("退款凭据不能为空");
      const order = await store.findOrder(outTradeNo);
      if (!order) throw new Error("订单不存在");
      return store.transaction(order.userId, async (tx) => {
        const currentOrder = await tx.getOrder(outTradeNo);
        const reservation = await tx.getReservation(outTradeNo);
        if (!currentOrder || currentOrder.paidAmount !== creditAmount(amount))
          throw new Error("退款金额不匹配");
        if (reservation?.state === "refunded") {
          if (reservation.refundRef !== refundRef)
            throw new Error("退款凭据冲突");
          return { state: "refunded" };
        }
        if (currentOrder.status === "refunded" && !reservation) {
          if (currentOrder.metadata.upgradeRefundRef !== refundRef)
            throw new Error("退款凭据冲突");
          return { state: "refunded" };
        }
        if (currentOrder.status !== "refund_pending")
          throw new Error("请先冻结退款权益");
        if (reservation?.settledAt) {
          const current = await tx.getSubscription();
          if (current?.subscriptionId !== `epay_${outTradeNo}`)
            throw new Error("订阅已变更，需人工处理退款");
          const now = clock();
          const restored = await tx.restoreBatches(
            reservation.snapshot.batches,
            now
          );
          await tx.moveBalance(restored);
          await tx.ledger(
            restored,
            "refund",
            "SYSTEM:subscription_upgrade",
            `WALLET:${order.userId}`,
            `upgrade:${outTradeNo}:refund-restore`
          );
          await tx.ledger(
            reservation.snapshot.targetCredits,
            "expiration",
            `REFUND:${outTradeNo}`,
            "SYSTEM:subscription_refund",
            `upgrade:${outTradeNo}:refund-settle`
          );
          await tx.saveSubscription(reservation.snapshot.subscription);
        }
        if (reservation) {
          reservation.state = "refunded";
          reservation.refundRef = refundRef;
          await tx.saveReservation(reservation);
        } else {
          const prior = currentOrder.metadata.upgradeRefundRef;
          if (prior && prior !== refundRef) throw new Error("退款凭据冲突");
        }
        currentOrder.metadata.upgradeRefundRef = refundRef;
        currentOrder.status = "refunded";
        await tx.saveOrder(currentOrder);
        return { state: "refunded" };
      });
    },
  };
}
