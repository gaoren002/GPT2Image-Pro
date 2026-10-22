import { Providers } from "@repo/shared/components";
import { siteConfig } from "@repo/shared/config";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { Toaster } from "sonner";
import { Analytics } from "@/features/analytics";
// 深路径直引(不经 marketing barrel):barrel 同时 re-export Header/PricingSection,
// 它们 import framer-motion(~62KB gzip)。经 barrel 引入会把 framer 引擎拖进每个
// 非营销路由(dashboard/auth 共 21 个)的首屏。直引 cookie-consent 即可避免。
import { CookieConsent } from "@/features/marketing/components/cookie-consent";
import {
  APP_INTL_NAMESPACES,
  pickIntlNamespaces,
} from "@/i18n/client-namespaces";
import { routing } from "@/i18n/routing";

import "@repo/ui/globals.css";

/**
 * 首页影片 no-flash 探测(与 CinemaGLProvider.probeInitialStatus
 * 同判据:强制降级参数/减动效/窄屏走静态,其余影片壳)。必须内联
 * 同步执行:在正文解析前把 html[data-cinema] 钉住,配合 globals 的
 * 占位隐藏规则,JS 加载期显示空场纸底而非旧静态排版——否则用户
 * 会看到"进入瞬间旧 UI 闪现 -> 突变为影片"(实证缺陷)。
 * 4 秒内 React 未落 cinemaReady(bundle 加载失败)则撤销,露出
 * 静态编排的内容真相。非首页路由无 data-film-fallback 元素,
 * 本脚本对其无副作用。
 */
const CINEMA_PROBE_SCRIPT = `(function(){try{var d=document.documentElement;if(/[?&]gl=static/.test(location.search))return;if(window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;if(window.innerWidth<768)return;d.dataset.cinema="film";setTimeout(function(){if(!d.dataset.cinemaReady){delete d.dataset.cinema}},4000)}catch(e){}})();`;

/**
 * 生成静态参数
 * 为每个支持的语言生成静态页面
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * 生成 metadata(站点级 + hreflang)
 *
 * WHY 合并在此:本文件即根布局(app/ 下无独立 layout.tsx),
 * 站点级 metadata 与按 locale 的 alternates 必须在同一处产出。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const baseUrl = siteConfig.url;

  return {
    title: {
      default: siteConfig.name,
      template: `%s | ${siteConfig.name}`,
    },
    description: siteConfig.description,
    keywords: [...siteConfig.keywords],
    authors: [{ name: siteConfig.author.name, url: siteConfig.author.url }],
    creator: siteConfig.author.name,
    metadataBase: new URL(siteConfig.url),
    openGraph: {
      type: "website",
      locale: locale === "zh" ? "zh_CN" : "en_US",
      url: `${baseUrl}/${locale}`,
      title: siteConfig.name,
      description: siteConfig.description,
      siteName: siteConfig.name,
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: siteConfig.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: siteConfig.name,
      description: siteConfig.description,
      images: [siteConfig.ogImage],
      creator: "@gpt2image",
    },
    manifest: "/site.webmanifest",
    alternates: {
      canonical: `${baseUrl}/${locale}`,
      languages: {
        en: `${baseUrl}/en`,
        zh: `${baseUrl}/zh`,
        "x-default": `${baseUrl}/en`,
      },
    },
  };
}

/**
 * 根布局(兼 locale 布局)
 *
 * WHY html 在此渲染:lang 属性必须跟随路由 locale(此前根布局硬编码
 * lang="en",中文页面语言标签错误,影响 SEO 与读屏)。app/ 下不再有
 * layout.tsx,本文件是最顶层布局,html/body 由此输出。
 *
 * 功能:
 * - 验证语言参数有效性
 * - html lang 按 locale 输出;suppressHydrationWarning 供 next-themes 换肤
 * - body 全站衬线字体(font-serif,见 @repo/ui/globals.css 字体栈)
 * - 提供国际化上下文 (NextIntlClientProvider)
 * - 包装 Providers (主题等)
 * - 全局组件 (CookieConsent, Toaster)
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // 获取语言参数
  const { locale } = await params;

  // 验证语言是否有效
  if (!routing.locales.includes(locale as "en" | "zh")) {
    notFound();
  }

  // 获取翻译消息并按命名空间裁剪:营销专属命名空间(FAQ/Testimonials/
  // Features/UseCases/HowItWorks/Cinema/Hero/CTA 等)只被 (marketing) 路由
  // 消费,在营销布局内经 MarketingIntlMessages 二次供给;根布局下发全量
  // 会让 dashboard/auth/docs 等每个路由的 RSC payload 都携带约 8KB 无用
  // 翻译(gzip 前)。HomePage 命名空间已无消费者,直接不保留。
  const allMessages = await getMessages();
  const messages = pickIntlNamespaces(allMessages, APP_INTL_NAMESPACES);

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="font-serif antialiased">
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: no-flash 探测须内联同步执行,脚本为本文件常量非用户输入
          dangerouslySetInnerHTML={{ __html: CINEMA_PROBE_SCRIPT }}
        />
        <NextIntlClientProvider messages={messages}>
          <Providers>
            {children}
            <CookieConsent />
            <Toaster richColors position="top-right" />
            <Analytics />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
