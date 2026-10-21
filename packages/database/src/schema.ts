import {
  boolean,
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
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
  amount: numeric("amount", { precision: 12, scale: 2, mode: "number" })
    .notNull(),
  status: text("status").notNull().default("pending"),
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
  ]
);

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
  // Adobe 来源：此 api 后端虽是 OpenAI/gpt 格式，但上游实际来自 Adobe。开启后：
  // 计费按 Adobe 口径（套用下方 billing_multiplier，与分组倍率相乘，复用伪账号倍率链）；
  // 调度上参与 firefly 候选（含 force_firefly 与显式 firefly-* 模型，后者经反向转换成
  // gpt 请求后由本后端处理）。默认关闭，关闭时按普通 api（不套成员倍率、不进 firefly 候选）。
  adobeSourced: boolean("adobe_sourced").notNull().default(false),
  // 计费倍率（与 image_backend_adobe.billing_multiplier 同义）；仅当 adobeSourced 为真时
  // 生效，与分组倍率相乘汇入 config.backend.billingMultiplier，作用于图像扣费。默认 1。
  billingMultiplier: numeric("billing_multiplier").notNull().default("1"),
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

// Adobe Firefly（adobe2api）后端：OpenAI 兼容网关，但模型/尺寸/视频形态与通用
// pool-api 不同（model id 编码宽高比+分辨率+时长、宽高比枚举、entities、视频），故
// 独立成表。调度字段（status/cooldown/并发/always_active/优先级）语义与 imageBackendApi
// 一致，复用同一套调度机制（租约/粘性/SLA 指标）。账号-token 池由 adobe2api 侧自管，
// 本表只持有 baseUrl + apiKey。
export const imageBackendAdobe = pgTable("image_backend_adobe", {
  id: text("id").primaryKey(),
  groupId: text("group_id").references(() => imageBackendGroup.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  // gateway：调外部 adobe2api（OpenAI 兼容，用 baseUrl+apiKey）。
  // direct：本仓库直连 Adobe Firefly（用 adobe_account/adobe_token + Go TLS 旁路）。
  mode: text("mode").notNull().default("gateway"),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  // 本后端暴露的 Firefly 图像模型家族（如 ["gpt-image","nano-banana-pro"]）；
  // 为空表示不限制。
  enabledModels: json("enabled_models").$type<string[]>(),
  // 站内 WxH 映射不出确定值时的默认宽高比/分辨率。
  defaultRatio: text("default_ratio").notNull().default("1x1"),
  defaultResolution: text("default_resolution").notNull().default("2k"),
  // 用户 GPT Image 质量选 auto/未指定时映射到的质量（low/medium/high）；默认 high。
  gptImageQuality: text("gpt_image_quality").notNull().default("high"),
  // 本 Adobe 后端的计费倍率（图像+视频统一）；与分组倍率相乘。默认 1（不改变）。
  billingMultiplier: numeric("billing_multiplier").notNull().default("1"),
  // 是否允许走视频模型（Phase 3）；默认关闭。
  supportsVideo: boolean("supports_video").notNull().default(false),
  contentSafetyEnabled: boolean("content_safety_enabled")
    .notNull()
    .default(true),
  isEnabled: boolean("is_enabled").notNull().default(true),
  // 与 imageBackendApi 同义：遇错也始终可用（终态错误除外，见调度器）。
  alwaysActive: boolean("always_active").notNull().default(false),
  priority: integer("priority").notNull().default(50),
  concurrency: integer("concurrency").notNull().default(10),
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

// Adobe 后端与分组的多对多关系（镜像 imageBackendApiGroup）。
export const imageBackendAdobeGroup = pgTable(
  "image_backend_adobe_group",
  {
    id: text("id").primaryKey(),
    adobeId: text("adobe_id")
      .notNull()
      .references(() => imageBackendAdobe.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => imageBackendGroup.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_adobe_group_adobe_group_unique").on(
      table.adobeId,
      table.groupId
    ),
    index("image_backend_adobe_group_group_idx").on(table.groupId),
  ]
);

// Adobe 账号（直连模式）：一行 = 一个 Adobe 账号的刷新档案，镜像 adobe2api 的
// refresh_profile.json。持有 cookie，用于换取短期 IMS access_token（写入 adobe_token）。
// 归属某个 imageBackendAdobe 后端（其账号池）。直连模式专用；网关模式不需要。
export const adobeAccount = pgTable(
  "adobe_account",
  {
    id: text("id").primaryKey(),
    adobeId: text("adobe_id")
      .notNull()
      .references(() => imageBackendAdobe.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Adobe 浏览器 cookie（IMS 刷新凭据）。无加密基建，按明文存（与 apiKey 一致）。
    cookie: text("cookie").notNull(),
    // 历史 IMS scope 配置；Express 协议固定使用上游默认值，保留列用于兼容旧数据。
    scope: text("scope"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    // IMS profile 拉到的账号信息。
    displayName: text("display_name"),
    email: text("email"),
    accountUserId: text("account_user_id"),
    // active / error / disabled。
    status: text("status").notNull().default("active"),
    lastRefreshAt: timestamp("last_refresh_at"),
    lastRefreshError: text("last_refresh_error"),
    nextRefreshAt: timestamp("next_refresh_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("adobe_account_adobe_idx").on(table.adobeId)]
);

// Adobe IMS access_token（直连模式）：短期 Bearer，由 adobe_account 的 cookie 刷新得到，
// 镜像 adobe2api 的 tokens.json。调度命中后端后在其 token 池里按策略轮换选取。
export const adobeToken = pgTable(
  "adobe_token",
  {
    id: text("id").primaryKey(),
    adobeId: text("adobe_id")
      .notNull()
      .references(() => imageBackendAdobe.id, { onDelete: "cascade" }),
    // 手动导入的 token 可无关联账号。
    accountId: text("account_id").references(() => adobeAccount.id, {
      onDelete: "cascade",
    }),
    // IMS access_token（明文，与 apiKey 一致）。
    value: text("value").notNull(),
    // 从 JWT 解出的 user_id（per-account 粘性 / entities 同账号约束用）。
    accountUserId: text("account_user_id"),
    // active / error / exhausted / invalid。
    status: text("status").notNull().default("active"),
    fails: integer("fails").notNull().default(0),
    source: text("source").notNull().default("auto_refresh"),
    expiresAt: timestamp("expires_at"),
    creditsTotal: integer("credits_total"),
    creditsUsed: integer("credits_used"),
    creditsAvailable: integer("credits_available"),
    creditsUpdatedAt: timestamp("credits_updated_at"),
    creditsError: text("credits_error"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("adobe_token_adobe_idx").on(table.adobeId),
    index("adobe_token_account_idx").on(table.accountId),
    index("adobe_token_adobe_status_idx").on(table.adobeId, table.status),
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
export const externalApiKey = pgTable("external_api_key", {
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
  // 纯中转模式：开启后该 key 的请求不写生成历史、不上传对象存储、站内不可查看，
  // 仅保留扣费/审核/额度计数。用于保护用户隐私、不额外占用服务器存储。
  relayOnly: boolean("relay_only").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  // 另有 generation_metadata_gin_idx —— metadata 的 jsonb_path_ops GIN 表达式索引,
  // 加速画廊 draft/upload 的 @? jsonpath 过滤。表达式索引以迁移 0035 的 SQL 为准
  // (Drizzle 对 (metadata::jsonb) 这类表达式索引声明支持不稳定,故此处仅注释登记)。
]);

export type Generation = typeof generation.$inferSelect;
export type NewGeneration = typeof generation.$inferInsert;
export type GenerationStatus = (typeof generationStatusEnum.enumValues)[number];

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
