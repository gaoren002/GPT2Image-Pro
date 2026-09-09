import { Card, CardContent } from "@repo/ui/components/card";
import {
  Layers,
  LineChart,
  Share2,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Zap,
} from "lucide-react";

import type { PseoPage } from "../lib/pseo-data";

const iconMap = {
  sparkles: Sparkles,
  target: Target,
  lineChart: LineChart,
  share: Share2,
  layers: Layers,
  shield: ShieldCheck,
  zap: Zap,
  users: Users,
};

type IconKey = keyof typeof iconMap;

export function PseoFeatureGrid({ page }: { page: PseoPage }) {
  const { sections, features } = page.data;

  return (
    // 全幅浅底节:对齐营销页 py-20/28 与明暗交替的书页节奏
    <section
      className="border-y border-border/60 bg-secondary/50 py-20 md:py-28"
      id="features"
    >
      <div className="container">
        <div className="mx-auto max-w-6xl">
          <div className="mb-16 text-center">
            {/* 眉标 - v2 小标签规范,沿用分类文案 */}
            <p className="mb-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {page.category}
            </p>
            <h2 className="mb-4 text-balance font-serif text-3xl font-medium tracking-tight md:text-4xl">
              {sections.features.title}
            </h2>
            <p className="mx-auto max-w-2xl leading-relaxed text-muted-foreground">
              {sections.features.subtitle}
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => {
              const Icon = iconMap[feature.icon as IconKey] ?? Sparkles;
              return (
                // 白纸卡浮在浅底节上,hover 轻抬升 + 边框提亮 + shadow-whisper
                <Card
                  key={feature.title}
                  className="group border-border bg-background shadow-none lift-hover"
                >
                  <CardContent className="p-6">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-foreground/5 text-foreground transition-colors duration-150 group-hover:bg-foreground group-hover:text-background">
                      <Icon className="h-6 w-6" />
                    </div>
                    <h3 className="mb-2 text-base font-medium">
                      {feature.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
