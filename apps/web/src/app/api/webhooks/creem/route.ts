/** Creem 传输适配：原文验签成功后构造 Principal，再调用 UOL；未验签数据不进入持久层。 */
import { withApiLogging } from "@repo/shared/api-logger";
import { logError } from "@repo/shared/logger";
import { constructRuntimeCreemEvent } from "@repo/shared/payment/creem";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import { NextResponse } from "next/server";

/** HTTP 只处理签名/响应；异常返回非 200，让 provider 重投补齐已提交的财务步骤。 */
export const POST = withApiLogging(async (req: Request) => {
  const body = await req.text();
  const signature = req.headers.get("creem-signature");
  if (!signature)
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  let event: Awaited<ReturnType<typeof constructRuntimeCreemEvent>>;
  try {
    event = await constructRuntimeCreemEvent(body, signature);
  } catch (error) {
    logError(error, { source: "creem-webhook", stage: "signature" });
    return NextResponse.json({ error: "Invalid webhook" }, { status: 400 });
  }
  try {
    const principal = { type: "webhook", provider: "creem" } as const;
    const result = await invokeOperation(
      "subscription.creemWebhook",
      event,
      principal
    );
    return NextResponse.json(result);
  } catch (error) {
    logError(error, { source: "creem-webhook", stage: "handler" });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      {
        status:
          error instanceof OperationError && error.code === "validation_error"
            ? 400
            : 500,
      }
    );
  }
});
