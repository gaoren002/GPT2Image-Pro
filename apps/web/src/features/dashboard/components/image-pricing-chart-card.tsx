"use client";

import { formatCredits } from "@repo/shared/credits/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useRef, useState } from "react";
import {
  getImageBaseCreditPricing,
  getImageBaseCredits,
  DEFAULT_IMAGE_SIZE,
  IMAGE_1024_BASE_PIXELS,
  IMAGE_1K_BASE_SIZE,
  MAX_IMAGE_ASPECT_RATIO,
  MAX_IMAGE_PIXELS,
  MIN_IMAGE_DIMENSION,
  MIN_IMAGE_PIXELS,
  REFERENCE_CREDIT_PRICE_CNY,
  TEXT_MODERATION_PRICE_CNY,
  IMAGE_MODERATION_PRICE_CNY,
  type ImageBaseCreditPricing,
} from "@/features/image-generation/resolution";

type ImagePricingChartCardProps = {
  billing: {
    agentRoundCredits: number;
    chatRoundCredits: number;
    groupMultiplier: number;
    groupName: string | null;
    moderationBlockingEnabled: boolean;
    monthlyCredits: number;
    planName: string;
  };
  isZh: boolean;
  pricing: ImageBaseCreditPricing;
};

type PricingPoint = {
  baseCredits: number;
  label: string;
  megapixels: number;
  pixels: number;
  size: string;
};

const PRICING_POINTS = [
  {
    label: "Lower bound",
    size: "1024x640",
    pixels: MIN_IMAGE_PIXELS,
  },
  { label: "1024", size: "1024x1024", pixels: IMAGE_1024_BASE_PIXELS },
  {
    label: "1K",
    size: IMAGE_1K_BASE_SIZE,
    pixels: 1248 * 1248,
  },
  { label: "3:2", size: "1536x1024", pixels: 1536 * 1024 },
  { label: "2K", size: "2048x2048", pixels: 2048 * 2048 },
  { label: "3K", size: "3072x1728", pixels: 3072 * 1728 },
  { label: "4K", size: "3840x2160", pixels: MAX_IMAGE_PIXELS },
];

function buildChartData(pricing: ImageBaseCreditPricing): PricingPoint[] {
  return PRICING_POINTS.map((point) => ({
    ...point,
    baseCredits: getImageBaseCredits(point.pixels, pricing),
    megapixels: Number((point.pixels / 1_000_000).toFixed(2)),
  }));
}

function formatPrice(value: number) {
  return formatCredits(value);
}

function roundUpTwoDecimals(value: number) {
  return Math.ceil((value - 1e-9) * 100) / 100;
}

function formatPixels(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function formatMegapixels(value: number) {
  return `${Number(value.toFixed(2))}MP`;
}

function getExampleFormula(point: PricingPoint, pricing: ImageBaseCreditPricing) {
  if (point.pixels <= IMAGE_1024_BASE_PIXELS) {
    return {
      baseCredits: pricing.base1024Credits ?? 0,
      formula: `P <= ${formatPixels(IMAGE_1024_BASE_PIXELS)}`,
    };
  }

  if (point.pixels >= MAX_IMAGE_PIXELS) {
    return {
      baseCredits: pricing.base4kCredits ?? 0,
      formula: `P >= ${formatPixels(MAX_IMAGE_PIXELS)}`,
    };
  }

  const progress =
    (point.pixels - IMAGE_1024_BASE_PIXELS) /
    (MAX_IMAGE_PIXELS - IMAGE_1024_BASE_PIXELS);

  return {
    baseCredits: getImageBaseCredits(point.pixels, pricing),
    formula: `${formatPrice(pricing.base1024Credits ?? 0)} + ${Number(
      progress.toFixed(4)
    )} x (${formatPrice(pricing.base4kCredits ?? 0)} - ${formatPrice(
      pricing.base1024Credits ?? 0
    )})`,
  };
}

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.floor(nextWidth);
      setWidth(roundedWidth > 0 ? roundedWidth : 0);
    };

    updateWidth(element.getBoundingClientRect().width);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, []);

  return { ref, width };
}

export function ImagePricingChartCard({
  billing,
  isZh,
  pricing,
}: ImagePricingChartCardProps) {
  const normalizedPricing = getImageBaseCreditPricing(pricing);
  const data = buildChartData(normalizedPricing);
  const chartXTicks = [
    Number((MIN_IMAGE_PIXELS / 1_000_000).toFixed(2)),
    Number((IMAGE_1024_BASE_PIXELS / 1_000_000).toFixed(2)),
    Number(((1248 * 1248) / 1_000_000).toFixed(2)),
    Number(((2048 * 2048) / 1_000_000).toFixed(2)),
    Number((MAX_IMAGE_PIXELS / 1_000_000).toFixed(2)),
  ];
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const { ref: chartContainerRef, width: chartWidth } = useElementWidth();
  const textModerationCredits =
    TEXT_MODERATION_PRICE_CNY / REFERENCE_CREDIT_PRICE_CNY;
  const imageModerationCredits =
    IMAGE_MODERATION_PRICE_CNY / REFERENCE_CREDIT_PRICE_CNY;
  const groupMultiplier = Number.isFinite(billing.groupMultiplier)
    ? Math.max(0.01, billing.groupMultiplier)
    : 1;
  const multiplierExamplePoint =
    data.find((point) => point.size === DEFAULT_IMAGE_SIZE) ?? data[0]!;
  const multiplierExampleBase = getImageBaseCredits(
    multiplierExamplePoint.pixels,
    normalizedPricing
  );
  const multiplierExampleReviewAddOn = billing.moderationBlockingEnabled
    ? textModerationCredits
    : 0;
  const multiplierExampleBeforeMultiplier = roundUpTwoDecimals(
    multiplierExampleBase + multiplierExampleReviewAddOn
  );
  const multiplierExampleFinal = roundUpTwoDecimals(
    multiplierExampleBeforeMultiplier * groupMultiplier
  );

  const pricingItems = [
    {
      label: copy("Plan quota", "套餐配额"),
      value: `${billing.planName} · ${formatCredits(
        billing.monthlyCredits
      )} ${copy("credits / month", "积分/月")}`,
    },
    {
      label: copy("Chat round", "Chat 轮次"),
      value: `${formatCredits(billing.chatRoundCredits)} ${copy(
        "credits / round",
        "积分/轮"
      )}`,
    },
    {
      label: copy("Agent round", "Agent 轮次"),
      value: `${formatCredits(billing.agentRoundCredits)} ${copy(
        "credits / round",
        "积分/轮"
      )}`,
    },
    {
      label: copy("Backend group", "后端分组"),
      value: `${billing.groupName || copy("Default group", "默认分组")} · x${Number(
        groupMultiplier.toFixed(4)
      )}`,
    },
    {
      label: copy("Review add-on", "审核附加"),
      value: billing.moderationBlockingEnabled
        ? `${formatCredits(textModerationCredits)} ${copy(
            "text",
            "文本"
          )} · ${formatCredits(imageModerationCredits)} ${copy("image", "图片")}`
        : copy("Not enabled for this plan", "当前套餐未启用"),
    },
  ];
  const examplePoints = [
    data[0],
    data.find((point) => point.size === DEFAULT_IMAGE_SIZE),
    data.find((point) => point.size === "2048x2048"),
    data[data.length - 1],
  ].filter(Boolean) as PricingPoint[];

  // hover 语言与首页统计卡一致:轻抬升 + whisper 阴影 + 边框提亮;
  // Tailwind v4 的 -translate-y-* 走原生 translate 属性,过渡列表须写 translate 而非 transform
  return (
    <Card className="lift-hover motion-reduce:transition-none">
      <CardHeader className="space-y-1">
        <CardTitle className="font-serif text-lg font-medium tracking-tight">
          {copy("Image Pricing Curve", "生图计价曲线")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {copy(
            `Base image credits interpolate from ${formatPrice(
              normalizedPricing.base1024Credits
            )} at 1024x1024 to ${formatPrice(
              normalizedPricing.base4kCredits
            )} at 3840x2160.`,
            `基础生图积分从 1024x1024 的 ${formatPrice(
              normalizedPricing.base1024Credits
            )} 到 3840x2160 的 ${formatPrice(
              normalizedPricing.base4kCredits
            )} 之间按像素线性推算；低于 1024x1024 但仍满足模型尺寸限制时按 1024 基础价封底。`
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="h-[240px] min-w-0 overflow-hidden"
          ref={chartContainerRef}
        >
          {chartWidth > 0 ? (
            <LineChart
              data={data}
              height={240}
              margin={{ bottom: 8, left: 6, right: 18, top: 10 }}
              width={chartWidth}
            >
              {/* 网格与轴降噪:网格线取 border 40% 透明度,隐藏轴线,刻度字取 muted token */}
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="megapixels"
                domain={[
                  Number((MIN_IMAGE_PIXELS / 1_000_000).toFixed(2)),
                  Number((MAX_IMAGE_PIXELS / 1_000_000).toFixed(2)),
                ]}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(value) => formatMegapixels(Number(value))}
                ticks={chartXTicks}
                tickLine={false}
                type="number"
              />
              <YAxis
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(value) => formatPrice(Number(value))}
                tickLine={false}
                width={42}
              />
              {/* Tooltip 样式 token 化:浮层取 popover/border/menu 阴影,随主题明暗 */}
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm, 8px)",
                  boxShadow: "var(--shadow-menu)",
                  fontSize: 12,
                  padding: "8px 12px",
                }}
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeDasharray: "3 3",
                  strokeOpacity: 0.4,
                }}
                itemStyle={{ color: "var(--muted-foreground)", padding: 0 }}
                labelStyle={{
                  color: "var(--popover-foreground)",
                  fontWeight: 500,
                  marginBottom: 4,
                }}
                formatter={(value) => [
                  `${formatPrice(Number(value))} ${copy("credits", "积分")}`,
                  copy("Base credits", "基础积分"),
                ]}
                labelFormatter={(_, payload) => {
                  const point = payload?.[0]?.payload as
                    | PricingPoint
                    | undefined;
                  if (!point) return "";
                  return `${point.label} · ${point.size} · ${formatMegapixels(
                    point.megapixels
                  )}`;
                }}
              />
              {/* 数据点空心化(fill 取 background)以适配暗色;线宽 2px 更克制 */}
              <Line
                activeDot={{ r: 5 }}
                dataKey="baseCredits"
                dot={{ fill: "var(--background)", r: 3, strokeWidth: 1.5 }}
                isAnimationActive={false}
                stroke="var(--primary)"
                strokeWidth={2}
                type="linear"
              />
            </LineChart>
          ) : (
            <div className="h-full w-full rounded-md bg-muted/30" />
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {pricingItems.map((item) => (
            <div
              className="rounded-md border bg-muted/30 p-3"
              key={item.label}
            >
              <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {item.label}
              </div>
              <div className="mt-1.5 text-sm font-medium">{item.value}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="font-medium text-foreground">
              {copy("Base formula", "基础公式")}
            </div>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p>{copy("P = width x height.", "P = 宽 x 高。")}</p>
              <p>
                {copy(
                  `Valid GPT image sizes start at ${formatPixels(
                    MIN_IMAGE_PIXELS
                  )} pixels, dimensions must be at least ${MIN_IMAGE_DIMENSION}px, and aspect ratio must be <= ${MAX_IMAGE_ASPECT_RATIO}:1.`,
                  `GPT 合法尺寸从 ${formatPixels(
                    MIN_IMAGE_PIXELS
                  )} 像素起，宽高至少 ${MIN_IMAGE_DIMENSION}px，宽高比不超过 ${MAX_IMAGE_ASPECT_RATIO}:1。`
                )}
              </p>
              <p>
                {copy(
                  `If P <= ${formatPixels(
                    IMAGE_1024_BASE_PIXELS
                  )}, base = ${formatPrice(
                    normalizedPricing.base1024Credits
                  )}.`,
                  `若 P <= ${formatPixels(
                    IMAGE_1024_BASE_PIXELS
                  )}，基础价 = ${formatPrice(
                    normalizedPricing.base1024Credits
                  )}。`
                )}
              </p>
              <p>
                {copy(
                  `If ${formatPixels(
                    IMAGE_1024_BASE_PIXELS
                  )} < P < ${formatPixels(
                    MAX_IMAGE_PIXELS
                  )}, base = B1024 + (P - P1024) / (P4K - P1024) x (B4K - B1024).`,
                  `若 ${formatPixels(
                    IMAGE_1024_BASE_PIXELS
                  )} < P < ${formatPixels(
                    MAX_IMAGE_PIXELS
                  )}，基础价 = B1024 + (P - P1024) / (P4K - P1024) x (B4K - B1024)。`
                )}
              </p>
              <p>
                {copy(
                  `Final single-image charge = ceil2(ceil2(base + review add-ons) x group multiplier).`,
                  `单张最终扣费 = 向上保留两位(向上保留两位(基础价 + 审核附加) x 分组倍率)。`
                )}
              </p>
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="font-medium text-foreground">
              {copy("Examples", "计算示例")}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {examplePoints.map((point) => {
                const example = getExampleFormula(point, normalizedPricing);
                return (
                  <div
                    className="rounded-md border bg-background p-2"
                    key={point.size}
                  >
                    <div className="font-medium text-foreground">
                      {point.size} · {formatMegapixels(point.megapixels)}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      P = {formatPixels(point.pixels)}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {example.formula}
                    </div>
                    <div className="mt-1 font-medium text-foreground">
                      = {formatPrice(example.baseCredits)}{" "}
                      {copy("credits", "积分")}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 rounded-md border bg-background p-2">
              <div className="font-medium text-foreground">
                {copy("With group multiplier", "含分组倍率示例")}
              </div>
              <div className="mt-1 text-muted-foreground">
                {multiplierExamplePoint.size} ·{" "}
                {billing.groupName || copy("Default group", "默认分组")} · x
                {Number(groupMultiplier.toFixed(4))}
              </div>
              <div className="mt-1 text-muted-foreground">
                {copy(
                  `ceil2(ceil2(${formatPrice(
                    multiplierExampleBase
                  )} base + ${formatPrice(
                    multiplierExampleReviewAddOn
                  )} review) x ${Number(groupMultiplier.toFixed(4))})`,
                  `向上保留两位(向上保留两位(${formatPrice(
                    multiplierExampleBase
                  )} 基础价 + ${formatPrice(
                    multiplierExampleReviewAddOn
                  )} 审核附加) x ${Number(groupMultiplier.toFixed(4))})`
                )}
              </div>
              <div className="mt-1 font-medium text-foreground">
                = {formatPrice(multiplierExampleFinal)}{" "}
                {copy("credits / image", "积分/张")}
              </div>
            </div>
          </div>
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <p>
            {copy(
              "The curve shows base image generation credits only. Text review, image review, group multiplier, and Chat/Agent round charges are added separately.",
              "曲线仅展示基础生图积分；文本审核、图片审核、分组倍率、Chat/Agent 轮次费用会在此基础上另行叠加。"
            )}
          </p>
          <p>
            {copy(
              "Requests below 1024x1024 use the 1024 base price, and requests above 4K use the 4K base price.",
              "低于 1024x1024 按 1024 基础价封底，高于 4K 按 4K 基础价封顶。"
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
