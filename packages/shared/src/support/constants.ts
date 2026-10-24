/** 工单表单与管理列表共用的纯常量，不加载服务端 Zod schema。 */
export const MAX_TICKET_ATTACHMENTS = 4;
export const MAX_TICKET_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * 工单类别选项
 */
export const ticketCategories = [
  { value: "billing", label: "账单问题" },
  { value: "technical", label: "技术支持" },
  { value: "bug", label: "Bug 报告" },
  { value: "feature", label: "功能建议" },
  { value: "other", label: "其他" },
] as const;

/**
 * 工单优先级选项
 */
export const ticketPriorities = [
  { value: "low", label: "低", color: "bg-green-500" },
  { value: "medium", label: "中", color: "bg-yellow-500" },
  { value: "high", label: "高", color: "bg-red-500" },
] as const;

/**
 * 工单状态选项
 */
export const ticketStatuses = [
  { value: "open", label: "待处理", color: "bg-blue-500" },
  { value: "in_progress", label: "处理中", color: "bg-yellow-500" },
  { value: "resolved", label: "已解决", color: "bg-green-500" },
  { value: "closed", label: "已关闭", color: "bg-gray-500" },
] as const;
