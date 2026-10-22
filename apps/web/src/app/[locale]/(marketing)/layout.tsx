// 注意:不要在本布局引入 fumadocs-ui/style.css。它自带一套 @layer utilities(含
// .hidden{display:none}),作为第二个样式表加载时会按层叠顺序压过本 app 的 .md:flex/
// .md:inline-flex,导致整个营销组(含首页)Header 的 `hidden md:flex` 导航与按钮在所有
// 宽度被永久 display:none。fumadocs CSS 只有 legal/[slug] 的 .prose 需要,
// 故下沉到该页面引入,避免污染首页等无关页面。
import { getServerSession } from "@repo/shared/auth/server";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import {
  type CurrentSession,
  CurrentSessionProvider,
} from "@/features/auth/hooks/use-current-session";
import { Footer, Header } from "@/features/marketing/components";
import {
  APP_INTL_NAMESPACES,
  MARKETING_INTL_NAMESPACES,
  pickIntlNamespaces,
} from "@/i18n/client-namespaces";

export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  // 营销区翻译:应用区命名空间(Header/Navigation/Common 等营销页也用)
  // + 营销专属命名空间。根布局只下发了应用区部分,这里补全。
  const allMessages = await getMessages();
  const marketingMessages = pickIntlNamespaces(allMessages, [
    ...APP_INTL_NAMESPACES,
    ...MARKETING_INTL_NAMESPACES,
  ]);
  const initialSession: CurrentSession = session?.user?.id
    ? {
        user: {
          id: session.user.id,
          name: session.user.name || "",
          email: session.user.email || "",
          image: session.user.image,
        },
      }
    : null;

  return (
    <CurrentSessionProvider initialData={initialSession}>
      <NextIntlClientProvider messages={marketingMessages}>
        <div className="flex min-h-screen flex-col">
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </NextIntlClientProvider>
    </CurrentSessionProvider>
  );
}
