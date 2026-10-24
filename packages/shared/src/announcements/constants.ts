/** 公告列表和编辑表单共用的纯展示常量；避免客户端为读取选项加载 Zod。 */
export const announcementSeverities = [
  { value: "info", label: "普通" },
  { value: "success", label: "更新" },
  { value: "warning", label: "重要" },
  { value: "critical", label: "紧急" },
] as const;

export type AnnouncementSeverity =
  (typeof announcementSeverities)[number]["value"];

export const announcementSeverityValues = announcementSeverities.map(
  (item) => item.value
) as [AnnouncementSeverity, ...AnnouncementSeverity[]];
