/** 升级预留到期释放入口。外部 cron 经 CRON_SECRET 验证后仅调用 UOL，不删除财务记录。 */
import crypto from "node:crypto";
import "@repo/shared/payment/upgrade-reservation-operations";
import { logError } from "@repo/shared/logger";
import { invokeOperation } from "@repo/shared/uol";

/** 恒定时间验证后执行有界清理；失败只返回通用错误，不暴露数据库信息。 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!expected || !auth?.startsWith("Bearer "))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const hash = (value: string) =>
    crypto.createHash("sha256").update(value).digest();
  if (!crypto.timingSafeEqual(hash(auth.slice(7)), hash(expected)))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(
      await invokeOperation(
        "subscription.expireUpgradeReservations",
        { limit: 100 },
        { type: "cron", job: "upgrade-reservations" }
      )
    );
  } catch (error) {
    logError(error, { job: "upgrade-reservations" });
    return Response.json(
      { error: "Failed to expire upgrade reservations" },
      { status: 500 }
    );
  }
}
