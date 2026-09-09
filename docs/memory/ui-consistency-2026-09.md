# UI 一致性治理记录（2026-09-09）

> 大规模 UI 美化与简化的落地记录。分三批提交：`78bc0ec`+`5448b26`（基建）、`f2ca662`（营销/设置第一批）、`eedc159`（Dashboard/管理第二批）。

## 设计语言（全站统一基准）

- 风格：黑白墨纸（GPT 配色），全站衬线（Noto Serif），无彩色徽章/渐变（功能性遮罩除外）。
- 圆角节奏：`rounded-sm(8) / md(12) / lg(18) / xl(24)`；弹窗 `rounded-lg`，卡片 `rounded-lg`，信息小卡/提示条 `rounded-md`，行内元素 `rounded-sm`。**禁止 rounded-2xl/3xl 出现在通用 UI**（首页影片舞台等特例除外）。
- 阴影 token：`shadow-whisper`（悬浮卡面/sticky 头）/ `shadow-menu`（下拉）/ `shadow-modal`（真正挡交互的弹窗）/ `shadow-xs`（按钮默认）。**shadow-sm/shadow-lg 已退役**。
- 动效：easing token `--ease-ink`（进场）/ `--ease-out-quart`（hover）；工具类 `animate-fade-up / animate-fade-up-sm / animate-fade-in / animate-ink-sweep / stagger / lift-hover / skeleton-shimmer`（全部在 packages/ui/src/globals.css，遵守 prefers-reduced-motion）。hover 过渡统一 `duration-200`（颜色类 150）。
- Tab 语言：全站胶囊（TabsList 组件默认类，rounded-full + border + bg-muted/40）。下划线风已全站退役。
- 眉标/小标签：`text-[11px] font-medium uppercase tracking-widest`。
- 页头：衬线 `text-3xl font-medium tracking-tight`（dashboard/admin/settings 统一）。
- 状态徽章：色底配方 `bg-success/10 text-success`、`bg-warning/10 text-warning`（不用灰底+彩字）。
- 加载态：路由级骨架对齐 dashboard/loading.tsx 基准（容器不带 max-w、py-6、rounded-md）；组件级用 `@repo/ui` 的 Skeleton。
- 首页谷段 section：`py-20 md:py-28`，标题 `text-3xl md:text-4xl`。

## PlanBadge 黑白化

`packages/shared/src/subscription/components/plan-badge.tsx` + `plan-badge.css` 已重写：彩色底/渐变/彩色 glow 全部退役，改墨色浓度递进（free 最浅 → enterprise 纯黑反白），动效三种黑白微动效（sweep/breathe/glint）。

## 已知遗留（低优先级）

- create-page-client.tsx 内仍有大量手写字段标签（`text-xs font-medium text-muted-foreground`），与 settings 的 uppercase fieldLabelClass 是两套语言；解释为创作页密度场景差异，暂保留。
- Loader2 尺寸 h-3.5/h-4/h-5 混用，未规格化。
- pricing 轮播两侧功能性渐变遮罩保留（唯一渐变特例）。
- 表格两实现并存：原生 table（admin/system-settings）与 div-grid（billing history）；未统一。
- lint 存量基线：web 包 7 errors / 118 warnings（历史债，未阻断）。

## 测试稳定性备注

`pnpm --filter @repo/web test`（vitest 并行）在满载机器上偶发 3 个用例超时假失败（service-web-fallback 2 + responses-streaming 1，根因是 web 满并发短等 sleep(300ms)×3 在并行调度下放大）；单跑或 `--fileParallelism=false` 均全绿（612/612）。CI 单文件串行不受影响。
