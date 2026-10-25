import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  json,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Better Auth 核心表 Schema
 *
 * 这些表是 Better Auth 认证系统所必需的核心表结构
 * 参考: https://www.better-auth.com/docs/concepts/database
 */

// ============================================
// 用户角色枚举
// ============================================

/**
 * 用户角色枚举
 */
export const userRoleEnum = pgEnum("user_role", [
  "user",
  "observer_admin",
  "admin",
  "super_admin",
]);

// ============================================
// 用户表 (User)
// ============================================
/**
 * 用户表 - 存储用户基本信息
 *
 * @field id - 用户唯一标识符
 * @field name - 用户显示名称
 * @field email - 用户邮箱 (唯一)
 * @field emailVerified - 邮箱是否已验证
 * @field image - 用户头像 URL
 * @field role - 用户角色 (user/observer_admin/admin/super_admin)
 * @field banned - 是否被封禁
 * @field bannedReason - 封禁原因
 * @field moderationBlockRiskLevel - 用户默认审核拦截级别
 * @field customerId - 支付提供商客户 ID (Creem)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRoleEnum("role").notNull().default("user"),
  banned: boolean("banned").notNull().default(false),
  bannedReason: text("banned_reason"),
  moderationBlockRiskLevel: text("moderation_block_risk_level")
    .notNull()
    .default("low"),
  customerId: text("customer_id").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 管理员操作审计日志 (Admin Audit Log)
// ============================================
/**
 * 管理员操作审计日志 - 记录高风险后台操作
 *
 * @field id - 记录唯一标识符
 * @field adminUserId - 执行操作的管理员用户 ID
 * @field targetUserId - 被操作的目标用户 ID（可为空，用于全局操作）
 * @field action - 操作类型
 * @field reason - 管理员填写的操作原因
 * @field before - 操作前快照
 * @field after - 操作后快照
 * @field metadata - 扩展元数据
 * @field createdAt - 创建时间
 */
export const adminAuditLog = pgTable("admin_audit_log", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  targetUserId: text("target_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  action: text("action").notNull(),
  reason: text("reason"),
  before: json("before").$type<Record<string, unknown>>(),
  after: json("after").$type<Record<string, unknown>>(),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================
// 注册邮箱账本 (Registration Identity)
// ============================================
/**
 * 注册邮箱账本 - 永久记录已经注册过的邮箱
 *
 * 即使用户后续删除账号，也保留邮箱占位，防止重复注册领取新用户奖励。
 *
 * @field id - 记录唯一标识符
 * @field email - 规范化邮箱 (小写，唯一)
 * @field userId - 首次注册关联用户 ID (用户硬删后可为空)
 * @field firstRegisteredAt - 首次注册时间
 * @field lastSeenAt - 最近一次确认时间
 * @field deletedAt - 账号删除时间 (可为空)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const registrationIdentity = pgTable("registration_identity", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  firstRegisteredAt: timestamp("first_registered_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 会话表 (Session)
// ============================================
/**
 * 会话表 - 存储用户登录会话
 *
 * @field id - 会话唯一标识符
 * @field expiresAt - 会话过期时间
 * @field token - 会话令牌 (用于验证)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 * @field ipAddress - 登录 IP 地址
 * @field userAgent - 用户代理 (浏览器信息)
 * @field userId - 关联的用户 ID
 */
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// ============================================
// 账户表 (Account)
// ============================================
/**
 * 账户表 - 存储 OAuth 提供商关联信息
 *
 * 当用户使用 GitHub、Google 等第三方登录时，
 * 此表存储该提供商的账户信息
 *
 * @field id - 账户唯一标识符
 * @field accountId - 提供商返回的账户 ID
 * @field providerId - 提供商标识符 (如 "github", "google")
 * @field userId - 关联的用户 ID
 * @field accessToken - 访问令牌
 * @field refreshToken - 刷新令牌
 * @field idToken - ID 令牌 (OpenID Connect)
 * @field accessTokenExpiresAt - 访问令牌过期时间
 * @field refreshTokenExpiresAt - 刷新令牌过期时间
 * @field scope - 授权范围
 * @field password - 密码哈希 (用于邮箱密码登录)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 验证表 (Verification)
// ============================================
/**
 * 验证表 - 存储邮箱验证和密码重置令牌
 *
 * @field id - 验证记录唯一标识符
 * @field identifier - 标识符 (通常是邮箱地址)
 * @field value - 验证值/令牌
 * @field expiresAt - 过期时间
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 订阅表 (Subscription)
// ============================================
/**
 * 订阅表 - 存储用户的订阅信息
 *
 * @field id - 订阅记录唯一标识符
 * @field userId - 关联的用户 ID
 * @field subscriptionId - 支付提供商订阅 ID (唯一)
 * @field priceId - 支付提供商价格/产品 ID
 * @field status - 订阅状态 (active, canceled, past_due, etc.)
 * @field currentPeriodStart - 当前计费周期开始时间
 * @field currentPeriodEnd - 当前计费周期结束时间
 * @field cancelAtPeriodEnd - 是否在周期结束时取消
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const subscription = pgTable("subscription", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull().unique(),
  priceId: text("price_id").notNull(),
  status: text("status").notNull().default("incomplete"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // Creem 状态水位只由已验签事件推进；其他支付渠道不写这些字段。
  creemEventCreatedAt: bigint("creem_event_created_at", { mode: "number" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Creem 已验签事件身份凭证；只存摘要，不存原始 payload/客户资料，不作为财务完成标记。 */
export const creemWebhookEvent = pgTable("creem_webhook_event", {
  eventId: text("event_id").primaryKey(),
  eventCreatedAt: bigint("event_created_at", { mode: "number" }).notNull(),
  payloadHash: text("payload_hash").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

/** 每个 provider 订阅的状态水位；无用户映射时也保留 tombstone，防 checkout 晚到复活。 */
export const creemSubscriptionState = pgTable("creem_subscription_state", {
  subscriptionId: text("subscription_id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
  eventId: text("event_id").notNull(),
  eventCreatedAt: bigint("event_created_at", { mode: "number" }).notNull(),
  snapshot: json("snapshot").$type<{
    status: string;
    priceId: string;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>().notNull(),
});

// ============================================
// 类型导出
// ============================================
/**
 * 从 Schema 推断的类型
 * 用于在应用中保持类型安全
 */
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;

export type RegistrationIdentity = typeof registrationIdentity.$inferSelect;
export type NewRegistrationIdentity = typeof registrationIdentity.$inferInsert;

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export type Verification = typeof verification.$inferSelect;
export type NewVerification = typeof verification.$inferInsert;

export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;

// ============================================
// Epay 订单表
// ============================================
/**
 * 易支付订单表 - 本地保存业务元数据，避免把长 param 透传给支付网关。
 */
export const epayOrder = pgTable("epay_order", {
  outTradeNo: text("out_trade_no").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  businessType: text("business_type").notNull(),
  amount: numeric("amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  status: text("status").notNull().default("pending"),
  paymentTradeNo: text("payment_trade_no").unique(),
  paidAmount: numeric("paid_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }),
  // 收款事实独立于履约终态；租约和冻结计划供通知重投及后台恢复。
  paidAt: timestamp("paid_at"),
  paymentMethod: text("payment_method"),
  fulfillmentState: text("fulfillment_state").notNull().default("pending"),
  fulfillmentLeaseToken: text("fulfillment_lease_token"),
  fulfillmentLeaseExpiresAt: timestamp("fulfillment_lease_expires_at"),
  fulfillmentPlan: json("fulfillment_plan").$type<Record<string, unknown>>(),
  fulfilledAt: timestamp("fulfilled_at"),
  metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type EpayOrder = typeof epayOrder.$inferSelect;
export type NewEpayOrder = typeof epayOrder.$inferInsert;

// ============================================
// 积分系统枚举
// ============================================

/**
 * 积分账户状态枚举
 */
export const creditsBalanceStatusEnum = pgEnum("credits_balance_status", [
  "active",
  "frozen",
]);

/**
 * 积分批次状态枚举
 */
export const creditsBatchStatusEnum = pgEnum("credits_batch_status", [
  "active",
  "consumed",
  "expired",
]);

/**
 * 积分批次来源类型枚举
 */
export const creditsBatchSourceEnum = pgEnum("credits_batch_source", [
  "purchase",
  "subscription",
  "bonus",
  "refund",
]);

/**
 * 积分交易类型枚举
 */
export const creditsTransactionTypeEnum = pgEnum("credits_transaction_type", [
  "purchase",
  "consumption",
  "monthly_grant",
  "registration_bonus",
  "admin_grant",
  "expiration",
  "refund",
]);

// ============================================
// 积分余额表 (Credits Balances)
// ============================================
/**
 * 积分余额表 - 存储用户的积分账户信息
 *
 * 采用预计算余额模式，避免每次查询都需要聚合计算
 *
 * @field id - 记录唯一标识符
 * @field userId - 关联的用户 ID（唯一）
 * @field balance - 当前可用积分余额
 * @field totalEarned - 累计获得积分
 * @field totalSpent - 累计消费积分
 * @field status - 账户状态（active/frozen）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const creditsBalance = pgTable("credits_balance", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  balance: numeric("balance", { precision: 18, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  totalEarned: numeric("total_earned", {
    precision: 18,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  totalSpent: numeric("total_spent", {
    precision: 18,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  status: creditsBalanceStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 积分批次表 (Credits Batches)
// ============================================
/**
 * 积分批次表 - 积分库存管理
 *
 * 每次获得积分都会创建一个批次记录
 * 用于实现 FIFO (先进先出) 过期机制
 *
 * @field id - 批次唯一标识符
 * @field userId - 关联的用户 ID
 * @field amount - 原始积分数量
 * @field remaining - 剩余积分数量
 * @field issuedAt - 发放时间
 * @field expiresAt - 过期时间
 * @field status - 批次状态（active/consumed/expired）
 * @field sourceType - 来源类型（purchase/subscription/bonus/refund）
 * @field sourceRef - 来源引用（如订单ID、订阅ID等）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const creditsBatch = pgTable(
  "credits_batch",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 18, scale: 2, mode: "number" })
      .notNull(),
    remaining: numeric("remaining", { precision: 18, scale: 2, mode: "number" })
      .notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    status: creditsBatchStatusEnum("status").notNull().default("active"),
    sourceType: creditsBatchSourceEnum("source_type").notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // 幂等性约束：同一 (来源类型, 来源引用) 只能发放一次。
    // 关闭支付 webhook 重放 / 并发双发 / 注册奖励farming 等积分双重发放风险。
    // 偏索引：source_ref 为空的批次（如手动调整）不受约束。
    uniqueIndex("credits_batch_source_ref_unique")
      .on(table.sourceType, table.sourceRef)
      .where(sql`${table.sourceRef} is not null`),
  ]
);

// ============================================
// 积分交易表 (Credits Transactions)
// ============================================
/**
 * 积分交易表 - 双重记账账本
 *
 * 记录所有积分变动，采用借贷记账法
 * 每笔交易都有明确的借方(debit)和贷方(credit)账户
 *
 * @field id - 交易唯一标识符
 * @field userId - 关联的用户 ID
 * @field type - 交易类型
 * @field amount - 交易积分数量（始终为正数）
 * @field debitAccount - 借方账户（资金来源）
 * @field creditAccount - 贷方账户（资金去向）
 * @field description - 交易描述
 * @field metadata - 扩展元数据（JSON）
 * @field createdAt - 创建时间
 */
export const creditsTransaction = pgTable(
  "credits_transaction",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: creditsTransactionTypeEnum("type").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2, mode: "number" })
      .notNull(),
    debitAccount: text("debit_account").notNull(),
    creditAccount: text("credit_account").notNull(),
    description: text("description"),
    // 来源引用（幂等键）：同一 (type, source_ref) 只记一次。
    // 用于消费路径的请求级幂等（重试/并发重复扣费防护），对齐发放/退款的幂等设计。
    sourceRef: text("source_ref"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // 偏唯一索引：source_ref 为空的交易（绝大多数历史/无幂等需求的扣费）不受约束。
    // 按 (user_id, type, source_ref) 分桶（迁移 0029）：避免跨用户共用同一 source_ref
    // 时幂等查询误命中他人交易回放其 amount/metadata（IDOR，审计 S-L1）。
    uniqueIndex("credits_transaction_user_type_source_ref_unique")
      .on(table.userId, table.type, table.sourceRef)
      .where(sql`${table.sourceRef} is not null`),
    // 账单/用量页与管理员用户详情:'WHERE user_id=? ORDER BY created_at DESC' 的有序索引,
    // 替代此前对 141MB 表的顺序扫(迁移 0036)。
    index("credits_transaction_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
  ]
);

// ============================================
// 系统设置表 (System Settings)
// ============================================
/**
 * 系统设置表 - 存储管理员可配置的运行时配置与密钥
 *
 * @field key - 配置键名
 * @field value - 配置值，密钥也存储在这里但不会在管理界面回显
 * @field isSecret - 是否为密钥类配置
 * @field updatedBy - 最近更新的管理员
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const systemSetting = pgTable("system_setting", {
  key: text("key").primaryKey(),
  value: json("value").$type<unknown>().notNull(),
  isSecret: boolean("is_secret").notNull().default(false),
  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// Chat 纯文字连续使用状态
// ============================================
/**
 * Chat 纯文字连续使用状态 - 用于限制连续多次对话但不出图的滥用
 */
export const chatNoImageState = pgTable("chat_no_image_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  consecutiveCount: integer("consecutive_count").notNull().default(0),
  lastGenerationId: text("last_generation_id"),
  lastPenaltyAt: timestamp("last_penalty_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SystemSetting = typeof systemSetting.$inferSelect;
export type NewSystemSetting = typeof systemSetting.$inferInsert;

export type ChatNoImageState = typeof chatNoImageState.$inferSelect;
export type NewChatNoImageState = typeof chatNoImageState.$inferInsert;

// ============================================
// 积分系统类型导出
// ============================================

export type CreditsBalance = typeof creditsBalance.$inferSelect;
export type NewCreditsBalance = typeof creditsBalance.$inferInsert;

export type CreditsBatch = typeof creditsBatch.$inferSelect;
export type NewCreditsBatch = typeof creditsBatch.$inferInsert;

export type CreditsTransaction = typeof creditsTransaction.$inferSelect;
export type NewCreditsTransaction = typeof creditsTransaction.$inferInsert;

/** 积分账户状态类型 */
export type CreditsBalanceStatus =
  (typeof creditsBalanceStatusEnum.enumValues)[number];

/** 积分批次状态类型 */
export type CreditsBatchStatus =
  (typeof creditsBatchStatusEnum.enumValues)[number];

/** 积分批次来源类型 */
export type CreditsBatchSource =
  (typeof creditsBatchSourceEnum.enumValues)[number];

/** 积分交易类型 */
export type CreditsTransactionType =
  (typeof creditsTransactionTypeEnum.enumValues)[number];

// ============================================
// Newsletter 订阅表
// ============================================
/**
 * Newsletter 订阅者表 - 存储邮件订阅信息
 *
 * @field id - 记录唯一标识符
 * @field email - 订阅者邮箱 (唯一)
 * @field isSubscribed - 是否订阅中 (用于取消订阅而不删除记录)
 * @field subscribedAt - 订阅时间
 * @field unsubscribedAt - 取消订阅时间 (可为空)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const newsletterSubscriber = pgTable("newsletter_subscriber", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  isSubscribed: boolean("is_subscribed").notNull().default(true),
  subscribedAt: timestamp("subscribed_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// Newsletter 类型导出
// ============================================

export type NewsletterSubscriber = typeof newsletterSubscriber.$inferSelect;
export type NewNewsletterSubscriber = typeof newsletterSubscriber.$inferInsert;

// ============================================
// 公告系统 (Announcements)
// ============================================

/**
 * 公告表 - 存储系统公告、维护通知和活动说明
 *
 * @field id - 公告唯一标识符
 * @field title - 公告标题
 * @field content - 公告正文，按纯文本展示
 * @field severity - 公告等级 (info/success/warning/critical)
 * @field isPublished - 是否发布
 * @field isPinned - 是否置顶
 * @field priority - 排序优先级，数字越大越靠前
 * @field publishedAt - 生效发布时间，可为空
 * @field expiresAt - 过期时间，可为空
 * @field createdByUserId - 创建管理员
 * @field updatedByUserId - 最近更新管理员
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const announcement = pgTable("announcement", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  severity: text("severity").notNull().default("info"),
  isPublished: boolean("is_published").notNull().default(false),
  isPinned: boolean("is_pinned").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  publishedAt: timestamp("published_at"),
  expiresAt: timestamp("expires_at"),
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * 公告已读表 - 记录用户已读公告
 */
export const announcementRead = pgTable(
  "announcement_read",
  {
    id: text("id").primaryKey(),
    announcementId: text("announcement_id")
      .notNull()
      .references(() => announcement.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at").notNull().defaultNow(),
  },
  (table) => ({
    announcementUserUnique: uniqueIndex(
      "announcement_read_user_announcement_unique"
    ).on(table.userId, table.announcementId),
  })
);

export type Announcement = typeof announcement.$inferSelect;
export type NewAnnouncement = typeof announcement.$inferInsert;
export type AnnouncementRead = typeof announcementRead.$inferSelect;
export type NewAnnouncementRead = typeof announcementRead.$inferInsert;

// ============================================
// 工单系统枚举
// ============================================

/**
 * 工单类别枚举
 */
export const ticketCategoryEnum = pgEnum("ticket_category", [
  "billing",
  "technical",
  "bug",
  "feature",
  "other",
]);

/**
 * 工单优先级枚举
 */
export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "low",
  "medium",
  "high",
]);

/**
 * 工单状态枚举
 */
export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "resolved",
  "closed",
]);

// ============================================
// 工单表 (Tickets)
// ============================================
/**
 * 工单表 - 存储用户支持工单
 *
 * @field id - 工单唯一标识符
 * @field userId - 创建工单的用户 ID
 * @field subject - 工单主题
 * @field category - 工单类别 (billing/technical/bug/feature/other)
 * @field priority - 优先级 (low/medium/high)
 * @field status - 状态 (open/in_progress/resolved/closed)
 * @field userLastSeenAt - 用户最近查看工单详情时间
 * @field lastAdminActivityAt - 最近一次管理员回复或状态更新时间
 * @field adminLastSeenAt - 管理员最近查看工单详情时间
 * @field lastUserActivityAt - 最近一次用户新建或回复时间
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const ticket = pgTable("ticket", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  category: ticketCategoryEnum("category").notNull().default("other"),
  priority: ticketPriorityEnum("priority").notNull().default("medium"),
  status: ticketStatusEnum("status").notNull().default("open"),
  userLastSeenAt: timestamp("user_last_seen_at").notNull().defaultNow(),
  lastAdminActivityAt: timestamp("last_admin_activity_at"),
  adminLastSeenAt: timestamp("admin_last_seen_at"),
  lastUserActivityAt: timestamp("last_user_activity_at").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 工单消息表 (Ticket Messages)
// ============================================
/**
 * 工单消息表 - 存储工单对话记录
 *
 * @field id - 消息唯一标识符
 * @field ticketId - 关联的工单 ID
 * @field userId - 发送者用户 ID
 * @field content - 消息内容
 * @field isAdminResponse - 是否为管理员回复 (用于 UI 样式区分)
 * @field createdAt - 创建时间
 */
export const ticketMessage = pgTable("ticket_message", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => ticket.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isAdminResponse: boolean("is_admin_response").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * 工单图片附件。新上传的附件先保持 messageId/ticketId 为空，提交消息时再绑定。
 */
export const ticketAttachment = pgTable(
  "ticket_attachment",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").references(() => ticket.id, {
      onDelete: "cascade",
    }),
    messageId: text("message_id").references(() => ticketMessage.id, {
      onDelete: "cascade",
    }),
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("ticket_attachment_ticket_idx").on(table.ticketId),
    index("ticket_attachment_message_idx").on(table.messageId),
    index("ticket_attachment_uploader_idx").on(table.uploaderId),
  ]
);

// ============================================
// User API Configuration
// ============================================
export const userApiConfig = pgTable("user_api_config", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  model: text("model"),
  // 本站型号 → 上游型号（可按 quality 分档）。空=不改写，仍用请求型号或上方 model 缺省。
  modelMapping: json("model_mapping").$type<
    Array<{
      from: string;
      to: string;
      whenQuality?: string;
      setQuality?: string;
    }>
  >(),
  useStream: boolean("use_stream").notNull().default(false),
  chatCompletionsUpstreamMode: text("chat_completions_upstream_mode")
    .notNull()
    .default("responses"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserApiConfig = typeof userApiConfig.$inferSelect;
export type NewUserApiConfig = typeof userApiConfig.$inferInsert;

// ============================================
// Image Backend Pool
// ============================================
export const imageBackendGroup = pgTable("image_backend_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  isUserSelectable: boolean("is_user_selectable").notNull().default(true),
  contentSafetyEnabled: boolean("content_safety_enabled"),
  priority: integer("priority").notNull().default(50),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const imageBackendAccount = pgTable(
  "image_backend_account",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").references(() => imageBackendGroup.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    email: text("email"),
    credentialHash: text("credential_hash").notNull(),
    // 仅由可信 OAuth 轮换响应建立；不按每轮 AT 哈希识别账户。
    oauthIdentityKey: text("oauth_identity_key"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    implementationMode: text("interface_mode").notNull().default("web"),
    model: text("model"),
    // 质量计价倍率：quality(auto/low/medium/high/xhigh/max) → 倍率。未配置档位
    // 计 1 倍。与 imageBackendApi.qualityBilling 同义，web/codex 账号均可配置；
    // 折入 operations.ts 的总 billingMultiplier（与分组倍率相乘）。
    qualityBilling: json("quality_billing").$type<
      Partial<Record<string, number>>
    >(),
    contentSafetyEnabled: boolean("content_safety_enabled").notNull().default(true),
    isEnabled: boolean("is_enabled").notNull().default(true),
    // 遇错也始终可用：与 isEnabled 同时为真时，该账号永不进入冷却、不因失败被
    // 调度器置 error 排除（失败仍记录 lastError/failCount，但始终留在候选里）。
    // 与 imageBackendApi.alwaysActive 语义一致。
    alwaysActive: boolean("always_active").notNull().default(false),
    priority: integer("priority").notNull().default(50),
    concurrency: integer("concurrency").notNull().default(1),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at"),
    lastAcquiredAt: timestamp("last_acquired_at"),
    cooldownUntil: timestamp("cooldown_until"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_account_interface_credential_hash_unique").on(
      table.implementationMode,
      table.credentialHash
    ),
    uniqueIndex("image_backend_account_oauth_identity_unique").on(
      table.implementationMode,
      table.oauthIdentityKey
    ),
  ]
);

/** OAuth 轮换意图及加密结果；prepared/uncertain 不自动重发，远端与本库不能跨系统原子提交。 */
export const imageBackendTokenRotation = pgTable("image_backend_token_rotation", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  journalIdentity: text("journal_identity"),
  clientId: text("client_id").notNull(),
  state: text("state").notNull().default("prepared"),
  encryptedPlan: text("encrypted_plan"),
  accounts: json("accounts").$type<{ id: string; mode: "web" | "responses" }[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("image_backend_token_rotation_pending_idx").on(table.createdAt)
    .where(sql`${table.state} = 'ready'`),
  index("image_backend_token_rotation_unfinished_idx").on(table.journalIdentity)
    .where(sql`${table.state} IN ('prepared', 'uncertain', 'ready')`),
]);

export const imageBackendAccountGroup = pgTable(
  "image_backend_account_group",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => imageBackendAccount.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => imageBackendGroup.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_account_group_account_group_unique").on(
      table.accountId,
      table.groupId
    ),
    index("image_backend_account_group_group_idx").on(table.groupId),
  ]
);

export const imageBackendApi = pgTable("image_backend_api", {
  id: text("id").primaryKey(),
  groupId: text("group_id").references(() => imageBackendGroup.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  model: text("model"),
  // 本站型号 → 上游型号（可按 quality 分档）。空=不改写。
  modelMapping: json("model_mapping").$type<
    Array<{
      from: string;
      to: string;
      whenQuality?: string;
      setQuality?: string;
    }>
  >(),
  interfaceMode: text("interface_mode").notNull().default("images"),
  // 质量计价倍率：quality(auto/low/medium/high/xhigh/max) → 倍率。未配置档位
  // 计 1 倍。折入 operations.ts 的总 billingMultiplier（与分组倍率、模型族倍率
  // 相乘），作用于该 API 服务的图像/对话轮次扣费。解析见 quality-billing.ts。
  qualityBilling: json("quality_billing").$type<
    Partial<Record<string, number>>
  >(),
  useStream: boolean("use_stream").notNull().default(false),
  chatCompletionsUpstreamMode: text("chat_completions_upstream_mode")
    .notNull()
    .default("responses"),
  imageUpstreamMode: text("image_upstream_mode").notNull().default("images"),
  contentSafetyEnabled: boolean("content_safety_enabled").notNull().default(true),
  isEnabled: boolean("is_enabled").notNull().default(true),
  // 遇错也始终可用：与 isEnabled 同时为真时，该 API 永不进入冷却、不因失败被
  // 调度器置 error 排除（失败仍记录 lastError，但始终留在候选里）。
  alwaysActive: boolean("always_active").notNull().default(false),
  priority: integer("priority").notNull().default(50),
  // 单后端最大在飞并发（与账号一致）。默认 10：API 中转通常可并发，过低会在高
  // 并发下把请求挡成"无可用账号或 API"。
  concurrency: integer("concurrency").notNull().default(10),
  // 失败是否进入冷却（每后端独立，取代旧的全局 IMAGE_BACKEND_API_FAILURE_COOLDOWN_ENABLED）。
  // 关闭（默认）时：瞬时/可恢复失败不冷却也不改状态；仅确定性错误置 error 踢出。
  failureCooldownEnabled: boolean("failure_cooldown_enabled")
    .notNull()
    .default(false),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  lastUsedAt: timestamp("last_used_at"),
  lastAcquiredAt: timestamp("last_acquired_at"),
  cooldownUntil: timestamp("cooldown_until"),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at"),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 外接 API 后端与分组的多对多关系（镜像 imageBackendAccountGroup）。
// imageBackendApi.groupId 保留为主分组/向后兼容；本表承载全部分组成员关系，
// 让同一个 API 后端可同时被多个分组调度。
export const imageBackendApiGroup = pgTable(
  "image_backend_api_group",
  {
    id: text("id").primaryKey(),
    apiId: text("api_id")
      .notNull()
      .references(() => imageBackendApi.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => imageBackendGroup.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_api_group_api_group_unique").on(
      table.apiId,
      table.groupId
    ),
    index("image_backend_api_group_group_idx").on(table.groupId),
  ]
);

export const imageBackendInflightLease = pgTable(
  "image_backend_inflight_lease",
  {
    id: text("id").primaryKey(),
    memberType: text("member_type").notNull(),
    memberId: text("member_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("image_backend_inflight_lease_member_idx").on(
      table.memberType,
      table.memberId
    ),
    index("image_backend_inflight_lease_expires_at_idx").on(table.expiresAt),
  ]
);

export const imageBackendStickyBinding = pgTable(
  "image_backend_sticky_binding",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    bindingKey: text("binding_key").notNull(),
    memberType: text("member_type").notNull(),
    memberId: text("member_id").notNull(),
    groupId: text("group_id"),
    accountBackend: text("account_backend"),
    expiresAt: timestamp("expires_at").notNull(),
    lastHitAt: timestamp("last_hit_at"),
    hitCount: integer("hit_count").notNull().default(0),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_sticky_binding_scope_key_unique").on(
      table.scope,
      table.bindingKey
    ),
    index("image_backend_sticky_binding_member_idx").on(
      table.memberType,
      table.memberId
    ),
    index("image_backend_sticky_binding_expires_at_idx").on(table.expiresAt),
  ]
);

export const imageBackendSchedulerMetric = pgTable(
  "image_backend_scheduler_metric",
  {
    id: text("id").primaryKey(),
    bucketStartedAt: timestamp("bucket_started_at").notNull(),
    requestKind: text("request_kind").notNull(),
    selectedLayer: text("selected_layer").notNull(),
    memberType: text("member_type"),
    memberId: text("member_id"),
    groupId: text("group_id"),
    selectCount: integer("select_count").notNull().default(0),
    stickyPreviousHitCount: integer("sticky_previous_hit_count")
      .notNull()
      .default(0),
    stickySessionHitCount: integer("sticky_session_hit_count")
      .notNull()
      .default(0),
    loadBalanceCount: integer("load_balance_count").notNull().default(0),
    switchCount: integer("switch_count").notNull().default(0),
    candidateCountTotal: integer("candidate_count_total").notNull().default(0),
    latencyMsTotal: integer("latency_ms_total").notNull().default(0),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_scheduler_metric_bucket_unique").on(
      table.bucketStartedAt,
      table.requestKind,
      table.selectedLayer,
      table.memberType,
      table.memberId,
      table.groupId
    ),
    index("image_backend_scheduler_metric_bucket_idx").on(table.bucketStartedAt),
  ]
);

export const userImageBackendPreference = pgTable(
  "user_image_backend_preference",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => imageBackendGroup.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  }
);

export type ImageBackendGroup = typeof imageBackendGroup.$inferSelect;
export type NewImageBackendGroup = typeof imageBackendGroup.$inferInsert;
export type ImageBackendAccount = typeof imageBackendAccount.$inferSelect;
export type NewImageBackendAccount = typeof imageBackendAccount.$inferInsert;
export type ImageBackendAccountGroup =
  typeof imageBackendAccountGroup.$inferSelect;
export type NewImageBackendAccountGroup =
  typeof imageBackendAccountGroup.$inferInsert;
export type ImageBackendApi = typeof imageBackendApi.$inferSelect;
export type NewImageBackendApi = typeof imageBackendApi.$inferInsert;
export type ImageBackendApiGroup = typeof imageBackendApiGroup.$inferSelect;
export type NewImageBackendApiGroup =
  typeof imageBackendApiGroup.$inferInsert;
export type ImageBackendInflightLease =
  typeof imageBackendInflightLease.$inferSelect;
export type NewImageBackendInflightLease =
  typeof imageBackendInflightLease.$inferInsert;
export type ImageBackendStickyBinding =
  typeof imageBackendStickyBinding.$inferSelect;
export type NewImageBackendStickyBinding =
  typeof imageBackendStickyBinding.$inferInsert;
export type ImageBackendSchedulerMetric =
  typeof imageBackendSchedulerMetric.$inferSelect;
export type NewImageBackendSchedulerMetric =
  typeof imageBackendSchedulerMetric.$inferInsert;
export type UserImageBackendPreference =
  typeof userImageBackendPreference.$inferSelect;
export type NewUserImageBackendPreference =
  typeof userImageBackendPreference.$inferInsert;

// ============================================
// External API Keys
// ============================================
export const externalApiKey = pgTable(
  "external_api_key",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default API key"),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastFour: text("last_four").notNull(),
    moderationBlockRiskLevel: text("moderation_block_risk_level")
      .notNull()
      .default("low"),
    generationGroupId: text("generation_group_id").references(
      () => imageBackendGroup.id,
      { onDelete: "set null" }
    ),
    creditLimit: numeric("credit_limit", {
      precision: 18,
      scale: 2,
      mode: "number",
    }),
    creditsUsed: numeric("credits_used", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    lastUsedAt: timestamp("last_used_at"),
    isActive: boolean("is_active").notNull().default(true),
    // 用户撤销为永久失效；管理员临时禁用只改 isActive，不得恢复已撤销的凭据。
    revokedAt: timestamp("revoked_at"),
    // 纯中转模式：开启后该 key 的请求不写生成历史、不上传对象存储、站内不可查看，
    // 仅保留扣费/审核/额度计数。用于保护用户隐私、不额外占用服务器存储。
    relayOnly: boolean("relay_only").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "external_api_key_revocation_inactive",
      sql`${table.revokedAt} IS NULL OR ${table.isActive} = false`
    ),
  ]
);
export type ExternalApiKey = typeof externalApiKey.$inferSelect;
export type NewExternalApiKey = typeof externalApiKey.$inferInsert;

// ============================================
// Image Generation
// ============================================

export const generationStatusEnum = pgEnum("generation_status", [
  "pending",
  "completed",
  "failed",
]);

export const generation = pgTable("generation", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  revisedPrompt: text("revised_prompt"),
  model: text("model").notNull(),
  size: text("size").notNull().default("1024x1024"),
  status: generationStatusEnum("status").notNull().default("pending"),
  storageKey: text("storage_key"),
  storageBucket: text("storage_bucket").default("generations"),
  fileSize: integer("file_size"),
  creditsConsumed: numeric("credits_consumed", {
    precision: 18,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  error: text("error"),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  // 画廊/历史/计数与每次读触发的 pending 过期维护扫描:在 686MB 的 generation 表上,
  // 把按 user / status 维度的查询从顺序扫转为有序索引扫描(迁移 0035)。
  index("generation_user_id_created_at_idx").on(table.userId, table.createdAt),
  index("generation_status_created_at_idx").on(table.status, table.createdAt),
  // 下拉模型列表与默认图库计数只读窄索引，避免每次解引用大 metadata/prompt 行。
  index("generation_user_model_idx").on(table.userId, table.model),
  index("generation_user_completed_storage_idx")
    .on(table.userId, table.createdAt)
    .where(sql`${table.status} = 'completed' AND ${table.storageKey} IS NOT NULL`),
  // 另有 generation_metadata_gin_idx —— metadata 的 jsonb_path_ops GIN 表达式索引,
  // 加速画廊 draft/upload 的 @? jsonpath 过滤。表达式索引以迁移 0035 的 SQL 为准
  // (Drizzle 对 (metadata::jsonb) 这类表达式索引声明支持不稳定,故此处仅注释登记)。
]);

export type Generation = typeof generation.$inferSelect;
export type NewGeneration = typeof generation.$inferInsert;
export type GenerationStatus = (typeof generationStatusEnum.enumValues)[number];

/**
 * generation 按 UTC 日汇总(迁移 0051),全局状态页"全站累计"的已结算前缀。
 *
 * 只收录早于"昨天 UTC 0 点"的日期,由内置任务 generation-daily-stats 维护
 * (apps/web/src/server/generation-daily-stats.ts):补齐新结算的日期,并按
 * refreshedAt 轮转重算旧日期以吸收硬删除 / 图片销毁对旧行的改写。各列口径与
 * 对 generation 直接聚合完全一致;本表是可重建的派生数据,不承载业务真相。
 *
 * @field day - UTC 日期(generation.created_at::date)
 * @field completedImages - 产图数:优先 metadata.outputImage.billableImageOutputCount,
 *   缺失时按 storage_key 是否存在计 1/0(与全局状态页窗口统计同口径)
 * @field refreshedAt - 该日最近一次重算时间(轮转重算按此挑最旧的日期)
 */
export const generationDailyStats = pgTable("generation_daily_stats", {
  day: date("day", { mode: "string" }).primaryKey(),
  total: integer("total").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  pending: integer("pending").notNull().default(0),
  completedImages: integer("completed_images").notNull().default(0),
  creditsConsumed: numeric("credits_consumed", {
    precision: 18,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  refreshedAt: timestamp("refreshed_at").notNull().defaultNow(),
});

export type GenerationDailyStats = typeof generationDailyStats.$inferSelect;

// ============================================
// 工单系统类型导出
// ============================================

export type Ticket = typeof ticket.$inferSelect;
export type NewTicket = typeof ticket.$inferInsert;

export type TicketMessage = typeof ticketMessage.$inferSelect;
export type NewTicketMessage = typeof ticketMessage.$inferInsert;

export type TicketAttachment = typeof ticketAttachment.$inferSelect;
export type NewTicketAttachment = typeof ticketAttachment.$inferInsert;

/** 用户角色类型 */
export type UserRole = (typeof userRoleEnum.enumValues)[number];

/** 工单类别类型 */
export type TicketCategory = (typeof ticketCategoryEnum.enumValues)[number];

/** 工单优先级类型 */
export type TicketPriority = (typeof ticketPriorityEnum.enumValues)[number];

/** 工单状态类型 */
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];

// ============================================
// MCP User API Keys
// ============================================
/**
 * MCP 用户密钥表 - 终端用户通过 MCP 协议访问图像生成等功能时使用的认证密钥
 *
 * 独立于 external_api_key（v1 API），二者互不干扰：
 * - external_api_key: 面向 v1 RESTful API
 * - mcp_api_key: 面向 MCP JSON-RPC 协议（用户侧）
 *
 * @field id - 唯一标识符
 * @field userId - 所属用户
 * @field name - 用户可自定义的 key 名称
 * @field keyPrefix - key 前缀（如 "mcp_"），用于快速识别类型
 * @field keyHash - SHA-256 哈希（唯一索引，鉴权热路径查找）
 * @field lastFour - 末四位明文（列表展示时脱敏显示）
 * @field isActive - 是否启用
 * @field lastUsedAt - 最近使用时间
 * @field revokedAt - 撤销时间（撤销后不可恢复）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const mcpApiKey = pgTable(
  "mcp_api_key",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default MCP key"),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastFour: text("last_four").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("mcp_api_key_key_hash_idx").on(table.keyHash),
    index("mcp_api_key_user_id_idx").on(table.userId),
  ],
);

export type McpApiKey = typeof mcpApiKey.$inferSelect;
export type NewMcpApiKey = typeof mcpApiKey.$inferInsert;

/** 升级折抵财务预留。订单、请求及单用户在途约束共同阻止重复兑现。 */
export const upgradeReservation = pgTable(
  "upgrade_reservation",
  {
    outTradeNo: text("out_trade_no")
      .primaryKey()
      .references(() => epayOrder.outTradeNo, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    clientRequestId: text("client_request_id").notNull(),
    state: text("state").notNull(),
    snapshot: json("snapshot").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    settledAt: timestamp("settled_at"),
    releaseReason: text("release_reason"),
    refundRef: text("refund_ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upgrade_reservation_user_request_unique").on(
      table.userId,
      table.clientRequestId
    ),
    uniqueIndex("upgrade_reservation_user_open_unique")
      .on(table.userId)
      .where(
        sql`${table.state} = 'held' OR (${table.state} = 'refund_pending' AND ${table.settledAt} IS NOT NULL)`
      ),
    uniqueIndex("upgrade_reservation_refund_ref_unique")
      .on(table.refundRef)
      .where(sql`${table.refundRef} IS NOT NULL`),
    index("upgrade_reservation_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.state} = 'held'`),
    check(
      "upgrade_reservation_state_check",
      sql`${table.state} IN ('held','settled','released','refund_pending','refunded')`
    ),
  ]
);

/** 被预留批次的关系索引：财务证据存续期间禁止删除原批次。 */
export const upgradeReservationBatch = pgTable(
  "upgrade_reservation_batch",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => creditsBatch.id, { onDelete: "restrict" }),
    outTradeNo: text("out_trade_no")
      .notNull()
      .references(() => upgradeReservation.outTradeNo, {
        onDelete: "restrict",
      }),
    amount: numeric("amount", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("upgrade_reservation_batch_order_unique").on(
      table.outTradeNo,
      table.batchId
    ),
    check("upgrade_reservation_batch_amount_check", sql`${table.amount} > 0`),
  ]
);

/** 同套餐并发下单别名仍绑定原终态，避免客户端重试时重新冻结。 */
export const upgradeReservationRequest = pgTable(
  "upgrade_reservation_request",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    clientRequestId: text("client_request_id").notNull(),
    outTradeNo: text("out_trade_no")
      .notNull()
      .references(() => upgradeReservation.outTradeNo, {
        onDelete: "restrict",
      }),
  },
  (table) => [
    uniqueIndex("upgrade_reservation_request_unique").on(
      table.userId,
      table.clientRequestId
    ),
  ]
);

/**
 * 生成退款持久意图：仅存财务标量，无 generation 外键以支持纯中转和可编辑文件。
 * 账本是金额真相；本表负责恢复投递。nextAttemptAt 同时是领取租期，attempts 隔离迟到确认。
 */
export const generationRefundOutbox = pgTable(
  "generation_refund_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    generationId: text("generation_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    requestedAmount: numeric("requested_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    targetCredits: numeric("target_credits", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    state: text("state")
      .notNull()
      .default("pending")
      .$type<"pending" | "settled">(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    settledAt: timestamp("settled_at"),
  },
  (table) => [
    uniqueIndex("generation_refund_outbox_user_ref_unique").on(
      table.userId,
      table.sourceRef
    ),
    index("generation_refund_outbox_due_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.state} = 'pending'`),
    index("generation_refund_outbox_task_idx").on(
      table.userId,
      table.generationId
    ),
    check(
      "generation_refund_outbox_state_check",
      sql`${table.state} IN ('pending', 'settled')`
    ),
    check(
      "generation_refund_outbox_amount_check",
      sql`${table.requestedAmount} >= 0 AND ${table.targetCredits} >= 0 AND ${table.attempts} >= 0`
    ),
  ]
);

/** 可编辑文件执行墓碑和结果引用；不保存 prompt、输入图、签名 URL、账号凭据或任意错误。 */
export const editableFileTask = pgTable(
  "editable_file_task",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull().unique(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    // 保留原 Key 身份，删除 Key 也不能使任务变成无 Key 可读。
    apiKeyId: text("api_key_id"),
    kind: text("kind").notNull().$type<"ppt" | "psd">(),
    requestFingerprint: text("request_fingerprint").notNull(),
    claimToken: text("claim_token").notNull(),
    state: text("state").notNull().$type<"prepared" | "running" | "completed" | "refund_pending" | "refunded" | "failed">(),
    quotedCredits: numeric("quoted_credits", { precision: 12, scale: 2, mode: "number" }).notNull(),
    resultReferences: json("result_references").$type<{
      conversationId: string;
      primary: { key: string; bucket: string };
      zip: { key: string; bucket: string } | null;
    }>(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("editable_file_task_due_idx").on(table.expiresAt, table.id)
      .where(sql`${table.state} IN ('prepared', 'running', 'refund_pending')`),
    check("editable_file_task_state_check", sql`${table.state} IN ('prepared', 'running', 'completed', 'refund_pending', 'refunded', 'failed')`),
    check("editable_file_task_kind_check", sql`${table.kind} IN ('ppt', 'psd')`),
    check("editable_file_task_amount_check", sql`${table.quotedCredits} >= 0`),
    check("editable_file_task_fingerprint_check", sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
    check("editable_file_task_result_check", sql`(${table.state} = 'completed') = (${table.resultReferences} IS NOT NULL)`),
  ]
);

/** 纯中转初始财务状态：正数消费同事务创建，无内容或 generation 外键；dispatched 不自动退款。 */
export const relayInitialCharge = pgTable(
  "relay_initial_charge",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    generationId: text("generation_id").notNull(),
    consumptionTransactionId: text("consumption_transaction_id")
      .notNull()
      .references(() => creditsTransaction.id),
    apiKeyId: text("api_key_id"),
    amount: numeric("amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    state: text("state")
      .notNull()
      .default("captured")
      .$type<
        "captured" | "dispatched" | "refund_pending" | "refund_enqueued"
      >(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("relay_initial_charge_user_generation_unique").on(
      table.userId,
      table.generationId
    ),
    uniqueIndex("relay_initial_charge_transaction_unique").on(
      table.consumptionTransactionId
    ),
    index("relay_initial_charge_due_idx")
      .on(table.expiresAt, table.id)
      .where(sql`${table.state} IN ('captured', 'refund_pending')`),
    check("relay_initial_charge_amount_check", sql`${table.amount} > 0`),
    check(
      "relay_initial_charge_state_check",
      sql`${table.state} IN ('captured', 'dispatched', 'refund_pending', 'refund_enqueued')`
    ),
  ]
);
