/**
 * 全局状态页加载骨架屏。
 *
 * 状态页是 force-dynamic 且聚合较重(冷缓存约 3s)。没有 loading 边界时,App Router
 * 客户端导航会"阻塞"等 RSC 返回才切页——期间停留在旧页、链接像点了没反应("点不动")。
 * 此骨架在导航时立即显示,给出即时反馈;数据就绪后无缝替换为真实内容。
 * 结构对齐 page.tsx:页头 + 4 列指标卡 + 两栏明细块。
 */
const METRIC_PLACEHOLDERS = ["usage", "latency", "success", "queue"];
const PANEL_PLACEHOLDERS = [
  {
    key: "services",
    rows: [
      "services-a",
      "services-b",
      "services-c",
      "services-d",
      "services-e",
    ],
  },
  {
    key: "backends",
    rows: [
      "backends-a",
      "backends-b",
      "backends-c",
      "backends-d",
      "backends-e",
    ],
  },
];

export default function GlobalStatusLoading() {
  return (
    <div className="container mx-auto animate-pulse space-y-8 px-4 py-6 motion-reduce:animate-none md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="h-7 w-40 rounded bg-muted" />
          <div className="h-4 w-80 max-w-full rounded bg-muted" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-20 rounded bg-muted" />
          <div className="h-8 w-44 rounded bg-muted" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {METRIC_PLACEHOLDERS.map((key) => (
          <div key={key} className="space-y-3 rounded-lg border p-5">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-8 w-20 rounded bg-muted" />
            <div className="h-3 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {PANEL_PLACEHOLDERS.map((panel) => (
          <div key={panel.key} className="space-y-4 rounded-lg border p-6">
            <div className="h-5 w-32 rounded bg-muted" />
            {panel.rows.map((row) => (
              <div key={row} className="h-4 w-full rounded bg-muted" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
