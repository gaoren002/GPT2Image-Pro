/**
 * Creem API 客户端
 *
 * 提供与 Creem 支付平台的 API 交互
 * 文档: https://docs.creem.io/api-reference
 */

import crypto from "node:crypto";
import { creemEventEnvelopeSchema } from "./creem-event";
import { getRuntimeSettingString } from "../system-settings";

async function getRuntimeCreemApiKey() {
  return (await getRuntimeSettingString("CREEM_API_KEY")) ?? "";
}

async function getRuntimeCreemApiBase(): Promise<string> {
  return (await getRuntimeCreemApiKey()).startsWith("creem_test_")
    ? "https://test-api.creem.io/v1"
    : "https://api.creem.io/v1";
}

// ============================================
// 类型定义
// ============================================

export interface CreemCheckoutParams {
  /** Creem 产品 ID */
  product_id: string;
  /** 支付成功后的重定向 URL */
  success_url: string;
  /** 请求 ID（用于幂等性） */
  request_id?: string;
  /** 自定义元数据 */
  metadata?: Record<string, string>;
}

export interface CreemCheckoutResponse {
  /** Checkout ID */
  id: string;
  /** Checkout URL（重定向用户到此 URL 完成支付） */
  checkout_url: string;
  /** 状态 */
  status: string;
}

export interface CreemSubscription {
  /** 订阅 ID */
  id: string;
  /** 订阅状态 */
  status:
    | "active"
    | "canceled"
    | "past_due"
    | "trialing"
    | "paused"
    | "scheduled_cancel"
    | "unpaid"
    | "expired";
  /** 产品（可能是 ID 字符串或完整对象） */
  product:
    | string
    | {
        id: string;
        name?: string;
        price?: number;
        currency?: string;
        billing_type?: string;
        billing_period?: string;
      };
  /** 客户（可能是 ID 字符串或完整对象） */
  customer: string | { id: string; email?: string; name?: string };
  /** 当前周期开始时间 (ISO 8601) */
  current_period_start_date?: string;
  /** 当前周期结束时间 (ISO 8601) */
  current_period_end_date?: string;
  /** 是否在周期结束时取消 */
  cancel_at_period_end?: boolean;
  /** 元数据 */
  metadata?: Record<string, string>;
}

export interface CreemCustomer {
  /** 客户 ID */
  id: string;
  /** 邮箱 */
  email: string;
  /** 名称 */
  name?: string;
  /** 元数据 */
  metadata?: Record<string, string>;
}

export interface CreemWebhookEvent {
  /** 事件 ID */
  id: string;
  /** 事件类型 (Creem 使用 eventType 驼峰命名) */
  eventType:
    | "checkout.completed"
    | "subscription.active"
    | "subscription.canceled"
    | "subscription.renewed"
    | "subscription.paused"
    | "subscription.past_due"
    | "subscription.paid"
    | "subscription.expired"
    | "subscription.unpaid"
    | "subscription.scheduled_cancel"
    | "subscription.update"
    | "subscription.trialing";
  /** 事件数据 (Creem 直接在顶层使用 object，不嵌套在 data 里) */
  object: CreemCheckoutCompletedData | CreemSubscription;
  /** 创建时间 (Unix 毫秒时间戳) */
  created_at: number;
}

export interface CreemCheckoutCompletedData {
  /** Checkout ID */
  id: string;
  /** Checkout 对象类型 */
  object: "checkout";
  /** 请求 ID（幂等性） */
  request_id?: string;
  /** 订单信息 */
  order?: {
    object: "order";
    id: string;
    customer: string;
    product: string;
    amount: number;
    currency: string;
    status: string;
    type: "onetime" | "subscription";
    transaction?: string;
  };
  /** 产品信息 */
  product?: {
    id: string;
    name: string;
    price: number;
    currency: string;
    billing_type: "onetime" | "recurring";
    billing_period: string;
  };
  /** 订阅信息（如果是订阅支付） */
  subscription?: CreemSubscription;
  /** 客户信息 */
  customer: CreemCustomer;
  /** Checkout 状态 */
  status: string;
  /** 元数据 */
  metadata?: Record<string, string>;
  /** 模式 */
  mode?: "test" | "live";
}

// ============================================
// Webhook 事件运行时校验（Zod）
// ============================================

/**
 * 解析并运行时校验 Webhook 事件体。
 *
 * @param payload - 已验签的原始请求体（JSON 字符串）
 * @returns 结构校验通过的事件对象
 * @throws 当 JSON 非法或结构不符（含未知 eventType）时抛错，由调用方记日志并返回 4xx
 */
export function parseCreemWebhookEvent(payload: string): CreemWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid webhook payload: not valid JSON");
  }

  const result = creemEventEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid webhook event shape: ${result.error.issues
        .map((issue) => issue.path.join(".") || "<root>")
        .join(", ")}`
    );
  }

  // 此处只校验 wire 外壳；UOL 的 creemWebhookInputSchema 在任何落库前校验对象变体。
  return result.data as unknown as CreemWebhookEvent;
}

// ============================================
// Webhook 纯逻辑助手（DB-free，可单测）
// ============================================

/** 一天的毫秒数 */
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * 订阅周期长度判为年付的阈值（天）。
 *
 * WHY：Creem 不直接给出计费间隔，只能用周期长度推断。月付约 30 天、年付约 365 天，
 * 取 60 天作为分界既能容纳 28/31 天月份，又远低于年付下限，避免边界误判导致少发/多发积分。
 */
export const CREEM_YEARLY_PERIOD_DAY_THRESHOLD = 60;

/**
 * 构造订阅周期幂等键。
 *
 * 同一订阅 + 同一周期开始时间只发放一次积分，作为 credits_batch (source_type, source_ref)
 * 幂等去重的 sourceRef。
 */
export function buildSubscriptionPeriodKey(
  subscriptionId: string,
  periodStartDate: string
): string {
  return `${subscriptionId}:${periodStartDate}`;
}

/**
 * 计算订阅周期天数。
 *
 * @returns 周期天数（四舍五入）；当日期非法时返回 NaN，交由调用方决定回退。
 */
export function getCreemPeriodDays(
  periodStartDate: string,
  periodEndDate: string
): number {
  const start = new Date(periodStartDate).getTime();
  const end = new Date(periodEndDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return Number.NaN;
  }
  return Math.round((end - start) / MS_PER_DAY);
}

/**
 * 依据周期天数判断是否为年付订阅。
 *
 * 周期天数非法（NaN）时按月付处理，避免误发 12 倍积分。
 */
export function isYearlyCreemPeriod(periodDays: number): boolean {
  return (
    Number.isFinite(periodDays) &&
    periodDays > CREEM_YEARLY_PERIOD_DAY_THRESHOLD
  );
}

/**
 * 计算订阅周期应发放的积分。
 *
 * 月付发放月度积分，年付发放 12 个月积分。monthlyCredits 由服务端套餐配置提供，
 * 此处仅做纯算术，便于 DB-free 单测覆盖年付/月付与边界判定。
 */
export function computeSubscriptionCreditsToGrant(
  monthlyCredits: number,
  isYearly: boolean
): number {
  return isYearly ? monthlyCredits * 12 : monthlyCredits;
}

// ============================================
// API 客户端
// ============================================

/**
 * Creem API 客户端
 */
export const creem = {
  /**
   * 创建 Checkout Session
   *
   * @param params - Checkout 参数
   * @returns Checkout 响应（包含重定向 URL）
   */
  async createCheckout(
    params: CreemCheckoutParams
  ): Promise<CreemCheckoutResponse> {
    const res = await fetch(`${await getRuntimeCreemApiBase()}/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": await getRuntimeCreemApiKey(),
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },

  /**
   * 获取订阅详情
   *
   * @param subscriptionId - 订阅 ID
   * @returns 订阅信息
   */
  async getSubscription(subscriptionId: string): Promise<CreemSubscription> {
    const res = await fetch(
      `${await getRuntimeCreemApiBase()}/subscriptions/${subscriptionId}`,
      {
        headers: {
          "x-api-key": await getRuntimeCreemApiKey(),
        },
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },

  /**
   * 取消订阅
   *
   * @param subscriptionId - 订阅 ID
   * @returns 更新后的订阅信息
   */
  async cancelSubscription(subscriptionId: string): Promise<CreemSubscription> {
    const res = await fetch(
      `${await getRuntimeCreemApiBase()}/subscriptions/${subscriptionId}/cancel`,
      {
        method: "POST",
        headers: {
          "x-api-key": await getRuntimeCreemApiKey(),
        },
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },

  /**
   * 获取客户信息
   *
   * @param customerId - 客户 ID
   * @returns 客户信息
   */
  async getCustomer(customerId: string): Promise<CreemCustomer> {
    const res = await fetch(
      `${await getRuntimeCreemApiBase()}/customers/${customerId}`,
      {
        headers: {
          "x-api-key": await getRuntimeCreemApiKey(),
        },
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },
};

// ============================================
// Webhook 签名验证
// ============================================

/**
 * 验证 Creem Webhook 签名
 *
 * @param payload - 原始请求体
 * @param signature - creem-signature 头
 * @param secret - Webhook 密钥
 * @returns 是否验证通过
 */
export function verifyCreemWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const computedBuf = Buffer.from(expectedSignature);
  const receivedBuf = Buffer.from(signature);
  if (computedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}

/**
 * 解析并验证 Creem Webhook 事件
 *
 * @param payload - 原始请求体
 * @param signature - creem-signature 头
 * @returns 解析后的事件对象
 * @throws 如果签名验证失败
 */
export function constructCreemEvent(
  payload: string,
  signature: string
): CreemWebhookEvent {
  const secret = process.env.CREEM_WEBHOOK_SECRET;
  if (!secret) throw new Error("CREEM_WEBHOOK_SECRET is not configured");

  if (!verifyCreemWebhookSignature(payload, signature, secret)) {
    throw new Error("Invalid webhook signature");
  }

  return parseCreemWebhookEvent(payload);
}

export async function constructRuntimeCreemEvent(
  payload: string,
  signature: string
): Promise<CreemWebhookEvent> {
  const secret = await getRuntimeSettingString("CREEM_WEBHOOK_SECRET");
  if (!secret) throw new Error("CREEM_WEBHOOK_SECRET is not configured");

  if (!verifyCreemWebhookSignature(payload, signature, secret)) {
    throw new Error("Invalid webhook signature");
  }

  return parseCreemWebhookEvent(payload);
}
