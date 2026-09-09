export type SettingCategory =
  | "general"
  | "auth"
  | "payment"
  | "plans"
  | "moderation"
  | "models"
  | "storage"
  | "mail"
  | "credits"
  | "analytics";

export type SettingValueType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "json";

export type SettingKey =
  | "NEXT_PUBLIC_APP_URL"
  | "NEXT_PUBLIC_APP_NAME"
  | "NEXT_PUBLIC_ASSET_PREFIX"
  | "APP_TIME_ZONE"
  | "MARKETING_SLA_STATUS_ENABLED"
  | "EXTERNAL_API_CORS_ENABLED"
  | "SELF_USE_MODE_ENABLED"
  | "REGISTRATION_FIXED_VERIFICATION_CODE"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "PAYMENT_PROVIDER"
  | "NEXT_PUBLIC_PAYMENT_PROVIDER"
  | "NEXT_PUBLIC_CREEM_PRICE_STARTER_MONTHLY"
  | "NEXT_PUBLIC_CREEM_PRICE_STARTER_YEARLY"
  | "NEXT_PUBLIC_CREEM_PRICE_PRO_MONTHLY"
  | "NEXT_PUBLIC_CREEM_PRICE_PRO_YEARLY"
  | "NEXT_PUBLIC_CREEM_PRICE_ULTRA_MONTHLY"
  | "NEXT_PUBLIC_CREEM_PRICE_ULTRA_YEARLY"
  | "NEXT_PUBLIC_CREEM_PRICE_ENTERPRISE_MONTHLY"
  | "NEXT_PUBLIC_CREEM_PRICE_ENTERPRISE_YEARLY"
  | "CREEM_API_KEY"
  | "CREEM_WEBHOOK_SECRET"
  | "EPAY_PID"
  | "EPAY_KEY"
  | "EPAY_API_URL"
  | "EPAY_NOTIFY_URL"
  | "EPAY_DEFAULT_PAYMENT_TYPE"
  | "NEXT_PUBLIC_EPAY_DEFAULT_PAYMENT_TYPE"
  | "BILLING_YEARLY_ENABLED"
  | "PLAN_CAPABILITY_MATRIX"
  | "PLAN_FREE_MAX_FILE_MB"
  | "PLAN_FREE_MAX_UPLOAD_MB"
  | "PLAN_STARTER_MAX_FILE_MB"
  | "PLAN_STARTER_MAX_UPLOAD_MB"
  | "PLAN_PRO_MAX_FILE_MB"
  | "PLAN_PRO_MAX_UPLOAD_MB"
  | "PLAN_ULTRA_MAX_FILE_MB"
  | "PLAN_ULTRA_MAX_UPLOAD_MB"
  | "PLAN_ENTERPRISE_MAX_FILE_MB"
  | "PLAN_ENTERPRISE_MAX_UPLOAD_MB"
  | "PLAN_STARTER_MONTHLY_AMOUNT"
  | "PLAN_STARTER_YEARLY_AMOUNT"
  | "PLAN_PRO_MONTHLY_AMOUNT"
  | "PLAN_PRO_YEARLY_AMOUNT"
  | "PLAN_ULTRA_MONTHLY_AMOUNT"
  | "PLAN_ULTRA_YEARLY_AMOUNT"
  | "PLAN_ENTERPRISE_MONTHLY_AMOUNT"
  | "PLAN_ENTERPRISE_YEARLY_AMOUNT"
  | "CREDIT_PACKAGE_MATRIX"
  | "ENTERPRISE_RESOURCE_PACK_CREDITS"
  | "ENTERPRISE_RESOURCE_PACK_PRICE"
  | "CONTENT_MODERATION_ENABLED"
  | "CONTENT_MODERATION_FAIL_CLOSED"
  | "CONTENT_MODERATION_PROVIDER"
  | "CONTENT_MODERATION_PROXY_URL"
  | "CONTENT_MODERATION_PROXY_SECRET"
  | "CONTENT_MODERATION_PROXY_GATEWAY_SECRET"
  | "CONTENT_MODERATION_PROXY_TIMEOUT_MS"
  | "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS"
  | "CONTENT_MODERATION_PUBLIC_BASE_URL"
  | "ALIYUN_MODERATION_ACCESS_KEY_ID"
  | "ALIYUN_MODERATION_ACCESS_KEY_SECRET"
  | "ALIYUN_MODERATION_REGION_ID"
  | "ALIYUN_MODERATION_ENDPOINT"
  | "ALIYUN_MODERATION_TEXT_REGION_ID"
  | "ALIYUN_MODERATION_TEXT_ENDPOINT"
  | "ALIYUN_MODERATION_TEXT_SERVICE"
  | "ALIYUN_MODERATION_IMAGE_REGION_ID"
  | "ALIYUN_MODERATION_IMAGE_ENDPOINT"
  | "ALIYUN_MODERATION_IMAGE_SERVICE"
  | "ALIYUN_MODERATION_TEXT_APP_ID"
  | "ALIYUN_MODERATION_IMAGE_APP_ID"
  | "OPENAI_MODERATION_API_KEY"
  | "OPENAI_MODERATION_MODEL"
  | "IMAGE_MODERATION_PROMPT_REPAIR_ENABLED"
  | "IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES"
  | "PLATFORM_RESPONSES_MODEL"
  | "PLATFORM_CHAT_MODEL"
  | "IMAGE_GENERATION_GLOBAL_CONCURRENCY"
  | "IMAGE_AGENT_MAX_ROUNDS"
  | "IMAGE_AGENT_FORCE_MAX_ROUNDS"
  | "IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED"
  | "IMAGE_FORCE_WEB_MIN_PIXELS"
  | "IMAGE_FORCE_WEB_MAX_PIXELS"
  | "CHATGPT_WEB_PROXY_URL"
  | "CHATGPT_WEB_PROXY_SECRET"
  | "CHATGPT_WEB_ACCOUNT_REFRESH_STALE_MINUTES"
  | "CHATGPT_WEB_ACCOUNT_REFRESH_LIMIT"
  | "IMAGE_BACKEND_MAX_ATTEMPTS"
  | "IMAGE_BACKEND_MAX_NO_IMAGE_OUTPUT_ATTEMPTS"
  | "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
  | "IMAGE_BACKEND_UNRECOVERABLE_ERROR_KEYWORDS"
  | "SUB2API_POSTGRES_URL"
  | "SUB2API_POSTGRES_SYNC_LIMIT"
  | "SUB2API_AUTO_SYNC_TASKS"
  | "STORAGE_ACCESS_KEY_ID"
  | "STORAGE_SECRET_ACCESS_KEY"
  | "STORAGE_ENDPOINT"
  | "STORAGE_REGION"
  | "STORAGE_BUCKET_NAME"
  | "NEXT_PUBLIC_AVATARS_BUCKET_NAME"
  | "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"
  | "GENERATION_IMAGE_RETENTION_HOURS"
  | "GENERATION_IMAGE_RETENTION_MODE"
  | "GENERATION_IMAGE_MAX_COUNT"
  | "LOCAL_STORAGE_PATH"
  | "EMAIL_PROVIDER"
  | "EMAIL_FROM"
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_SECURE"
  | "SMTP_USER"
  | "SMTP_PASS"
  | "RESEND_API_KEY"
  | "SUPPORT_TICKET_NOTIFICATION_EMAIL"
  | "REGISTRATION_EMAIL_ALLOWED_DOMAINS"
  | "REGISTRATION_EMAIL_BLOCK_PLUS_ALIASES"
  | "REGISTRATION_EMAIL_BLOCK_DOTTED_LOCAL_PARTS"
  | "REGISTRATION_BONUS_CREDITS"
  | "FREE_CREDITS_EXPIRY_DAYS"
  | "CREDITS_EXPIRY_DAYS"
  | "IMAGE_BASE_CREDITS_1024"
  | "IMAGE_BASE_CREDITS_4K"
  | "IMAGE_MODEL_MULTIPLIERS"
  | "IMAGE_SUPER_RESOLUTION_ENABLED"
  | "IMAGE_RESTORATION_ENABLED"
  | "EDITABLE_FILE_PPT_CREDITS"
  | "EDITABLE_FILE_PSD_CREDITS"
  | "ADMIN_SELF_CREDITS_GRANT_ENABLED"
  | "VIDEO_BASE_CREDITS_PER_SECOND"
  | "VIDEO_MODEL_MULTIPLIERS"
  | "NEXT_PUBLIC_GA_ID"
  | "NEXT_PUBLIC_SENTRY_DSN"
  | "SENTRY_AUTH_TOKEN"
  | "AXIOM_TOKEN"
  | "AXIOM_DATASET"
  | "INTERNAL_JOB_SCHEDULER_ENABLED"
  | "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES"
  | "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES"
  | "INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES"
  | "INTERNAL_JOB_WEB_ACCOUNTS_REPLENISH_INTERVAL_MINUTES"
  | "INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES"
  | "UPSTASH_REDIS_REST_URL"
  | "UPSTASH_REDIS_REST_TOKEN"
  | "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE"
  | "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE"
  | "RATE_LIMIT_AI_REQUESTS_PER_MINUTE"
  | "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE"
  | "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE"
  | "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE"
  | "CHATGPT_REGISTER_MOEMAIL_API_KEY"
  | "CHATGPT_REGISTER_MOEMAIL_BASE_URL"
  | "CHATGPT_REGISTER_MOEMAIL_DOMAIN"
  | "CHATGPT_REGISTER_DOMAINS"
  | "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED"
  | "CHATGPT_REGISTER_PROXY"
  | "CHATGPT_REGISTER_PROXY_DISABLED"
  | "CHATGPT_REGISTER_REFRESH_URL"
  | "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS"
  | "CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS"
  | "CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED"
  | "CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID"
  | "CHATGPT_REGISTER_POOL_MAINTAIN_TARGET"
  | "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN"
  | "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY";

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  category: SettingCategory;
  valueType: SettingValueType;
  secret?: boolean;
  requiresRestart?: boolean;
  requiresRebuild?: boolean;
  options?: Array<{ label: string; value: string }>;
  // 仅 valueType === "number" 有意义：经济/安全语义键的业务数值上下界。
  // 声明后由 coerceValue 在写入时做闭区间钳制（越界即拒绝），未声明的键行为不变。
  // WHY: S-C1 已把这些键写入收紧为 superAdminAction，但缺数值上下界仍可写入
  // 负积分/负价格/异常巨大值，造成经济或安全语义破坏；此处补 per-key 范围校验。
  min?: number;
  max?: number;
  defaultValue?: unknown;
  exampleValue?: unknown;
}

const PLAN_CAPABILITY_MATRIX_EXAMPLE = {
  version: 1,
  features: {
    "imageGeneration.text": "free",
    "imageGeneration.edit": "free",
    "imageGeneration.chat": "pro",
    "imageGeneration.agent": "pro",
    "imageGeneration.waterfall": "pro",
    "imageGeneration.batch": "free",
    "export.ppt": "free",
    "export.psd": "free",
    "promptOptimization.control": "pro",
    "models.premium": "ultra",
    "customApi.configure": "starter",
    "backendGroups.select": "free",
    "externalApi.keys.manage": "starter",
    "externalApi.models.list": "starter",
    "externalApi.chat.completions": "starter",
    "externalApi.images.generate": "starter",
    "externalApi.images.edit": "starter",
    "externalApi.responses": "pro",
    "externalApi.agent": "ultra",
    "externalApi.streaming": "starter",
    "externalApi.relay": "pro",
    "moderation.blocking": "free",
    "moderation.onlyFailureSettlement": "ultra",
  },
  limits: {
    free: {
      maxFileMb: 5,
      maxUploadMb: 75,
      queuePriority: "normal",
      imageGenerationConcurrency: 2,
      monthlyCredits: 100,
      maxBatchCount: 10,
      maxEditImages: 16,
      maxChatImages: 16,
      maxChatContextChars: 30000,
    },
    starter: {
      maxFileMb: 20,
      maxUploadMb: 75,
      queuePriority: "normal",
      imageGenerationConcurrency: 5,
      monthlyCredits: 5000,
      maxBatchCount: 10,
      maxEditImages: 16,
      maxChatImages: 16,
      maxChatContextChars: 30000,
    },
    pro: {
      maxFileMb: 50,
      maxUploadMb: 75,
      queuePriority: "priority",
      imageGenerationConcurrency: 15,
      monthlyCredits: 20000,
      maxBatchCount: 10,
      maxEditImages: 16,
      maxChatImages: 16,
      maxChatContextChars: 30000,
    },
    ultra: {
      maxFileMb: 100,
      maxUploadMb: 100,
      queuePriority: "highest",
      imageGenerationConcurrency: 50,
      monthlyCredits: 80000,
      maxBatchCount: 10,
      maxEditImages: 16,
      maxChatImages: 16,
      maxChatContextChars: 30000,
    },
    enterprise: {
      maxFileMb: 200,
      maxUploadMb: 200,
      queuePriority: "highest",
      imageGenerationConcurrency: 100,
      monthlyCredits: 320000,
      maxBatchCount: 10,
      maxEditImages: 16,
      maxChatImages: 16,
      maxChatContextChars: 30000,
    },
  },
  moderation: {
    free: {
      defaultBlockRiskLevel: "low",
      maxBlockRiskLevel: "low",
    },
    starter: {
      defaultBlockRiskLevel: "low",
      maxBlockRiskLevel: "low",
    },
    pro: {
      defaultBlockRiskLevel: "low",
      maxBlockRiskLevel: "low",
    },
    ultra: {
      defaultBlockRiskLevel: "medium",
      maxBlockRiskLevel: "medium",
    },
    enterprise: {
      defaultBlockRiskLevel: "high",
      maxBlockRiskLevel: "high",
    },
  },
  billing: {
    free: {
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    },
    starter: {
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    },
    pro: {
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    },
    ultra: {
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    },
    enterprise: {
      chatRoundCredits: 1,
      agentRoundCredits: 3,
    },
  },
};

const CREDIT_PACKAGE_MATRIX_EXAMPLE = {
  packages: [
    {
      id: "payg_starter",
      name: "Pay as you go",
      nameZh: "按量付费",
      description: "One-time credits priced like Starter",
      descriptionZh: "与入门版同价同积分的一次性积分包",
      credits: 5000,
      price: 20,
      popular: true,
      visible: true,
      allowQuantity: false,
      pricesByPlan: {
        free: 20,
        starter: 20,
        pro: 20,
        ultra: 20,
        enterprise: 20,
      },
    },
    {
      id: "enterprise_resource",
      name: "Enterprise Resource Pack",
      nameZh: "企业资源包",
      description: "Enterprise-only 5,000-credit resource pack",
      descriptionZh: "企业版专属资源包，可按数量购买",
      credits: 5000,
      price: 15,
      visible: false,
      requiresPlan: "enterprise",
      allowQuantity: true,
      maxQuantity: 999,
      pricesByPlan: {
        enterprise: 15,
      },
    },
  ],
};

export const SYSTEM_SETTING_DEFINITIONS = [
  {
    key: "NEXT_PUBLIC_APP_URL",
    label: "应用地址",
    description: "Web 站点公开访问地址，用于回调、邮件链接和图片 URL。",
    category: "general",
    valueType: "string",
    requiresRestart: true,
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_APP_NAME",
    label: "应用名称",
    description: "公开展示的应用名称，用于邮件、页面和通知。",
    category: "general",
    valueType: "string",
    defaultValue: "GPT2IMAGE",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_ASSET_PREFIX",
    label: "静态资源前缀",
    description: "Next.js assetPrefix。用于 CDN 或静态资源版本路径。",
    category: "general",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "APP_TIME_ZONE",
    label: "显示时区",
    description:
      "后台和用户界面的时间展示、运营状态页日期筛选使用的 IANA 时区。数据库仍按 UTC 存储。",
    category: "general",
    valueType: "select",
    options: [
      { label: "UTC", value: "UTC" },
      { label: "中国标准时间 (Asia/Shanghai)", value: "Asia/Shanghai" },
      { label: "香港时间 (Asia/Hong_Kong)", value: "Asia/Hong_Kong" },
      { label: "新加坡时间 (Asia/Singapore)", value: "Asia/Singapore" },
      { label: "日本时间 (Asia/Tokyo)", value: "Asia/Tokyo" },
      {
        label: "太平洋时间 (America/Los_Angeles)",
        value: "America/Los_Angeles",
      },
      { label: "东部时间 (America/New_York)", value: "America/New_York" },
      { label: "伦敦时间 (Europe/London)", value: "Europe/London" },
    ],
    defaultValue: "UTC",
  },
  {
    key: "MARKETING_SLA_STATUS_ENABLED",
    label: "首页 SLA 展示",
    description:
      "控制主页是否展示生图服务 SLA 区块。管理员和超管可在首页直接关闭或开启；观察管理员只读。",
    category: "general",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "EXTERNAL_API_CORS_ENABLED",
    label: "外部 API 跨域(CORS)",
    description:
      "控制外部 API(/v1、/api/v1)是否允许浏览器跨域调用。开启后对所有来源开放(Access-Control-Allow-Origin: *,Bearer 鉴权不带 cookie,不开启凭据);关闭则不返回跨域头,浏览器跨域被拦,服务端直连不受影响。",
    category: "general",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "SELF_USE_MODE_ENABLED",
    label: "自用模式",
    description:
      "默认开启。开启后禁止公开注册；启动时没有超管会创建本地随机密码超管；超管按 Enterprise 套餐获得全部套餐能力。",
    category: "auth",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "REGISTRATION_FIXED_VERIFICATION_CODE",
    label: "固定注册邀请码",
    description:
      "配置后，邮箱密码注册改用同一个服务端邀请码，不发送邮件验证码。建议仅用于小范围受邀开放并定期轮换。",
    category: "auth",
    valueType: "string",
    secret: true,
  },
  {
    key: "BETTER_AUTH_SECRET",
    label: "认证 Cookie 密钥",
    description: "Better Auth 会话签名密钥，修改后已有会话可能失效。",
    category: "auth",
    valueType: "string",
    secret: true,
    requiresRestart: true,
  },
  {
    key: "BETTER_AUTH_URL",
    label: "认证服务地址",
    description: "Better Auth 基础 URL，OAuth 回调依赖此值。",
    category: "auth",
    valueType: "string",
    requiresRestart: true,
  },
  {
    key: "GOOGLE_CLIENT_ID",
    label: "Google Client ID",
    description: "Google OAuth 客户端 ID。",
    category: "auth",
    valueType: "string",
    requiresRestart: true,
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: "Google Client Secret",
    description: "Google OAuth 客户端密钥。",
    category: "auth",
    valueType: "string",
    secret: true,
    requiresRestart: true,
  },
  {
    key: "GITHUB_CLIENT_ID",
    label: "GitHub Client ID",
    description: "GitHub OAuth 客户端 ID。",
    category: "auth",
    valueType: "string",
    requiresRestart: true,
  },
  {
    key: "GITHUB_CLIENT_SECRET",
    label: "GitHub Client Secret",
    description: "GitHub OAuth 客户端密钥。",
    category: "auth",
    valueType: "string",
    secret: true,
    requiresRestart: true,
  },
  {
    key: "PAYMENT_PROVIDER",
    label: "支付通道",
    description: "选择 Creem 或易支付;自用模式可选「不启用」。",
    category: "payment",
    valueType: "select",
    options: [
      { label: "不启用(自用)", value: "none" },
      { label: "Creem", value: "creem" },
      { label: "易支付", value: "epay" },
    ],
    defaultValue: "creem",
  },
  {
    key: "NEXT_PUBLIC_PAYMENT_PROVIDER",
    label: "前端支付通道",
    description: "前端展示用支付通道，应与支付通道保持一致;自用模式可选「不启用」。",
    category: "payment",
    valueType: "select",
    options: [
      { label: "不启用(自用)", value: "none" },
      { label: "Creem", value: "creem" },
      { label: "易支付", value: "epay" },
    ],
    defaultValue: "creem",
    requiresRebuild: true,
  },
  {
    key: "CREEM_API_KEY",
    label: "Creem API Key",
    description: "Creem 支付接口密钥。",
    category: "payment",
    valueType: "string",
    secret: true,
  },
  {
    key: "CREEM_WEBHOOK_SECRET",
    label: "Creem Webhook Secret",
    description: "Creem Webhook 签名密钥。",
    category: "payment",
    valueType: "string",
    secret: true,
  },
  {
    key: "EPAY_PID",
    label: "易支付商户 ID",
    description: "易支付 pid。",
    category: "payment",
    valueType: "string",
  },
  {
    key: "EPAY_KEY",
    label: "易支付商户密钥",
    description: "易支付签名密钥。",
    category: "payment",
    valueType: "string",
    secret: true,
  },
  {
    key: "EPAY_API_URL",
    label: "易支付接口地址",
    description: "易支付网关地址。",
    category: "payment",
    valueType: "string",
  },
  {
    key: "EPAY_NOTIFY_URL",
    label: "易支付异步通知地址",
    description: "留空则使用应用地址自动生成。",
    category: "payment",
    valueType: "string",
  },
  {
    key: "EPAY_DEFAULT_PAYMENT_TYPE",
    label: "易支付默认方式",
    description: "如 alipay、wxpay。",
    category: "payment",
    valueType: "string",
    defaultValue: "alipay",
  },
  {
    key: "NEXT_PUBLIC_EPAY_DEFAULT_PAYMENT_TYPE",
    label: "前端易支付默认方式",
    description: "前端展示用默认支付方式，应与易支付默认方式保持一致。",
    category: "payment",
    valueType: "string",
    defaultValue: "alipay",
    requiresRebuild: true,
  },
  {
    key: "BILLING_YEARLY_ENABLED",
    label: "开放年付",
    description: "关闭后用户不能选择年付套餐。",
    category: "plans",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "PLAN_CAPABILITY_MATRIX",
    label: "套餐能力矩阵",
    description:
      "统一控制套餐功能门槛、积分配额、上传限制、批量数量、并发、队列优先级、审核能力和 Chat/Agent 每轮计费。后台以矩阵表格编辑，保存后仍写入同一个 JSON 配置。功能门槛按最低套餐生效，高级套餐自动包含低级套餐能力。留空时使用代码默认矩阵，并兼容旧上传/月积分配置。",
    category: "plans",
    valueType: "json",
    exampleValue: PLAN_CAPABILITY_MATRIX_EXAMPLE,
  },
  {
    key: "PLAN_STARTER_MONTHLY_AMOUNT",
    label: "Starter 月付价格",
    description: "Starter 月付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    // WHY: 价格必须为正，且设上限拦截误输入的天文数字；读取侧 positive:true 已兜底，
    // 此处在写入时即拒绝 0/负数/异常巨大值，避免脏配置落库。
    min: 0.01,
    max: 1_000_000,
    defaultValue: 20,
  },
  {
    key: "PLAN_STARTER_YEARLY_AMOUNT",
    label: "Starter 年付价格",
    description: "Starter 年付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 144,
  },
  {
    key: "PLAN_PRO_MONTHLY_AMOUNT",
    label: "Pro 月付价格",
    description: "Pro 月付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 60,
  },
  {
    key: "PLAN_PRO_YEARLY_AMOUNT",
    label: "Pro 年付价格",
    description: "Pro 年付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 432,
  },
  {
    key: "PLAN_ULTRA_MONTHLY_AMOUNT",
    label: "Ultra 月付价格",
    description: "Ultra 月付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 200,
  },
  {
    key: "PLAN_ULTRA_YEARLY_AMOUNT",
    label: "Ultra 年付价格",
    description: "Ultra 年付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 1440,
  },
  {
    key: "PLAN_ENTERPRISE_MONTHLY_AMOUNT",
    label: "Enterprise 月付价格",
    description: "Enterprise 月付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 800,
  },
  {
    key: "PLAN_ENTERPRISE_YEARLY_AMOUNT",
    label: "Enterprise 年付价格",
    description: "Enterprise 年付价格，单位 CNY。",
    category: "plans",
    valueType: "number",
    min: 0.01,
    max: 1_000_000,
    defaultValue: 5760,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_STARTER_MONTHLY",
    label: "Creem Starter 月付 Price ID",
    description: "Creem Starter 月付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_STARTER_YEARLY",
    label: "Creem Starter 年付 Price ID",
    description: "Creem Starter 年付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_PRO_MONTHLY",
    label: "Creem Pro 月付 Price ID",
    description: "Creem Pro 月付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_PRO_YEARLY",
    label: "Creem Pro 年付 Price ID",
    description: "Creem Pro 年付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_ULTRA_MONTHLY",
    label: "Creem Ultra 月付 Price ID",
    description: "Creem Ultra 月付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_ULTRA_YEARLY",
    label: "Creem Ultra 年付 Price ID",
    description: "Creem Ultra 年付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_ENTERPRISE_MONTHLY",
    label: "Creem Enterprise 月付 Price ID",
    description: "Creem Enterprise 月付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_CREEM_PRICE_ENTERPRISE_YEARLY",
    label: "Creem Enterprise 年付 Price ID",
    description: "Creem Enterprise 年付产品/价格 ID。",
    category: "plans",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "CONTENT_MODERATION_ENABLED",
    label: "开启内容审核",
    description: "控制文本/图片审核总开关。",
    category: "moderation",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "CONTENT_MODERATION_FAIL_CLOSED",
    label: "审核异常时拦截",
    description: "开启后审核服务不可用时拒绝请求；关闭后失败放行。",
    category: "moderation",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "CONTENT_MODERATION_PROVIDER",
    label: "审核服务商",
    description: "选择阿里云、OpenAI、自动或关闭。",
    category: "moderation",
    valueType: "select",
    options: [
      { label: "自动", value: "auto" },
      { label: "阿里云", value: "aliyun" },
      { label: "OpenAI", value: "openai" },
      { label: "关闭", value: "none" },
    ],
    defaultValue: "auto",
  },
  {
    key: "CONTENT_MODERATION_PROXY_URL",
    label: "审核代理地址",
    description: "可选，先请求代理审核服务。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "CONTENT_MODERATION_PROXY_SECRET",
    label: "审核代理密钥",
    description: "审核代理鉴权密钥。",
    category: "moderation",
    valueType: "string",
    secret: true,
  },
  {
    key: "CONTENT_MODERATION_PROXY_GATEWAY_SECRET",
    label: "审核网关密钥",
    description: "外部网关调用本站审核代理时使用的密钥。",
    category: "moderation",
    valueType: "string",
    secret: true,
  },
  {
    key: "CONTENT_MODERATION_PROXY_TIMEOUT_MS",
    label: "审核代理超时 ms",
    description: "审核代理请求超时时间。",
    category: "moderation",
    valueType: "number",
    // WHY: 审核超时是安全语义键，必须为正（>=1ms），否则审核请求会立即超时；
    // fail-closed 时会全量拦截，fail-open 时会全量放行，两种都危险。上限 5 分钟。
    min: 1,
    max: 300_000,
    defaultValue: 10000,
  },
  {
    key: "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS",
    label: "审核服务超时 ms",
    description: "直接请求审核服务商的超时时间。",
    category: "moderation",
    valueType: "number",
    // WHY: 同审核代理超时，直接请求审核服务商的超时同为安全语义键，须为正并设上限。
    min: 1,
    max: 300_000,
    defaultValue: 10000,
  },
  {
    key: "CONTENT_MODERATION_PUBLIC_BASE_URL",
    label: "审核图片公开地址",
    description:
      "图片审核临时文件公开基础地址。使用本地存储且审核服务需要公网图片 URL 时，用它拼接 /api/storage/...；对象存储签名 URL 已是公网地址时可留空。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_ACCESS_KEY_ID",
    label: "阿里云 AccessKey ID",
    description: "阿里云内容安全 AccessKey ID。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_ACCESS_KEY_SECRET",
    label: "阿里云 AccessKey Secret",
    description: "阿里云内容安全 AccessKey Secret。",
    category: "moderation",
    valueType: "string",
    secret: true,
  },
  {
    key: "ALIYUN_MODERATION_TEXT_REGION_ID",
    label: "阿里云文本 Region",
    description: "文本审核专用 Region。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_TEXT_ENDPOINT",
    label: "阿里云文本 Endpoint",
    description: "文本审核专用 Endpoint。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_TEXT_SERVICE",
    label: "阿里云文本服务",
    description: "阿里云文本审核 service code。",
    category: "moderation",
    valueType: "string",
    defaultValue: "ugc_moderation_byllm_cb",
  },
  {
    key: "ALIYUN_MODERATION_IMAGE_REGION_ID",
    label: "阿里云图片 Region",
    description: "图片审核专用 Region。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_IMAGE_ENDPOINT",
    label: "阿里云图片 Endpoint",
    description: "图片审核专用 Endpoint。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "ALIYUN_MODERATION_IMAGE_SERVICE",
    label: "阿里云图片服务",
    description: "图片审核服务 code。",
    category: "moderation",
    valueType: "string",
  },
  {
    key: "OPENAI_MODERATION_API_KEY",
    label: "OpenAI 审核 API Key",
    description: "OpenAI moderation 使用的密钥。",
    category: "moderation",
    valueType: "string",
    secret: true,
  },
  {
    key: "OPENAI_MODERATION_MODEL",
    label: "OpenAI 审核模型",
    description: "默认 omni-moderation-latest。",
    category: "moderation",
    valueType: "string",
    defaultValue: "omni-moderation-latest",
  },
  {
    key: "IMAGE_MODERATION_PROMPT_REPAIR_ENABLED",
    label: "审核失败自动修剪重试",
    description:
      "检测到审核拦截后，使用可用的 Codex/Responses 账号或外接 /responses API 修剪提示词，并在同一任务内重新发起请求。",
    category: "moderation",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES",
    label: "审核修剪最大重试轮数",
    description:
      "每个生图任务因审核失败触发提示词修剪并重试的最大次数。0 表示关闭，建议 1-3。",
    category: "moderation",
    valueType: "number",
    defaultValue: 1,
  },
  {
    key: "PLATFORM_RESPONSES_MODEL",
    label: "默认对话模型",
    description: "对话生图使用的 Responses 模型。",
    category: "models",
    valueType: "string",
  },
  {
    key: "PLATFORM_CHAT_MODEL",
    label: "备用对话模型",
    description: "兼容旧配置。",
    category: "models",
    valueType: "string",
  },
  {
    key: "IMAGE_GENERATION_GLOBAL_CONCURRENCY",
    label: "全局生图并发",
    description:
      "整站同时执行的生图任务硬上限。套餐能力矩阵中的生图并发仍按单用户限制；实际启动任务时必须同时满足全局并发和单用户并发。",
    category: "models",
    valueType: "number",
    defaultValue: 500,
  },
  {
    key: "IMAGE_AGENT_MAX_ROUNDS",
    label: "Agent 最大自动迭代轮数",
    description:
      "页面 Agent 模式单次请求内最多执行多少轮 Responses 调用。每轮可继续联网、分析附件或生成下一版图片，用于模拟 Codex 式自发迭代。",
    category: "models",
    valueType: "number",
    defaultValue: 3,
  },
  {
    key: "IMAGE_AGENT_FORCE_MAX_ROUNDS",
    label: "Agent 强制跑满迭代轮数",
    description:
      "默认关闭，由模型 continue_generation 工具和本站自检逻辑决定是否继续。开启后，只要本轮未失败且未达到最大轮数，就继续执行下一轮。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED",
    label: "Responses previous_response_id 续接",
    description:
      "关闭时沿用本站手动历史重建。开启后，内部 Chat/Agent 的 Codex/Responses 会保存 response；命中同一后端账号时用 previous_response_id 续接，失败则回退手动历史。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "IMAGE_FORCE_WEB_MIN_PIXELS",
    label: "Web-first 最小像素数",
    description:
      "外接 image API 传入 web_first / webFirst / force_web / forceWeb，或页面开启 mixed Web-first 时，只有请求尺寸总像素大于等于该值才会优先调度 Web 账号。默认 660000，约 0.66MP；Web 不可用或失败会降级 Codex/Responses。",
    category: "models",
    valueType: "number",
    defaultValue: 660000,
  },
  {
    key: "IMAGE_FORCE_WEB_MAX_PIXELS",
    label: "Web-first 最大像素数",
    description:
      "外接 image API 传入 web_first / webFirst / force_web / forceWeb，或页面开启 mixed Web-first 时，只有请求尺寸总像素小于等于该值才会优先调度 Web 账号。默认 2000000，约 2MP；4K 请求默认不会优先 Web。",
    category: "models",
    valueType: "number",
    defaultValue: 2000000,
  },
  {
    key: "CHATGPT_WEB_PROXY_URL",
    label: "ChatGPT Web TLS 代理地址",
    description:
      "可选。配置后 Web 账号请求会经 Go tls-client sidecar 转发，例如 http://chatgpt-web-proxy:3021。",
    category: "models",
    valueType: "string",
  },
  {
    key: "CHATGPT_WEB_PROXY_SECRET",
    label: "ChatGPT Web TLS 代理密钥",
    description: "可选。请求 sidecar 时写入 X-Proxy-Secret。",
    category: "models",
    valueType: "string",
    secret: true,
  },
  {
    key: "CHATGPT_WEB_ACCOUNT_REFRESH_STALE_MINUTES",
    label: "Web 账号刷新间隔分钟",
    description: "后台任务刷新超过该时间未同步额度的 Web 账号。",
    category: "models",
    valueType: "number",
    defaultValue: 30,
  },
  {
    key: "CHATGPT_WEB_ACCOUNT_REFRESH_LIMIT",
    label: "Web 账号单次刷新数量",
    description: "后台任务每次最多刷新多少个 Web 账号。",
    category: "models",
    valueType: "number",
    defaultValue: 20,
  },
  {
    key: "IMAGE_BACKEND_MAX_ATTEMPTS",
    label: "单次生图后端最大尝试数",
    description:
      "一次生成请求最多尝试多少个账号/API 后端。达到上限后返回最后一次真实错误，避免遍历大池直至 20 分钟超时。",
    category: "models",
    valueType: "number",
    min: 1,
    max: 100,
    defaultValue: 8,
  },
  {
    key: "IMAGE_BACKEND_MAX_NO_IMAGE_OUTPUT_ATTEMPTS",
    label: "无图输出最大尝试数",
    description:
      "同一次生成出现 no image output/no image data 时最多尝试的后端数量。此类失败通常与请求或上游任务相关，继续遍历账号收益很低。",
    category: "models",
    valueType: "number",
    min: 1,
    max: 20,
    defaultValue: 3,
  },
  {
    key: "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES",
    label: "后端默认恢复分钟",
    description:
      "生图后端错误没有命中更具体规则时的默认冷却时间。未配置时为 15 分钟。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES",
    label: "后端 429 兜底恢复分钟",
    description:
      "账号/API 返回 429、rate limit、too many requests 时的兜底冷却时间；如上游返回 Retry-After 或 reset 时间，会优先按上游时间恢复。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES",
    label: "后端画图工具限流恢复分钟",
    description:
      "ChatGPT 账号画图工具被限流(image_gen.text2im / ChatGPTAgentToolRateLimitException)时的兜底冷却时间;此类为账号级滚动限流、恢复快,未配置时为 3 分钟;如上游返回 Retry-After 或 reset 时间,会优先按上游时间恢复。",
    category: "models",
    valueType: "number",
    defaultValue: 3,
  },
  {
    key: "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES",
    label: "后端 529/过载兜底恢复分钟",
    description:
      "账号/API 返回 529、overloaded、temporarily unavailable、server overloaded 时的冷却时间；过载类错误不使用上游 reset 时间。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES",
    label: "后端额度限制兜底恢复分钟",
    description:
      "账号/API 返回 usage limit、quota exceeded、insufficient quota、billing hard limit 时的兜底冷却时间；如上游返回 Retry-After、resetAt、reset_at、reset_after、restoreAt 等恢复时间，会优先按上游时间恢复。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES",
    label: "后端模型不支持兜底恢复分钟",
    description:
      "账号额度未用完但返回不支持该模型、model not supported、unsupported model 时的冷却时间；模型不支持错误不使用上游 reset 时间。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES",
    label: "后端临时错误兜底恢复分钟",
    description:
      "超时、连接失败、500、502、503、504 等临时错误的冷却时间；临时错误不使用上游 reset 时间。",
    category: "models",
    valueType: "number",
    defaultValue: 15,
  },
  {
    key: "IMAGE_BACKEND_UNRECOVERABLE_ERROR_KEYWORDS",
    label: "后端不可恢复错误关键词",
    description:
      "命中这些关键词时，账号/API 会直接标记为错误并跳过后续调度。支持用逗号、换行或分号分隔。",
    category: "models",
    valueType: "string",
    defaultValue:
      "refresh token, invalid refresh token, invalid_grant, authentication, account deactivated, deactivated account",
  },
  {
    key: "SUB2API_POSTGRES_URL",
    label: "Sub2API Postgres 地址",
    description:
      "连接 Sub2API 数据库，用于读取当前 AT/RT，并在 Web AT 刷新后回写最新 refresh_token。需要 accounts.credentials 更新权限。",
    category: "models",
    valueType: "string",
    secret: true,
  },
  {
    key: "SUB2API_POSTGRES_SYNC_LIMIT",
    label: "Sub2API 单次同步账号数",
    description: "从 Sub2API 数据库单次最多读取多少个 OpenAI OAuth 账号。",
    category: "models",
    valueType: "number",
    defaultValue: 100,
  },
  {
    key: "STORAGE_ACCESS_KEY_ID",
    label: "存储 AccessKey ID",
    description: "S3/R2/MinIO AccessKey ID。",
    category: "storage",
    valueType: "string",
  },
  {
    key: "STORAGE_SECRET_ACCESS_KEY",
    label: "存储 Secret AccessKey",
    description: "S3/R2/MinIO Secret。",
    category: "storage",
    valueType: "string",
    secret: true,
  },
  {
    key: "STORAGE_ENDPOINT",
    label: "存储 Endpoint",
    description: "S3 兼容存储 endpoint。留空使用本地存储。",
    category: "storage",
    valueType: "string",
  },
  {
    key: "STORAGE_REGION",
    label: "存储 Region",
    description: "默认 auto。",
    category: "storage",
    valueType: "string",
    defaultValue: "auto",
  },
  {
    key: "STORAGE_BUCKET_NAME",
    label: "上传 Bucket",
    description: "通用上传 bucket。",
    category: "storage",
    valueType: "string",
  },
  {
    key: "NEXT_PUBLIC_AVATARS_BUCKET_NAME",
    label: "头像 Bucket",
    description: "头像文件 bucket。",
    category: "storage",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME",
    label: "生成图片 Bucket",
    description: "生成图片文件 bucket。",
    category: "storage",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "GENERATION_IMAGE_RETENTION_MODE",
    label: "图片清理模式",
    description:
      "选择如何清理生成图片文件：关闭=永久保存（默认）；按时间=超过“照片销毁时间（小时）”后删除；按张数=每个用户各自仅保留最新的若干张，删除其更老的。清理只删图片文件与图库展示，生成记录与计费流水仍保留。",
    category: "storage",
    valueType: "select",
    options: [
      { label: "关闭（永久保存）", value: "off" },
      { label: "按时间过期", value: "time" },
      { label: "按每用户最大张数", value: "count" },
    ],
    defaultValue: "off",
  },
  {
    key: "GENERATION_IMAGE_RETENTION_HOURS",
    label: "照片销毁时间（小时）",
    description:
      "生成图片文件的保留时长；填 0 表示永久保存。仅在清理模式为“按时间过期”时生效。过期后只删除图片文件和图库展示，生成记录与计费流水仍保留。",
    category: "storage",
    valueType: "number",
    defaultValue: 0,
  },
  {
    key: "GENERATION_IMAGE_MAX_COUNT",
    label: "每用户最大保留张数",
    description:
      "“按每用户最大张数”模式下，每个用户各自保留的已生成图片张数上限；该用户超出后从其最老的开始删除（按用户独立计数，不是全站合计）。仅在清理模式为“按每用户最大张数”时生效。",
    category: "storage",
    valueType: "number",
    defaultValue: 10000,
    min: 1,
  },
  {
    key: "LOCAL_STORAGE_PATH",
    label: "本地存储路径",
    description: "未启用 S3 时的本地文件目录。",
    category: "storage",
    valueType: "string",
  },
  {
    key: "REGISTRATION_EMAIL_ALLOWED_DOMAINS",
    label: "注册邮箱域名白名单",
    description:
      "允许注册的邮箱域名，使用逗号、空格或换行分隔；填写域名本身，无需 @。发验证码、邮箱注册和 OAuth 首次建号都会执行此限制。",
    category: "mail",
    valueType: "string",
    defaultValue: "163.com,126.com,qq.com,gmail.com",
  },
  {
    key: "REGISTRATION_EMAIL_BLOCK_PLUS_ALIASES",
    label: "禁止 + 别名邮箱",
    description:
      "开启后，禁止邮箱用户名（@ 前部分）包含 +，例如 user+tag@gmail.com。",
    category: "mail",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "REGISTRATION_EMAIL_BLOCK_DOTTED_LOCAL_PARTS",
    label: "禁止点号别名邮箱",
    description:
      "开启后，禁止邮箱用户名（@ 前部分）包含点号，例如 user.name@gmail.com；域名中的点号不受影响。",
    category: "mail",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "EMAIL_PROVIDER",
    label: "邮件通道",
    description: "smtp 或 resend。",
    category: "mail",
    valueType: "select",
    options: [
      { label: "SMTP", value: "smtp" },
      { label: "Resend", value: "resend" },
    ],
  },
  {
    key: "EMAIL_FROM",
    label: "发件人",
    description: "如 GPT2IMAGE <noreply@example.com>。",
    category: "mail",
    valueType: "string",
  },
  {
    key: "SMTP_HOST",
    label: "SMTP Host",
    description: "SMTP 服务器地址。",
    category: "mail",
    valueType: "string",
  },
  {
    key: "SMTP_PORT",
    label: "SMTP Port",
    description: "默认 465。",
    category: "mail",
    valueType: "number",
    defaultValue: 465,
  },
  {
    key: "SMTP_SECURE",
    label: "SMTP SSL",
    description: "是否使用 SSL。",
    category: "mail",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "SMTP_USER",
    label: "SMTP 用户名",
    description: "SMTP 登录用户名。",
    category: "mail",
    valueType: "string",
  },
  {
    key: "SMTP_PASS",
    label: "SMTP 密码",
    description: "SMTP 登录密码。",
    category: "mail",
    valueType: "string",
    secret: true,
  },
  {
    key: "RESEND_API_KEY",
    label: "Resend API Key",
    description: "Resend 邮件 API Key。",
    category: "mail",
    valueType: "string",
    secret: true,
  },
  {
    key: "SUPPORT_TICKET_NOTIFICATION_EMAIL",
    label: "工单通知邮箱",
    description:
      "有用户新建工单或追加回复时，发送新动态提醒到这个邮箱；留空则不发送。",
    category: "mail",
    valueType: "string",
  },
  {
    key: "REGISTRATION_BONUS_CREDITS",
    label: "注册奖励积分",
    description: "新用户首次进入账户时发放的积分。",
    category: "credits",
    valueType: "number",
    // WHY: 注册奖励积分允许为 0（关闭赠送），但禁止负数（会发负积分），并设上限
    // 拦截误填的天文数字，避免一次性发放异常巨量积分造成经济损失。
    min: 0,
    max: 1_000_000,
    defaultValue: 100,
  },
  {
    key: "FREE_CREDITS_EXPIRY_DAYS",
    label: "免费积分有效期天数",
    description: "注册奖励和管理员赠送等免费积分的默认有效期。",
    category: "credits",
    valueType: "number",
    defaultValue: 7,
  },
  {
    key: "CREDITS_EXPIRY_DAYS",
    label: "积分包有效期天数",
    description:
      "按量购买积分默认有效期；填 0 表示永不过期。免费积分和订阅积分使用各自规则。",
    category: "credits",
    valueType: "number",
    defaultValue: 0,
  },
  {
    key: "IMAGE_BASE_CREDITS_1024",
    label: "1024x1024 基础生图积分",
    description:
      "不含文本/图片审核成本的 1024x1024 生图基础价格。其他分辨率会在该价格与 4K 基础价格之间按像素数线性推算；低于 1024x1024 按该价格封底。",
    category: "credits",
    valueType: "number",
    // WHY: 生图基础积分价格直接决定每次扣费，必须为正；上限拦截误填的异常巨大值，
    // 避免单次扣费失控。
    min: 0.01,
    max: 100_000,
    defaultValue: 1.27,
  },
  {
    key: "IMAGE_BASE_CREDITS_4K",
    label: "4K 基础生图积分",
    description:
      "不含文本/图片审核成本的 3840x2160 / 2160x3840 生图基础价格。1024x1024 到 4K 之间按像素数线性推算；高于 4K 按该价格封顶。",
    category: "credits",
    valueType: "number",
    // WHY: 同 IMAGE_BASE_CREDITS_1024，4K 基础价格须为正并设上限。
    min: 0.01,
    max: 100_000,
    defaultValue: 10,
  },
  {
    key: "IMAGE_SUPER_RESOLUTION_ENABLED",
    label: "出图分辨率超分校准",
    description:
      "开启后，上游返回图小于请求尺寸时自动对齐目标边界：明显偏小时用 Real-ESRGAN，接近目标时用轻量缩放（不裁剪、不改宽高比）。仅对最终图和 Web 候选成品触发，Agent 中间草稿不处理；默认关闭。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "IMAGE_RESTORATION_ENABLED",
    label: "出图高清修复（SCUNet）",
    description:
      "开启后，用户在创作时勾选「高清修复」的最终图会用 SCUNet 盲复原（去噪/去压缩块/增强质感，不改分辨率）。CPU 推理较重（512 约 11 秒、1024 约 35 秒），有全局串行闸防并发打满机器；需用户手动勾选、仅对最终图触发；默认关闭。与「超分校准」独立：修复在原分辨率跑、超分再放大。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "EDITABLE_FILE_PPT_CREDITS",
    label: "生成 PPT 扣积分",
    description:
      "对话式生成可编辑 PPT 文件每次扣的积分(按任务固定价)。默认 25;设 0 则不扣费。",
    category: "credits",
    valueType: "number",
    min: 0,
    max: 100_000,
    defaultValue: 25,
  },
  {
    key: "ADMIN_SELF_CREDITS_GRANT_ENABLED",
    label: "管理员给自己充值",
    description:
      "控制普通管理员能否在用户管理中给自己发放积分（超管始终允许）。默认开启；关闭后普通管理员给自己充值会被拒绝（防铸币）。",
    category: "credits",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "EDITABLE_FILE_PSD_CREDITS",
    label: "生成 PSD 扣积分",
    description:
      "对话式生成可编辑 PSD 文件每次扣的积分(按任务固定价)。默认 25;设 0 则不扣费。",
    category: "credits",
    valueType: "number",
    min: 0,
    max: 100_000,
    defaultValue: 25,
  },
  {
    key: "IMAGE_MODEL_MULTIPLIERS",
    label: "图像模型族倍率",
    description:
      '按 firefly 图像模型族设置计费倍率的 JSON（family → 倍率，缺省/非正回退 1）。键为 firefly 图像族：gpt-image-2、gpt-image-1.5、nano-banana、nano-banana2、nano-banana-pro。例：{"gpt-image-2":2,"nano-banana-pro":1.5}。',
    category: "credits",
    valueType: "json",
    exampleValue: '{"gpt-image-2": 1, "nano-banana-pro": 1.5}',
  },
  {
    key: "VIDEO_BASE_CREDITS_PER_SECOND",
    label: "视频每秒基础积分",
    description:
      "Adobe Firefly 视频生成的统一基础价格（每秒积分）。一次视频成本 = 每秒基价 × 时长(秒) × 模型族倍率。",
    category: "credits",
    valueType: "number",
    // WHY: 视频计费基价须为正；上限拦截误填的异常巨大值，避免单次扣费失控。
    min: 0.01,
    max: 100_000,
    defaultValue: 30,
  },
  {
    key: "VIDEO_MODEL_MULTIPLIERS",
    label: "视频模型族倍率",
    description:
      '按视频模型族设置计费倍率的 JSON（family → 倍率，缺省/非正回退 1）。例：{"sora2-pro":2,"veo31-fast":0.5}。',
    category: "credits",
    valueType: "json",
    exampleValue: '{"sora2": 1, "sora2-pro": 2, "veo31": 1.5}',
  },
  {
    key: "CREDIT_PACKAGE_MATRIX",
    label: "按量积分包配置",
    description:
      "表格配置一次性积分包的中英文名称与说明、积分数、显示状态、最低可购买套餐、数量购买、各套餐价格和 Creem 产品 ID。保存后仍写入同一 JSON 配置；Epay 会直接按站内价格收款，Creem 按套餐定价时需要配置对应预建产品 ID。",
    category: "credits",
    valueType: "json",
    exampleValue: CREDIT_PACKAGE_MATRIX_EXAMPLE,
  },
  {
    key: "NEXT_PUBLIC_GA_ID",
    label: "Google Analytics ID",
    description: "GA Measurement ID。",
    category: "analytics",
    valueType: "string",
    requiresRebuild: true,
  },
  {
    key: "NEXT_PUBLIC_SENTRY_DSN",
    label: "Sentry DSN",
    description: "Sentry 监控 DSN。",
    category: "analytics",
    valueType: "string",
    secret: true,
    requiresRebuild: true,
  },
  {
    key: "SENTRY_AUTH_TOKEN",
    label: "Sentry Auth Token",
    description: "Sentry sourcemap 上传 Token。",
    category: "analytics",
    valueType: "string",
    secret: true,
    requiresRebuild: true,
  },
  {
    key: "AXIOM_TOKEN",
    label: "Axiom Token",
    description: "Axiom 日志采集 Token。",
    category: "analytics",
    valueType: "string",
    secret: true,
  },
  {
    key: "AXIOM_DATASET",
    label: "Axiom Dataset",
    description: "Axiom 日志数据集名称。",
    category: "analytics",
    valueType: "string",
    defaultValue: "gpt2image",
  },
  {
    key: "INTERNAL_JOB_SCHEDULER_ENABLED",
    label: "内置定时任务",
    description:
      "启用后 Web 进程会自动执行 pending 超时、照片清理、积分过期、Web 账号刷新和 Sub2API 同步任务；多实例会用数据库锁避免重复执行。",
    category: "general",
    valueType: "boolean",
    defaultValue: true,
  },
  {
    key: "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES",
    label: "图片维护任务间隔（分钟）",
    description: "pending 超时退款和照片销毁清理的内置执行间隔。",
    category: "general",
    valueType: "number",
    defaultValue: 5,
  },
  {
    key: "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES",
    label: "积分过期任务间隔（分钟）",
    description: "过期积分批次处理的内置执行间隔。",
    category: "general",
    valueType: "number",
    defaultValue: 1440,
  },
  {
    key: "INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES",
    label: "Web 账号刷新任务间隔（分钟）",
    description: "ChatGPT Web 账号状态刷新的内置执行间隔。",
    category: "general",
    valueType: "number",
    defaultValue: 10,
  },
  {
    key: "INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES",
    label: "Sub2API 同步检查间隔（分钟）",
    description:
      "内置调度器检查 Sub2API 自动同步任务的间隔；实际是否同步仍受 Sub2API 自动同步任务自身间隔控制。",
    category: "general",
    valueType: "number",
    defaultValue: 10,
  },
  {
    key: "UPSTASH_REDIS_REST_URL",
    label: "Upstash Redis URL",
    description: "限流 Redis REST URL。",
    category: "general",
    valueType: "string",
  },
  {
    key: "UPSTASH_REDIS_REST_TOKEN",
    label: "Upstash Redis Token",
    description: "限流 Redis REST Token。",
    category: "general",
    valueType: "string",
    secret: true,
  },
  {
    key: "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE",
    label: "全局限流（次/分钟）",
    description:
      "全局请求限流阈值。配置 Upstash Redis 后生效；未配置 Upstash 时跳过限流。",
    category: "general",
    valueType: "number",
    defaultValue: 100,
    requiresRestart: true,
  },
  {
    key: "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE",
    label: "认证限流（次/分钟）",
    description:
      "登录、注册、找回密码等认证接口的每分钟请求阈值。配置 Upstash Redis 后生效。",
    category: "general",
    valueType: "number",
    defaultValue: 5,
    requiresRestart: true,
  },
  {
    key: "RATE_LIMIT_AI_REQUESTS_PER_MINUTE",
    label: "AI 与生图限流（次/分钟）",
    description:
      "页面生图、图生图、Chat/Agent 的每分钟请求阈值。外接 /v1 生图接口走套餐并发队列，不受该通用频率限制。",
    category: "general",
    valueType: "number",
    defaultValue: 20,
    requiresRestart: true,
  },
  {
    key: "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE",
    label: "支付限流（次/分钟）",
    description:
      "支付相关接口的每分钟请求阈值。配置 Upstash Redis 后生效。",
    category: "general",
    valueType: "number",
    defaultValue: 10,
    requiresRestart: true,
  },
  {
    key: "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE",
    label: "上传限流（次/分钟）",
    description:
      "文件上传接口的每分钟请求阈值。配置 Upstash Redis 后生效。",
    category: "general",
    valueType: "number",
    defaultValue: 30,
    requiresRestart: true,
  },
  {
    key: "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE",
    label: "严格限流（次/分钟）",
    description:
      "敏感操作的严格每分钟请求阈值。配置 Upstash Redis 后生效。",
    category: "general",
    valueType: "number",
    defaultValue: 3,
    requiresRestart: true,
  },
  {
    key: "CHATGPT_REGISTER_MOEMAIL_API_KEY",
    label: "注册机 Moemail API Key",
    description: "ChatGPT 账号注册机使用的 Moemail 临时邮箱服务 API Key。",
    category: "models",
    valueType: "string",
    secret: true,
  },
  {
    key: "CHATGPT_REGISTER_MOEMAIL_BASE_URL",
    label: "注册机 Moemail 服务地址",
    description: "Moemail 临时邮箱服务的 API 地址，默认 https://mail.52ai.org。",
    category: "models",
    valueType: "string",
    defaultValue: "https://mail.52ai.org",
  },
  {
    key: "CHATGPT_REGISTER_MOEMAIL_DOMAIN",
    label: "注册机邮箱域名",
    description: "注册时使用的临时邮箱域名，例如 pt.sanyela.shop。",
    category: "models",
    valueType: "string",
  },
  {
    key: "CHATGPT_REGISTER_DOMAINS",
    label: "注册机可用域名列表",
    description:
      "点「查询可用域名」时自动保存的 moemail 可用域名（逗号分隔），供「轮换域名」使用。",
    category: "models",
    valueType: "string",
  },
  {
    key: "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED",
    label: "注册机轮换域名",
    description:
      "开启后每一轮注册从已保存的域名列表中轮换取一个不同域名，避免单域名被拉黑。需先查询并保存域名列表。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "CHATGPT_REGISTER_PROXY",
    label: "注册机代理地址",
    description: "注册机 HTTP 代理，格式 http://user:pass@host:port。",
    category: "models",
    valueType: "string",
    secret: true,
  },
  {
    key: "CHATGPT_REGISTER_PROXY_DISABLED",
    label: "注册机禁用代理（直连本机 IP）",
    description:
      "开启后注册机不走代理、直连本机 IP（同时跳过 IP 刷新）。代理地址保留不动，仅本开关控制是否启用。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "CHATGPT_REGISTER_REFRESH_URL",
    label: "注册机代理 IP 刷新地址",
    description:
      "动态代理 IP 刷新端点（GET 请求即换 IP）。留空则不刷新。",
    category: "models",
    valueType: "string",
    secret: true,
  },
  {
    key: "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
    label: "注册机 IP 刷新最小间隔（秒）",
    description:
      "两次 IP 刷新之间的最小时间间隔。实际刷新取本项与「最小尝试数」的慢者。",
    category: "models",
    valueType: "number",
    defaultValue: 60,
  },
  {
    key: "CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS",
    label: "注册机 IP 刷新最小尝试数",
    description:
      "两次 IP 刷新之间至少累计的注册尝试数。实际刷新取本项与「最小间隔」的慢者。",
    category: "models",
    valueType: "number",
    defaultValue: 100,
  },
  {
    key: "CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED",
    label: "号池自动维持开关",
    description:
      "开启后，定时任务会在目标分组可用 web 账号数低于目标值时自动注册补号。",
    category: "models",
    valueType: "boolean",
    defaultValue: false,
  },
  {
    key: "CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID",
    label: "号池维持目标分组",
    description: "自动维持可用数的目标分组 ID；新注册账号也导入该分组。",
    category: "models",
    valueType: "string",
  },
  {
    key: "CHATGPT_REGISTER_POOL_MAINTAIN_TARGET",
    label: "号池维持目标可用数",
    description: "目标分组要维持的可用 web 账号数量。低于此值时自动补号。",
    category: "models",
    valueType: "number",
    defaultValue: 0,
  },
  {
    key: "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN",
    label: "号池维持每轮最多注册数",
    description: "单次维持任务最多发起的注册数量，避免一次性突发过多。",
    category: "models",
    valueType: "number",
    defaultValue: 10,
  },
  {
    key: "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY",
    label: "号池维持注册并发",
    description: "自动补号时传给注册机的并发数。",
    category: "models",
    valueType: "number",
    defaultValue: 5,
  },
  {
    key: "INTERNAL_JOB_WEB_ACCOUNTS_REPLENISH_INTERVAL_MINUTES",
    label: "号池维持任务间隔（分钟）",
    description: "号池自动维持（补号）任务的内置执行间隔。",
    category: "general",
    valueType: "number",
    defaultValue: 15,
  },
] as const satisfies readonly SettingDefinition[];

export const SETTING_DEFINITION_BY_KEY = new Map<SettingKey, SettingDefinition>(
  SYSTEM_SETTING_DEFINITIONS.map((definition) => [definition.key, definition])
);

export const SETTING_CATEGORIES: Array<{
  id: SettingCategory;
  label: string;
  description: string;
}> = [
  {
    id: "general",
    label: "基础",
    description: "站点地址、内置任务和限流等全局配置。",
  },
  {
    id: "auth",
    label: "登录",
    description: "Better Auth 与第三方 OAuth 配置。",
  },
  {
    id: "payment",
    label: "支付",
    description: "支付通道、Creem 和易支付密钥。",
  },
  {
    id: "plans",
    label: "套餐",
    description: "年付开关、套餐价格和积分额度。",
  },
  {
    id: "moderation",
    label: "审核",
    description: "文本/图片审核服务和密钥。",
  },
  {
    id: "models",
    label: "模型",
    description: "默认模型 API、密钥和模型名。",
  },
  {
    id: "storage",
    label: "存储",
    description: "S3/R2/MinIO 与本地存储配置。",
  },
  {
    id: "mail",
    label: "邮件",
    description: "注册邮箱规则以及 SMTP 或 Resend 邮件配置。",
  },
  {
    id: "credits",
    label: "积分",
    description: "注册奖励和积分有效期规则。",
  },
  {
    id: "analytics",
    label: "监控",
    description: "统计与错误监控配置。",
  },
];

export function isSettingKey(value: string): value is SettingKey {
  return SETTING_DEFINITION_BY_KEY.has(value as SettingKey);
}
