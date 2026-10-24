import {
  moderateContent,
  type ModerationImageInput,
} from "@repo/shared/moderation";
import {
  isModerationBlockRiskLevel,
  type ModerationBlockRiskLevel,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { NextResponse, type NextRequest } from "next/server";
import {
  readJsonBodyWithinLimit,
  SELF_AUTHENTICATED_BODY_MAX_BYTES,
} from "@/server/bounded-json-body";
import { secretMatchesAny } from "./proxy-secret";

type ModerationRequestImage = {
  data?: string;
  name?: string;
  type?: string;
  url?: string;
};

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function getProxySecrets() {
  return [
    await getRuntimeSettingString("CONTENT_MODERATION_PROXY_SECRET"),
    await getRuntimeSettingString("CONTENT_MODERATION_PROXY_GATEWAY_SECRET"),
  ].filter((value): value is string => Boolean(value));
}

async function verifyProxySecret(request: NextRequest) {
  const secrets = await getProxySecrets();
  // Fail-closed：未配置代理密钥时，该端点保持关闭（401），
  // 避免成为未鉴权的审核 oracle / 成本放大入口。
  if (secrets.length === 0) return false;

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const headerSecret = request.headers.get("x-moderation-proxy-secret") || "";
  // 用恒定时间比对（sha256 + timingSafeEqual）替代 Array.includes 的原生短路
  // 字符串比较，避免计时侧信道，与全仓其它鉴权入口的标准对齐。
  return (
    secretMatchesAny(bearer, secrets) || secretMatchesAny(headerSecret, secrets)
  );
}

function parseImage(
  image: ModerationRequestImage
): ModerationImageInput | null {
  if (!image.url && !image.data) return null;
  return {
    data: image.data ? Buffer.from(image.data, "base64") : Buffer.alloc(0),
    name: image.name,
    type: image.type || "image/png",
    url: image.url,
  };
}

function parsePlan(value: unknown): SubscriptionPlan | undefined {
  return value === "free" ||
    value === "starter" ||
    value === "pro" ||
    value === "ultra" ||
    value === "enterprise"
    ? value
    : undefined;
}

function parseModerationBlockRiskLevel(
  value: unknown
): ModerationBlockRiskLevel | undefined {
  return isModerationBlockRiskLevel(value) ? value : undefined;
}

export async function POST(request: NextRequest) {
  if (!(await verifyProxySecret(request))) {
    return errorResponse("Unauthorized", 401);
  }

  // 本路径不经 middleware（审核图片可能很大），在校验代理密钥后限长读取。
  const parsed = await readJsonBodyWithinLimit(
    request,
    SELF_AUTHENTICATED_BODY_MAX_BYTES
  );
  if (!parsed.ok) {
    return parsed.reason === "too_large"
      ? errorResponse("Request body too large", 413)
      : errorResponse("Invalid JSON body");
  }
  const body = parsed.value;

  if (!body || typeof body !== "object") {
    return errorResponse("Invalid request body");
  }

  const input = body as Record<string, unknown>;
  const prompt =
    typeof input.prompt === "string"
      ? input.prompt
      : typeof input.text === "string"
        ? input.text
        : "";
  if (!prompt.trim()) {
    return errorResponse("Missing prompt");
  }

  const images = Array.isArray(input.images)
    ? input.images
        .filter((image): image is ModerationRequestImage => {
          return Boolean(image && typeof image === "object");
        })
        .map(parseImage)
        .filter((image): image is ModerationImageInput => Boolean(image))
    : undefined;

  const mode =
    input.mode === "image" || input.mode === "text" ? input.mode : undefined;

  const result = await moderateContent({
    prompt,
    images,
    mode,
    userId: typeof input.userId === "string" ? input.userId : undefined,
    userPlan: parsePlan(input.userPlan),
    userModerationBlockRiskLevel: parseModerationBlockRiskLevel(
      input.userModerationBlockRiskLevel
    ),
    generationId:
      typeof input.generationId === "string" ? input.generationId : undefined,
    skipProxy: true,
  });

  return NextResponse.json(result);
}
