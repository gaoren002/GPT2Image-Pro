"use client";

/**
 * 谷段一折「千笔之约」:生图 SLA 的水墨数据可视化(v1.0.1 跟随化)。
 * 可靠性不是读数字,是亲眼看见——最近上千张已完结生成化作一片
 * 墨点雨,随滚动按波次落在纸面排成点阵:成功 = 墨点,平台或上游
 * 错误 = 朱色空圈,审核拦截与用户请求错误 = 淡灰点(不计入可用性
 * 的两类以低对比呈现);成功率大数字随点阵铺满显影,图例以点色对应。
 * v1.0.1:落点进度从一次性 1.6s 时间轴改为滚动进度纯函数——滚多少
 * 落多少,滚回即收墨倒放,与影片段"滚动即推轨"同一镜头语言。
 * 点序经固定种子洗牌(错误散布其间,如实呈现);reduced-motion 直接
 * 呈现终态,数字/图例为真实 DOM,数据真相不依赖动画。
 * 管理员可见性开关(server action)原样保留。
 */
import { Button } from "@repo/ui/components/button";
import {
  type MotionValue,
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
} from "framer-motion";
import { Eye, Loader2, X } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { GenerationSlaStats } from "@/features/image-generation/sla";
import { updateMarketingSlaStatusVisibilityAction } from "@/features/marketing/actions/sla-status";
import { InkReveal, useInkEngaged } from "./ink-reveal";

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

/** 窗口线性段(谷段各折共用的相位工具) */
function seg(p: number, a: number, b: number) {
  return Math.max(0, Math.min(1, (p - a) / (b - a)));
}

/** 点类型:与图例一一对应 */
type DotKind = "ok" | "platform" | "muted";

/**
 * 点色:CSS 变量取主题 token,明暗两态自动切换(不再硬编码 hex)。
 * ok=墨点(foreground),platform=错误空圈(destructive),muted=淡灰点(border)。
 * WHY 不用彩色:全站黑白单色,错误语义以 destructive 红呈现在图例与空圈,
 * 保持克制且暗底可见(旧 #221d1a 墨点在暗底上几乎不可见)。
 */
const DOT_COLORS: Record<DotKind, string> = {
  ok: "var(--foreground)",
  platform: "var(--destructive)",
  muted: "var(--border)",
};

/** 确定性洗牌种子随机(与水墨引擎同式) */
function mulberry32(a: number) {
  let state = a | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由统计构造点序列(封顶 1000,按比例取整,成功补齐余数,固定种子洗牌) */
function buildDots(stats: GenerationSlaStats): DotKind[] {
  const total = Math.max(
    1,
    Math.min(1000, stats.sampleSize || stats.completed)
  );
  const sum = Math.max(1, stats.sampleSize || 1);
  const platform = Math.round((stats.platformErrors / sum) * total);
  const muted = Math.round(
    ((stats.moderationErrors + stats.userRequestErrors) / sum) * total
  );
  const ok = Math.max(0, total - platform - muted);
  const dots: DotKind[] = [
    ...Array.from({ length: ok }, () => "ok" as const),
    ...Array.from({ length: platform }, () => "platform" as const),
    ...Array.from({ length: muted }, () => "muted" as const),
  ];
  const rnd = mulberry32(97);
  for (let i = dots.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = dots[i] as DotKind;
    dots[i] = dots[j] as DotKind;
    dots[j] = a;
  }
  return dots;
}

/**
 * 点阵画布:落点进度为滚动进度的纯函数(同一绘制函数产出终态与
 * 一切中间态,重入/resize/倒放都收敛到同一真相)。reduced-motion
 * 不订阅进度,挂载即呈现终态。
 */
function DotField({
  dots,
  progress,
  reduced,
}: {
  dots: DotKind[];
  progress: MotionValue<number>;
  reduced: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(
    (value: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // 钳制:弹性滚动下 useScroll 可能瞬时越界 [0,1](铁律)
      const progressValue = Math.min(1, Math.max(0, value));
      const cols = 50;
      const rows = Math.ceil(dots.length / cols);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = (w / cols) * rows;
      canvas.height = Math.round(h * dpr);
      canvas.width = Math.round(w * dpr);
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const cell = w / cols;
      const r = cell * 0.22;
      const shown = Math.floor(progressValue * dots.length);
      for (let i = 0; i < shown; i++) {
        const kind = dots[i] as DotKind;
        const cx = (i % cols) * cell + cell / 2;
        const cy = Math.floor(i / cols) * cell + cell / 2;
        // 刚落下的点略大(着纸未收),随后回到常规半径
        const age = (progressValue * dots.length - i) / dots.length;
        const radius = r * (age < 0.02 ? 1.5 - age * 25 : 1);
        ctx.beginPath();
        ctx.arc(cx, cy, kind === "muted" ? radius * 0.8 : radius, 0, 7);
        if (kind === "platform") {
          ctx.strokeStyle = DOT_COLORS.platform;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else {
          ctx.fillStyle = DOT_COLORS[kind];
          ctx.fill();
        }
      }
    },
    [dots]
  );
  // 滚动进度直驱绘制(不经 React 渲染);减动效不订阅
  useMotionValueEvent(progress, "change", (v) => {
    if (!reduced) draw(v);
  });
  useEffect(() => {
    // 初始与 resize 都重绘当前真相(减动效恒为终态)
    const current = () => (reduced ? 1 : progress.get());
    draw(current());
    const onResize = () => draw(current());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw, reduced, progress]);
  // aria-hidden 放包裹层:biome 视 canvas 为交互元素,直接标注会触发
  // noAriaHiddenOnFocusable / 非交互 role 两条规则
  return (
    <div aria-hidden="true">
      <canvas ref={canvasRef} className="w-full" />
    </div>
  );
}

export function SlaStatusSection({
  locale,
  stats,
  canToggleVisibility = false,
  initiallyEnabled = true,
}: {
  locale: string;
  stats: GenerationSlaStats;
  canToggleVisibility?: boolean;
  initiallyEnabled?: boolean;
}) {
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [visible, setVisible] = useState(initiallyEnabled);
  // mounted 门闩:滚动绑定样式仅客户端挂载后生效,SSR/无 JS 输出
  // 完成态(数字与图例是内容真相,不依赖动画)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const { execute: updateVisibility, isPending } = useAction(
    updateMarketingSlaStatusVisibilityAction,
    {
      onSuccess: ({ data }) => {
        const enabled = data?.enabled ?? false;
        setVisible(enabled);
        toast.success(
          data?.message ||
            (enabled
              ? copy("Homepage SLA enabled", "首页 SLA 已开启")
              : copy("Homepage SLA hidden", "首页 SLA 已关闭"))
        );
      },
      onError: ({ error }) => {
        toast.error(
          error.serverError ||
            copy("Failed to update SLA display", "更新 SLA 展示失败")
        );
      },
    }
  );

  // 落墨行程:区块顶进入视口下缘起笔,区块中带到达视口中带收笔
  // (滚过约大半屏落完千点;滚回同一函数倒放收墨)
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({
    target: fieldRef,
    offset: ["start 0.92", "center 0.48"],
  });
  // engage 门:刷新恢复滚动位置落在本段时保持终态,避免铺满的
  // 点阵与大数字在 JS 就绪瞬间突变回中间态(退出视口后再参演)
  const engaged = useInkEngaged(scrollYProgress);
  // 大数字显影:点阵铺满的尾声墨色聚成读数(透明度与聚焦分开驱动,
  // 都是普通样式,无 transform 混绑)
  const percentReveal = useTransform(scrollYProgress, (v) =>
    seg(Math.min(1, Math.max(0, v)), 0.62, 0.92)
  );
  const percentBlur = useTransform(
    percentReveal,
    (v) => `blur(${((1 - v) * 5).toFixed(2)}px)`
  );

  const legend = [
    {
      kind: "ok" as const,
      label: copy("Completed", "成功生成"),
      value: formatNumber(stats.completed),
    },
    {
      kind: "platform" as const,
      label: copy("Platform / upstream errors", "平台或上游错误"),
      value: formatNumber(stats.platformErrors),
    },
    {
      kind: "muted" as const,
      label: copy(
        "Moderation stops / request errors",
        "审核拦截与请求错误"
      ),
      value: formatNumber(stats.moderationErrors + stats.userRequestErrors),
    },
  ];

  if (!visible) {
    if (!canToggleVisibility) return null;
    return (
      <section className="border-y border-border/60 bg-secondary/50">
        <div className="container flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {copy("Homepage SLA is hidden", "首页 SLA 已隐藏")}
            </p>
            <p className="text-xs text-muted-foreground">
              {copy(
                "This only affects the marketing homepage. Admin status pages are unchanged.",
                "该开关只影响营销主页，后台状态页不受影响。"
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => updateVisibility({ enabled: true })}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-2 h-4 w-4" />
            )}
            {copy("Show SLA", "开启 SLA")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    // 区块纵向节奏对齐首页谷段(py-20 md:py-28,与 FAQ/Pricing 一致)
    <section className="border-y border-border/60 bg-secondary/50 py-20 md:py-28">
      <div className="container">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_2fr] lg:items-center">
          <div>
            {/* 左栏三行随滚动错落显影(v1.0.2 同族语言);
                大数字保留自己的落墨尾段显影,不重复包裹 */}
            <InkReveal>
              {/* 眉标对齐全站小标签规范:text-[11px] + tracking-widest */}
              <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {copy("Generation SLA", "生图服务 SLA")}
              </p>
            </InkReveal>
            <InkReveal phase={0.2}>
              {/* 首页谷段 section 标题统一一档:补 md:text-4xl(与 FAQ/Pricing 对齐) */}
              <h2 className="mt-2 font-serif text-3xl font-medium tracking-tight md:text-4xl">
                {copy("Every stroke lands", "千笔之约")}
              </h2>
            </InkReveal>
            <InkReveal phase={0.4}>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {copy(
                  `The latest ${formatNumber(stats.sampleSize)} finished generations, each one a dot of ink on this paper. Availability excludes moderation stops and invalid requests, so platform reliability is visible separately.`,
                  `最近 ${formatNumber(stats.sampleSize)} 张已完结生成，每一张都是这页纸上的一点墨。可用性剔除审核拦截与请求错误，平台侧可靠性单独可见。`
                )}
              </p>
            </InkReveal>
            <motion.p
              style={
                mounted && !reduced && engaged
                  ? { opacity: percentReveal, filter: percentBlur }
                  : undefined
              }
              className="mt-6 font-serif text-5xl font-medium tracking-tight"
            >
              {formatPercent(stats.successRate)}
            </motion.p>
            <p className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
              {copy("availability", "可用性")}
            </p>
            {canToggleVisibility && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-6"
                onClick={() => updateVisibility({ enabled: false })}
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <X className="mr-2 h-4 w-4" />
                )}
                {copy("Hide homepage SLA", "关闭首页 SLA")}
              </Button>
            )}
          </div>

          <div ref={fieldRef}>
            <DotField
              dots={buildDots(stats)}
              progress={scrollYProgress}
              reduced={!mounted || reduced || !engaged}
            />
            <ul className="mt-5 flex flex-wrap gap-x-8 gap-y-2">
              {legend.map((item) => (
                <li
                  key={item.kind}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={
                      item.kind === "platform"
                        ? {
                            border: `1.4px solid ${DOT_COLORS.platform}`,
                          }
                        : { backgroundColor: DOT_COLORS[item.kind] }
                    }
                  />
                  {item.label}
                  <span className="font-medium text-foreground/80">
                    {item.value}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
