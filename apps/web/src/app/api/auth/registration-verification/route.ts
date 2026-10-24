import { withApiLogging } from "@repo/shared/api-logger";
import {
  RegistrationVerificationError,
  sendRegistrationVerificationCode,
} from "@repo/shared/auth/registration-verification";
import { describeErrorForLog } from "@repo/shared/db/error-summary";
import { logWarn } from "@repo/shared/logger";
import { type NextRequest, NextResponse } from "next/server";

/** 非预期失败对外的统一文案；具体原因只进服务端日志。 */
const GENERIC_ERROR = "Failed to send verification code, please try again later";

/**
 * 发送注册验证码。
 *
 * 该接口对匿名调用方开放，因此只回显 RegistrationVerificationError 的消息
 * （自用模式、邮箱不合规、已注册、发码冷却、发信失败等可展示原因）；其余异常
 * （典型是数据库错误，其消息带完整 SQL 与绑定参数，包含明文验证码）统一转通用文案。
 */
async function handlePost(request: NextRequest) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email : "";

    await sendRegistrationVerificationCode(email);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof RegistrationVerificationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logWarn("注册验证码接口异常", { error: describeErrorForLog(error) });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }
}

export const POST = withApiLogging(handlePost);
