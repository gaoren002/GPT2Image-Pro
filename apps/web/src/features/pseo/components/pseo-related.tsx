import { Badge } from "@repo/ui/components/badge";
import { Card, CardContent } from "@repo/ui/components/card";
import { ArrowUpRight } from "lucide-react";
import { Link } from "@/i18n/routing";

import type { PseoPage } from "../lib/pseo-data";

interface PseoRelatedProps {
  pages: PseoPage[];
  title: string;
  subtitle: string;
}

export function PseoRelated({ pages, title, subtitle }: PseoRelatedProps) {
  if (pages.length === 0) {
    return null;
  }

  return (
    // 白底节:与前方浅底 FAQ 交替,节奏对齐营销页 py-20/28
    <section className="container py-20 md:py-28" id="related">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center">
          <h2 className="mb-4 text-balance font-serif text-3xl font-medium tracking-tight md:text-4xl">
            {title}
          </h2>
          <p className="mx-auto max-w-2xl leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
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
                  {/* 链接文案随页面语言切换,与 pseo 索引页同一份文案 */}
                  <Link
                    href={`/pseo/${page.slug}`}
                    className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {page.locale === "zh" ? "查看模板" : "View template"}
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
