import { Badge } from "@repo/ui/components/badge";
import { Card, CardContent } from "@repo/ui/components/card";
import { ArrowUpRight, Database, LayoutTemplate, Route } from "lucide-react";
import { getPseoPages } from "@/features/pseo/lib/pseo-data";
import { Link } from "@/i18n/routing";

export default async function PseoIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const pages = getPseoPages(locale);
  const isZh = locale === "zh";

  const overviewCards = isZh
    ? [
        {
          title: "JSON 数据驱动",
          description: "每个 PSEO 页面都来自结构化 JSON 配置。",
          icon: Database,
        },
        {
          title: "复用页面模块",
          description: "Hero、特性、场景、FAQ、CTA 可复用组合。",
          icon: LayoutTemplate,
        },
        {
          title: "多语言输出",
          description: "自动匹配当前语言版本内容。",
          icon: Route,
        },
      ]
    : [
        {
          title: "JSON-first data",
          description:
            "Every PSEO page is generated from structured JSON fields.",
          icon: Database,
        },
        {
          title: "Reusable sections",
          description:
            "Hero, features, use cases, FAQ, and CTA reuse the same UI blocks.",
          icon: LayoutTemplate,
        },
        {
          title: "Locale-aware",
          description:
            "Switch locales to render the matching content automatically.",
          icon: Route,
        },
      ];

  return (
    <section className="container py-20 md:py-28">
      <div className="mx-auto mb-16 flex max-w-4xl flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <Badge
          variant="outline"
          className="mb-4 rounded-full border-border px-4 py-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground"
        >
          PSEO Framework
        </Badge>
        <h1 className="text-balance font-serif text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl">
          {isZh ? "PSEO 框架演示库" : "Programmatic SEO Demo Library"}
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {isZh
            ? "所有模板均由 JSON 数据驱动，可快速扩展到成百上千个落地页。"
            : "Templates are generated from JSON data and reusable UI blocks. Add entries to scale to thousands of landing pages."}
        </p>
      </div>

      <div className="mx-auto mb-16 grid max-w-5xl gap-6 md:grid-cols-3">
        {overviewCards.map((card, index) => {
          const Icon = card.icon;
          return (
            // 概览卡入场错峰:按索引 80ms 递增,fill-mode backwards 防闪现
            <Card
              key={card.title}
              className="border-border bg-background shadow-none animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
              style={{
                animationDelay: `${120 + index * 80}ms`,
                animationFillMode: "backwards",
              }}
            >
              <CardContent className="p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-foreground/5 text-foreground">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mb-2 text-base font-medium">{card.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {card.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="font-serif text-2xl font-medium tracking-tight md:text-3xl">
              {isZh ? "可用模板" : "Available templates"}
            </h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              {isZh
                ? "选择任意模板查看完整的 PSEO 落地页。"
                : "Pick any template to view the full PSEO landing page."}
            </p>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {pages.map((page) => (
            <Card
              key={page.slug}
              className="group border-border bg-background shadow-none lift-hover"
            >
              <CardContent className="flex h-full flex-col p-6">
                <div className="mb-4 flex items-center justify-between">
                  <Badge variant="secondary">{page.category}</Badge>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
                </div>
                <h3 className="mb-2 text-lg font-medium">
                  {page.data.hero.title} {page.data.hero.highlight}
                </h3>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  {page.data.seo.description}
                </p>
                <div className="mt-auto">
                  <Link
                    href={`/pseo/${page.slug}`}
                    className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {isZh ? "查看模板" : "View template"}
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
