/** 无限画布的服务端入口；校验当前会话，通过 UOL 获取本人近期作品。 */
import { getCurrentUser } from "@repo/shared/auth/server";
import { getLocale } from "next-intl/server";
import { CanvasPageClient } from "@/features/canvas/page-client";
import { listCanvasImagesForUser } from "@/features/canvas/server";
import { redirect } from "@/i18n/routing";

/** 未登录用户不返回私人素材，文档本体由客户端按当前账号读取。 */
export default async function CanvasPage() {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) return redirect({ href: "/sign-in", locale });
  const result = await listCanvasImagesForUser(user.id);
  return <CanvasPageClient userId={user.id} initialImages={result} />;
}
