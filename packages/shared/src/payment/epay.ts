/**
 * Epay client helpers.
 *
 * Compatible with common 易支付 submit.php integrations. The signing rules
 * mirror new-api's go-epay usage: filter empty values plus sign/sign_type,
 * sort keys, join as query string, append merchant key, then MD5.
 */

import crypto from "node:crypto";
import { db } from "@repo/database";
import { epayOrder } from "@repo/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getBaseUrl } from "../config/payment";
import {
  getRuntimeSettingSelect,
  getRuntimeSettingString,
} from "../system-settings";

export const EPAY_TRADE_SUCCESS = "TRADE_SUCCESS";

export type PaymentProvider = "creem" | "epay";
export type EpayBusinessType = "subscription" | "credit_purchase";
export type EpaySubscriptionCheckoutMode =
  | "new_subscription"
  | "upgrade"
  | "renewal";

export interface EpayMetadata {
  type: EpayBusinessType;
  userId: string;
  outTradeNo: string;
  priceId?: string;
  planId?: string;
  packageId?: string;
  quantity?: number;
  creditPlan?: string;
  checkoutMode?: EpaySubscriptionCheckoutMode;
  expectedAmount?: number;
  originalAmount?: number;
  prorationCredit?: number;
  remainingDays?: number;
  periodDays?: number;
  upgradeFromPriceId?: string;
}

export interface EpayPurchaseInput {
  outTradeNo: string;
  name: string;
  money: number | string;
  type?: string;
  notifyUrl?: string;
  returnUrl?: string;
  param?: string;
}

export interface EpayPurchaseResult {
  url: string;
  params: Record<string, string>;
}

export interface EpayVerifyResult {
  verifyStatus: boolean;
  type: string;
  tradeNo: string;
  outTradeNo: string;
  name: string;
  money: string;
  tradeStatus: string;
  param?: string;
  raw: Record<string, string>;
}

export type EpayOrderStatus =
  | "pending"
  | "success"
  | "failed"
  | "cancelled"
  | "expired"
  | "refund_pending"
  | "refunded";

export function getPaymentProvider(): PaymentProvider {
  const providerValues = [
    process.env.PAYMENT_PROVIDER,
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER,
  ];

  return providerValues.some(
    (provider) => provider?.trim().toLowerCase() === "epay"
  )
    ? "epay"
    : "creem";
}

export function isEpayPaymentProvider(): boolean {
  return getPaymentProvider() === "epay";
}

export async function getRuntimePaymentProvider(): Promise<PaymentProvider> {
  return getRuntimeSettingSelect(
    "PAYMENT_PROVIDER",
    ["creem", "epay"] as const,
    getPaymentProvider()
  );
}

export async function isRuntimeEpayPaymentProvider(): Promise<boolean> {
  return (await getRuntimePaymentProvider()) === "epay";
}

export function getEpayDefaultPaymentType(): string {
  return (
    process.env.EPAY_DEFAULT_PAYMENT_TYPE ??
    process.env.NEXT_PUBLIC_EPAY_DEFAULT_PAYMENT_TYPE ??
    "alipay"
  ).trim();
}

function getEpayNotifyUrl(): string | undefined {
  const notifyUrl = process.env.EPAY_NOTIFY_URL?.trim();
  return notifyUrl || undefined;
}

function getEpayReturnUrl(baseUrl: string): string {
  return `${baseUrl}/api/payments/epay/return`;
}

function getEpayConfig() {
  const pid = process.env.EPAY_PID?.trim() ?? "";
  const key = process.env.EPAY_KEY?.trim() ?? "";
  const apiUrl = process.env.EPAY_API_URL?.trim() ?? "";

  if (!pid || !key || !apiUrl) {
    throw new Error("EPAY_PID, EPAY_KEY and EPAY_API_URL must be configured");
  }

  return { pid, key, apiUrl };
}

function getEpaySubmitUrl(apiUrl: string): URL {
  const submitUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  submitUrl.pathname = `${submitUrl.pathname.replace(/\/+$/, "")}/submit.php`;
  return submitUrl;
}

async function getRuntimeEpayConfig() {
  const pid = (await getRuntimeSettingString("EPAY_PID")) ?? "";
  const key = (await getRuntimeSettingString("EPAY_KEY")) ?? "";
  const apiUrl = (await getRuntimeSettingString("EPAY_API_URL")) ?? "";

  if (!pid || !key || !apiUrl) {
    throw new Error("EPAY_PID, EPAY_KEY and EPAY_API_URL must be configured");
  }

  return { pid, key, apiUrl };
}

export function isEpayConfigured(): boolean {
  return Boolean(
    process.env.EPAY_PID?.trim() &&
      process.env.EPAY_KEY?.trim() &&
      process.env.EPAY_API_URL?.trim()
  );
}

export async function isRuntimeEpayConfigured(): Promise<boolean> {
  return Boolean(
    (await getRuntimeSettingString("EPAY_PID")) &&
      (await getRuntimeSettingString("EPAY_KEY")) &&
      (await getRuntimeSettingString("EPAY_API_URL"))
  );
}

function formatMoney(money: number | string): string {
  if (typeof money === "number") {
    return money.toFixed(2);
  }
  return money;
}

function filterParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => key !== "sign" && key !== "sign_type" && value !== ""
    )
  );
}

function buildSignPayload(params: Record<string, string>): string {
  const filtered = filterParams(params);
  return Object.keys(filtered)
    .sort()
    .map((key) => `${key}=${filtered[key]}`)
    .join("&");
}

export function signEpayParams(
  params: Record<string, string>,
  key?: string
): string {
  const merchantKey = key ?? getEpayConfig().key;
  return crypto
    .createHash("md5")
    .update(buildSignPayload(params) + merchantKey)
    .digest("hex");
}

export async function signRuntimeEpayParams(
  params: Record<string, string>
): Promise<string> {
  const { key } = await getRuntimeEpayConfig();
  return crypto
    .createHash("md5")
    .update(buildSignPayload(params) + key)
    .digest("hex");
}

export function withEpaySignature(
  params: Record<string, string>
): Record<string, string> {
  return {
    ...params,
    sign: signEpayParams(params),
    sign_type: "MD5",
  };
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createEpayPurchase(
  input: EpayPurchaseInput
): EpayPurchaseResult {
  const { pid, apiUrl } = getEpayConfig();
  const baseUrl = getBaseUrl();
  const notifyUrl = input.notifyUrl ?? getEpayNotifyUrl();
  const params: Record<string, string> = {
    pid,
    type: input.type || getEpayDefaultPaymentType(),
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl ?? `${baseUrl}/api/webhooks/epay`,
    return_url: input.returnUrl ?? getEpayReturnUrl(baseUrl),
    name: input.name,
    money: formatMoney(input.money),
    device: "pc",
    sign_type: "MD5",
  };

  const signedParams = withEpaySignature(params);
  const submitUrl = getEpaySubmitUrl(apiUrl);

  return {
    url: submitUrl.toString(),
    params: signedParams,
  };
}

export async function createRuntimeEpayPurchase(
  input: EpayPurchaseInput
): Promise<EpayPurchaseResult> {
  const { pid, apiUrl } = await getRuntimeEpayConfig();
  const baseUrl = getBaseUrl();
  const notifyUrl =
    input.notifyUrl ??
    (await getRuntimeSettingString("EPAY_NOTIFY_URL")) ??
    `${baseUrl}/api/webhooks/epay`;
  const paymentType =
    input.type ??
    (await getRuntimeSettingString("EPAY_DEFAULT_PAYMENT_TYPE")) ??
    "alipay";
  const params: Record<string, string> = {
    pid,
    type: paymentType,
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl,
    return_url: input.returnUrl ?? getEpayReturnUrl(baseUrl),
    name: input.name,
    money: formatMoney(input.money),
    device: "pc",
    sign_type: "MD5",
  };

  const signedParams = {
    ...params,
    sign: await signRuntimeEpayParams(params),
    sign_type: "MD5",
  };
  const submitUrl = getEpaySubmitUrl(apiUrl);

  return {
    url: submitUrl.toString(),
    params: signedParams,
  };
}

export async function saveEpayOrder(
  metadata: EpayMetadata,
  amount: number | string
): Promise<void> {
  await db
    .insert(epayOrder)
    .values({
      outTradeNo: metadata.outTradeNo,
      userId: metadata.userId,
      businessType: metadata.type,
      amount: Number(formatMoney(amount)),
      status: "pending",
      metadata: metadata as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: epayOrder.outTradeNo });
}

export async function getEpayOrderMetadata(
  outTradeNo: string
): Promise<EpayMetadata | null> {
  if (!outTradeNo) return null;

  const [order] = await db
    .select({
      metadata: epayOrder.metadata,
    })
    .from(epayOrder)
    .where(eq(epayOrder.outTradeNo, outTradeNo))
    .limit(1);

  if (!order?.metadata) return null;
  return normalizeEpayMetadata(order.metadata);
}

export async function updateEpayOrderStatus(
  outTradeNo: string,
  status: EpayOrderStatus
): Promise<void> {
  if (!outTradeNo) return;

  await db
    .update(epayOrder)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        sql`NOT EXISTS (SELECT 1 FROM upgrade_reservation WHERE out_trade_no = ${outTradeNo})`
      )
    );
}

export async function getEpayOrderStatus(
  outTradeNo: string
): Promise<EpayOrderStatus | null> {
  if (!outTradeNo) return null;

  const [order] = await db
    .select({ status: epayOrder.status })
    .from(epayOrder)
    .where(eq(epayOrder.outTradeNo, outTradeNo))
    .limit(1);

  return (order?.status as EpayOrderStatus | undefined) ?? null;
}

/** 普通订单的冻结履约计划；只保存财务标量，不保存网关原始请求。 */
export const epayFulfillmentPlanSchema = z.object({
  credits: z.number().positive().finite(),
  monthlyCredits: z.number().nonnegative().finite(),
  unitPrice: z.number().nonnegative().finite().optional(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  extendExpiry: z.boolean(),
});
export type EpayFulfillmentPlan = z.infer<typeof epayFulfillmentPlanSchema>;
export interface EpayFulfillmentLease {
  token: string;
  paidAt: Date;
  plan: EpayFulfillmentPlan | null;
}
export type EpayFulfillmentClaim =
  | { state: "fulfilled" }
  | { state: "busy" }
  | { state: "claimed"; lease: EpayFulfillmentLease };

// 独立 guard：upgrade 只能由 settleUpgradePayment 同事务结算。
const normalEpayOrder = sql`COALESCE(${epayOrder.metadata}->>'checkoutMode', '') <> 'upgrade'
  AND NOT EXISTS (SELECT 1 FROM upgrade_reservation WHERE out_trade_no = ${epayOrder.outTradeNo})`;
const recoverableEpayOrder = and(
  normalEpayOrder,
  sql`${epayOrder.status} NOT IN ('refund_pending', 'refunded')`
);

/**
 * 已验签通知先独立提交收款事实，再 CAS 领取 lease。任何一步退出后后台均可发现；
 * busy 不是履约成功。数据库时间是 lease 与 paidAt 的唯一时钟。
 */
export async function claimEpayOrderForFulfillment(
  outTradeNo: string,
  payment: EpayVerifyResult
): Promise<EpayFulfillmentClaim> {
  const cents = moneyToCents(payment.money);
  if (
    !outTradeNo ||
    outTradeNo !== payment.outTradeNo ||
    !payment.verifyStatus ||
    payment.tradeStatus !== EPAY_TRADE_SUCCESS ||
    !Number.isFinite(cents)
  )
    throw new Error("Invalid Epay payment fact");
  const recorded = await db
    .update(epayOrder)
    .set({
      paidAt: sql`COALESCE(${epayOrder.paidAt}, CURRENT_TIMESTAMP)`,
      paymentTradeNo: sql`COALESCE(${epayOrder.paymentTradeNo}, NULLIF(${payment.tradeNo}, ''))`,
      // 旧单后台重放没有网关流水：不得把订单标价伪装成真实收款额或支付方式。
      paidAmount: sql`CASE WHEN ${payment.tradeNo} = '' THEN ${epayOrder.paidAmount} ELSE ${cents / 100} END`,
      paymentMethod: sql`COALESCE(NULLIF(${epayOrder.paymentMethod}, ''), NULLIF(${payment.type}, ''))`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        sql`${cents} BETWEEN ROUND(${epayOrder.amount} * 100) AND ROUND(${epayOrder.amount} * 100) + 10`,
        sql`(${payment.tradeNo} <> '' OR ${epayOrder.paidAt} IS NOT NULL)`,
        sql`(${epayOrder.paymentTradeNo} IS NULL OR ${epayOrder.paymentTradeNo} = ${payment.tradeNo})`,
        sql`(${epayOrder.paidAmount} IS NULL OR ${epayOrder.paidAmount} = ${cents / 100})`
      )
    )
    .returning({ state: epayOrder.fulfillmentState });
  if (!recorded.length) throw new Error("Epay order or payment fact mismatch");
  if (recorded[0]?.state === "fulfilled") return { state: "fulfilled" };

  const token = crypto.randomUUID();
  const [row] = await db
    .update(epayOrder)
    .set({
      fulfillmentState: "processing",
      fulfillmentLeaseToken: token,
      fulfillmentLeaseExpiresAt: sql`CURRENT_TIMESTAMP + INTERVAL '2 minutes'`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        sql`${epayOrder.fulfillmentState} <> 'fulfilled'`,
        sql`(${epayOrder.fulfillmentLeaseExpiresAt} IS NULL OR ${epayOrder.fulfillmentLeaseExpiresAt} <= CURRENT_TIMESTAMP)`
      )
    )
    .returning({ paidAt: epayOrder.paidAt, plan: epayOrder.fulfillmentPlan });
  if (!row) return { state: "busy" };
  if (!row.paidAt) throw new Error("Epay paidAt missing");
  return {
    state: "claimed",
    lease: {
      token,
      paidAt: row.paidAt,
      plan: row.plan ? epayFulfillmentPlanSchema.parse(row.plan) : null,
    },
  };
}

/** 在首次副作用前冻结计划；只有当前有效 lease 能写入，旧 worker 不能覆盖。 */
export async function saveEpayFulfillmentPlan(
  outTradeNo: string,
  token: string,
  plan: EpayFulfillmentPlan
): Promise<EpayFulfillmentPlan> {
  const parsed = epayFulfillmentPlanSchema.parse(plan);
  const [row] = await db
    .update(epayOrder)
    .set({
      fulfillmentPlan: sql`COALESCE(${epayOrder.fulfillmentPlan}::jsonb, ${JSON.stringify(parsed)}::jsonb)::json`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        eq(epayOrder.fulfillmentLeaseToken, token),
        sql`${epayOrder.fulfillmentLeaseExpiresAt} > CURRENT_TIMESTAMP`,
        eq(epayOrder.fulfillmentState, "processing")
      )
    )
    .returning({ plan: epayOrder.fulfillmentPlan });
  if (!row) throw new Error("Epay fulfillment lease lost");
  return epayFulfillmentPlanSchema.parse(row.plan);
}

/** 各独立事务副作用前续租；过期或被替换的 worker 必须停止。 */
export async function renewEpayFulfillmentLease(
  outTradeNo: string,
  token: string
) {
  const rows = await db
    .update(epayOrder)
    .set({
      fulfillmentLeaseExpiresAt: sql`CURRENT_TIMESTAMP + INTERVAL '2 minutes'`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        eq(epayOrder.fulfillmentLeaseToken, token),
        eq(epayOrder.fulfillmentState, "processing"),
        sql`${epayOrder.fulfillmentLeaseExpiresAt} > CURRENT_TIMESTAMP`
      )
    )
    .returning({ outTradeNo: epayOrder.outTradeNo });
  if (!rows.length) throw new Error("Epay fulfillment lease lost");
}

/** 全部幂等步骤完成后才标 success；响应丢失时重投直接返回 fulfilled。 */
export async function finalizeEpayOrderFulfillment(
  outTradeNo: string,
  token: string
) {
  const rows = await db
    .update(epayOrder)
    .set({
      status: "success",
      fulfillmentState: "fulfilled",
      fulfilledAt: sql`CURRENT_TIMESTAMP`,
      fulfillmentLeaseToken: null,
      fulfillmentLeaseExpiresAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        eq(epayOrder.fulfillmentLeaseToken, token),
        eq(epayOrder.fulfillmentState, "processing"),
        sql`${epayOrder.fulfillmentLeaseExpiresAt} > CURRENT_TIMESTAMP`
      )
    )
    .returning({ outTradeNo: epayOrder.outTradeNo });
  if (!rows.length) throw new Error("Epay fulfillment lease lost at finalize");
}

/** 可捕获失败退避一分钟；保留收款与计划，不把已付款恢复为未付款。 */
export async function releaseEpayFulfillmentLease(
  outTradeNo: string,
  token: string
) {
  await db
    .update(epayOrder)
    .set({
      fulfillmentState: "pending",
      fulfillmentLeaseToken: null,
      fulfillmentLeaseExpiresAt: sql`CURRENT_TIMESTAMP + INTERVAL '1 minute'`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(epayOrder.outTradeNo, outTradeNo),
        recoverableEpayOrder,
        eq(epayOrder.fulfillmentLeaseToken, token),
        eq(epayOrder.fulfillmentState, "processing")
      )
    );
}

/** 后台只重放已持久接收的收款事实；不把未付款订单或 upgrade 当通知伪造。 */
export async function listRecoverableEpayPayments(
  limit = 100
): Promise<EpayVerifyResult[]> {
  const rows = await db
    .select()
    .from(epayOrder)
    .where(
      and(
        recoverableEpayOrder,
        sql`${epayOrder.paidAt} IS NOT NULL`,
        sql`${epayOrder.fulfillmentState} <> 'fulfilled'`,
        sql`(${epayOrder.fulfillmentLeaseExpiresAt} IS NULL OR ${epayOrder.fulfillmentLeaseExpiresAt} <= CURRENT_TIMESTAMP)`
      )
    )
    .orderBy(epayOrder.updatedAt)
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map((row) => ({
    verifyStatus: true,
    type: row.paymentMethod ?? "",
    tradeNo: row.paymentTradeNo ?? "",
    outTradeNo: row.outTradeNo,
    name: "",
    money: String(row.paidAmount ?? row.amount),
    tradeStatus: EPAY_TRADE_SUCCESS,
    raw: {},
  }));
}

export function verifyEpayParams(
  params: Record<string, string>
): EpayVerifyResult {
  const receivedSign = params.sign ?? "";
  const expectedSign = signEpayParams(params);
  const verifyStatus = timingSafeEqualString(
    receivedSign.toLowerCase(),
    expectedSign.toLowerCase()
  );

  const result: EpayVerifyResult = {
    verifyStatus,
    type: params.type ?? "",
    tradeNo: params.trade_no ?? "",
    outTradeNo: params.out_trade_no ?? "",
    name: params.name ?? "",
    money: params.money ?? "",
    tradeStatus: params.trade_status ?? "",
    raw: params,
  };

  if (params.param !== undefined) {
    result.param = params.param;
  }

  return result;
}

export async function verifyRuntimeEpayParams(
  params: Record<string, string>
): Promise<EpayVerifyResult> {
  const receivedSign = params.sign ?? "";
  const expectedSign = await signRuntimeEpayParams(params);
  const verifyStatus = timingSafeEqualString(
    receivedSign.toLowerCase(),
    expectedSign.toLowerCase()
  );

  const result: EpayVerifyResult = {
    verifyStatus,
    type: params.type ?? "",
    tradeNo: params.trade_no ?? "",
    outTradeNo: params.out_trade_no ?? "",
    name: params.name ?? "",
    money: params.money ?? "",
    tradeStatus: params.trade_status ?? "",
    raw: params,
  };

  if (params.param !== undefined) {
    result.param = params.param;
  }

  return result;
}

export async function parseEpayRequestParams(
  req: Request
): Promise<Record<string, string>> {
  const params: Record<string, string> = {};

  if (req.method === "GET") {
    const url = new URL(req.url);
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") {
        params[key] = value;
      } else if (value !== null && value !== undefined) {
        params[key] = String(value);
      }
    }
    return params;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await req.formData();
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key] = value;
      }
    });
    return params;
  }

  const body = await req.text();
  new URLSearchParams(body).forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

export function encodeEpayMetadata(metadata: EpayMetadata): string {
  const compact: Record<string, unknown> = {
    t: metadata.type === "subscription" ? "s" : "c",
    u: metadata.userId,
    o: metadata.outTradeNo,
  };

  if (metadata.priceId) compact.p = metadata.priceId;
  if (metadata.planId) compact.l = metadata.planId;
  if (metadata.packageId) compact.g = metadata.packageId;
  if (metadata.quantity && metadata.quantity > 1) compact.q = metadata.quantity;
  if (metadata.creditPlan) compact.x = metadata.creditPlan;

  if (metadata.type === "subscription") {
    if (metadata.checkoutMode === "upgrade") compact.m = "u";
    if (metadata.checkoutMode === "renewal") compact.m = "r";
    if (metadata.checkoutMode === "new_subscription") compact.m = "n";
    if (typeof metadata.expectedAmount === "number") {
      compact.e = metadata.expectedAmount;
    }
    if (typeof metadata.originalAmount === "number") {
      compact.a = metadata.originalAmount;
    }
    if (metadata.prorationCredit) {
      compact.c = metadata.prorationCredit;
    }
    if (metadata.remainingDays) {
      compact.r = metadata.remainingDays;
    }
    if (metadata.periodDays) {
      compact.d = metadata.periodDays;
    }
    if (metadata.upgradeFromPriceId) {
      compact.f = metadata.upgradeFromPriceId;
    }
  }

  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

export function decodeEpayMetadata(param?: string): EpayMetadata | null {
  if (!param) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(param, "base64url").toString("utf8")
    ) as Partial<EpayMetadata> & Record<string, unknown>;
    return normalizeEpayMetadata(parsed);
  } catch {
    return null;
  }
}

function normalizeEpayMetadata(
  metadata: Partial<EpayMetadata> & Record<string, unknown>
): EpayMetadata | null {
  const type =
    metadata.type ??
    (metadata.t === "s"
      ? "subscription"
      : metadata.t === "c"
        ? "credit_purchase"
        : undefined);
  const userId = metadata.userId ?? metadata.u;
  const outTradeNo = metadata.outTradeNo ?? metadata.o;
  const priceId = metadata.priceId ?? metadata.p;
  const planId = metadata.planId ?? metadata.l;
  const packageId = metadata.packageId ?? metadata.g;
  const creditPlan = metadata.creditPlan ?? metadata.x;
  const numberValue = (value: unknown) =>
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : undefined;
  const quantity = numberValue(metadata.quantity ?? metadata.q);
  const checkoutMode =
    metadata.checkoutMode ??
    (metadata.m === "u"
      ? "upgrade"
      : metadata.m === "r"
        ? "renewal"
        : metadata.m === "n"
          ? "new_subscription"
          : undefined);
  const expectedAmount = numberValue(metadata.expectedAmount ?? metadata.e);
  const originalAmount = numberValue(metadata.originalAmount ?? metadata.a);
  const prorationCredit = numberValue(metadata.prorationCredit ?? metadata.c);
  const remainingDays = numberValue(metadata.remainingDays ?? metadata.r);
  const periodDays = numberValue(metadata.periodDays ?? metadata.d);
  const upgradeFromPriceId = metadata.upgradeFromPriceId ?? metadata.f;

  if (
    (type !== "subscription" && type !== "credit_purchase") ||
    typeof userId !== "string" ||
    typeof outTradeNo !== "string"
  ) {
    return null;
  }

  return {
    type,
    userId,
    outTradeNo,
    ...(typeof priceId === "string" && { priceId }),
    ...(typeof planId === "string" && { planId }),
    ...(typeof packageId === "string" && { packageId }),
    ...(typeof creditPlan === "string" && { creditPlan }),
    ...(typeof quantity === "number" &&
      Number.isFinite(quantity) &&
      quantity > 0 && {
        quantity: Math.floor(quantity),
      }),
    ...((checkoutMode === "new_subscription" ||
      checkoutMode === "upgrade" ||
      checkoutMode === "renewal") && { checkoutMode }),
    ...(typeof expectedAmount === "number" &&
      Number.isFinite(expectedAmount) && {
        expectedAmount,
      }),
    ...(typeof originalAmount === "number" &&
      Number.isFinite(originalAmount) && {
        originalAmount,
      }),
    ...(typeof prorationCredit === "number" &&
      Number.isFinite(prorationCredit) && {
        prorationCredit,
      }),
    ...(typeof remainingDays === "number" &&
      Number.isFinite(remainingDays) && {
        remainingDays,
      }),
    ...(typeof periodDays === "number" &&
      Number.isFinite(periodDays) && {
        periodDays,
      }),
    ...(typeof upgradeFromPriceId === "string" && {
      upgradeFromPriceId,
    }),
  };
}

export function moneyToCents(value: number | string): number {
  const str = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return Number.NaN;
  }

  const [yuan = "0", cents = ""] = str.split(".");
  return Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
}
