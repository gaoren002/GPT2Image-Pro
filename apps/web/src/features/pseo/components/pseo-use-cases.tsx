import { Card, CardContent } from "@repo/ui/components/card";

import type { PseoPage } from "../lib/pseo-data";

export function PseoUseCases({ page }: { page: PseoPage }) {
  const { sections, useCases } = page.data;

  return (
    // 白底节:与前后浅底节形成明暗交替,节奏对齐营销页 py-20/28
    <section className="container py-20 md:py-28" id="use-cases">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center">
          <h2 className="mb-4 text-balance font-serif text-3xl font-medium tracking-tight md:text-4xl">
            {sections.useCases.title}
          </h2>
          <p className="mx-auto max-w-2xl leading-relaxed text-muted-foreground">
            {sections.useCases.subtitle}
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {useCases.map((useCase) => (
            <Card
              key={useCase.title}
              className="border-border bg-background shadow-none lift-hover"
            >
              <CardContent className="flex h-full flex-col p-6">
                <h3 className="text-lg font-medium text-foreground">
                  {useCase.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {useCase.description}
                </p>
                <div className="mt-auto pt-6">
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif text-3xl font-medium tracking-tight text-foreground">
                      {useCase.metric}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {useCase.metricLabel}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
