import { getBaseUrl } from "@repo/shared/config/payment";
import { logger } from "@repo/shared/logger";
import {
  decodeEpayMetadata,
  EPAY_TRADE_SUCCESS,
  getEpayOrderMetadata,
  getEpayOrderStatus,
  isRuntimeEpayConfigured,
  parseEpayRequestParams,
  verifyRuntimeEpayParams,
} from "@repo/shared/payment/epay";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  return handleReturn(req);
}

export async function POST(req: Request) {
  return handleReturn(req);
}

/**
 * Epay 同步回跳页（浏览器可见）。
 *
 * 安全要点：此端点**仅用于展示**，绝不发放积分 / 履约订单。
 * 履约只在异步通知 /api/webhooks/epay 中进行——该回跳 URL 由网关带签名放入用户地址栏，
 * 用户可读取并并发重放，若在此发放积分将导致一次支付被多次履约（薅羊毛）。
 * 这里只校验签名用于展示真实状态，并读取本地订单状态反映履约进度。
 */
async function handleReturn(req: Request) {
  const baseUrl = getBaseUrl();

  if (!(await isRuntimeEpayConfigured())) {
    return NextResponse.redirect(`${baseUrl}/dashboard/billing?pay=fail`);
  }

  const params = await parseEpayRequestParams(req);
  const verifyInfo = await verifyRuntimeEpayParams(params);
  const metadata = verifyInfo.verifyStatus
    ? (decodeEpayMetadata(verifyInfo.param) ??
      (await getEpayOrderMetadata(verifyInfo.outTradeNo)))
    : null;
  const redirectPath =
    metadata?.type === "subscription" ? "/dashboard" : "/dashboard/billing";
  const separator = redirectPath.includes("?") ? "&" : "?";

  if (!verifyInfo.verifyStatus) {
    logger.warn(
      { source: "epay-return", outTradeNo: verifyInfo.outTradeNo },
      "Invalid Epay return signature"
    );
    return NextResponse.redirect(
      `${baseUrl}${redirectPath}${separator}pay=fail`
    );
  }

  // 仅读取本地订单状态以反映履约进度，不在此触发履约。
  const orderStatus = await getEpayOrderStatus(verifyInfo.outTradeNo);
  let payStatus: "success" | "processing" | "pending" | "fail" = "pending";
  if (orderStatus === "success") {
    payStatus = "success";
  } else if (
    ["failed", "cancelled", "expired", "refund_pending", "refunded"].includes(
      orderStatus ?? ""
    )
  ) {
    payStatus = "fail";
  } else if (verifyInfo.tradeStatus === EPAY_TRADE_SUCCESS) {
    // 网关已确认支付，但异步通知可能尚未完成履约。
    payStatus = "processing";
  }

  return NextResponse.redirect(
    `${baseUrl}${redirectPath}${separator}pay=${payStatus}`
  );
}
