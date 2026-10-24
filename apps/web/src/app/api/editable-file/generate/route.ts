/**
 * 站内可编辑文件(PPT/PSD)生成路由（创作页 chat(web) tab 用）。
 *
 * 与外部 v1/ppts、v1/psds 同一 service(runEditableFileForUser),差别仅在鉴权:此路由用
 * 登录会话(Better Auth session)而非 Bearer API key。PPT/PSD 是分钟级长任务,复用图像生成的
 * SSE keep-alive(createImageStreamResponse)撑住连接,完成推 completed(含产物下载 URL),失败推 error。
 *
 * 流程:session 鉴权 → 能力门禁(export.ppt/export.psd)→ 解析 body → runEditableFileForUser
 *   (单一账号池/计费真相,只选付费 web 账号)→ keep-alive 返回。计费/账号池/storage 全在 service。
 */

import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { consumeCredits } from "@repo/shared/credits/core";
import {
  canUsePlanCapability,
  getPlanBillingConfig,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  createJsonKeepAliveResponse,
  toOpenAIErrorPayload,
} from "@/features/external-api/images";
import { runEditableFileForUser } from "@/features/image-generation/editable-file-operations";

import {
  confirmSourceImageFiles,
  inputImageDataToFile,
  InputImageReferenceError,
  parseSourceImageMetadata,
  validateSourceImageFiles,
} from "../../images/chat/input-image-references";

const generateSchema = z.object({
  kind: z.enum(["ppt", "psd"]),
  prompt: z.string().min(1, "prompt is required").max(8000),
  // 输入图 data URL 数组(PSD 必须非空;PPT 可空)。
  base64Images: z.array(z.string().min(1).max(20_000_000)).default([]),
  // chat(web) 会话内生成:除固定生成价外,额外按套餐轮次价扣一次(复用 chat 轮次费)。
  chatRound: z.boolean().optional(),
  sourceImageMetadata: z.unknown().optional(),
});

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }
  const userId = session.user.id;

  let body: unknown;
  let sourceFiles: File[] | undefined;
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      sourceFiles = form
        .getAll("image")
        .filter((value): value is File => value instanceof File);
      if (sourceFiles.length !== form.getAll("image").length)
        return errorResponse("Invalid image upload");
      const messageId = form.get("source_image_message_id");
      const rawIds = form.get("source_image_attachment_ids");
      body = {
        kind: form.get("kind"),
        prompt: form.get("prompt"),
        chatRound: form.get("chatRound") === "true",
        sourceImageMetadata:
          messageId || rawIds
            ? { messageId, attachmentIds: JSON.parse(String(rawIds)) }
            : undefined,
      };
    } else body = await request.json();
  } catch {
    return errorResponse("Invalid request body");
  }
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message || "Invalid request");
  }
  const { kind, prompt, chatRound } = parsed.data;
  let base64Images = parsed.data.base64Images;

  const capability = kind === "psd" ? "export.psd" : "export.ppt";
  const plan = await getUserPlan(userId);
  if (!(await canUsePlanCapability(plan.plan, capability))) {
    return errorResponse(
      kind === "psd"
        ? "PSD generation is not enabled for this plan."
        : "PPT generation is not enabled for this plan.",
      403
    );
  }
  if (kind === "psd" && (sourceFiles?.length ?? base64Images.length) === 0) {
    return errorResponse("base64_images is empty");
  }

  let sourceImageReferences: Awaited<
    ReturnType<typeof confirmSourceImageFiles>
  >;
  try {
    // 未参与确认协议的旧 JSON 调用保持原输入契约，不做隐式存储迁移。
    if (sourceFiles || parsed.data.sourceImageMetadata !== undefined) {
      const limits = await getPlanUploadLimits(plan.plan);
      const planLimits = await getPlanLimits(plan.plan);
      const count = sourceFiles?.length ?? base64Images.length;
      if (count > planLimits.maxChatImages)
        return errorResponse(
          `No more than ${planLimits.maxChatImages} attachments are allowed.`
        );
      const metadata = parseSourceImageMetadata(
        parsed.data.sourceImageMetadata,
        count
      );
      const files =
        sourceFiles ??
        base64Images.map((value, index) =>
          inputImageDataToFile(value, index, limits.maxFileSizeBytes)
        );
      validateSourceImageFiles(files, limits);
      sourceImageReferences = await confirmSourceImageFiles(
        userId,
        files,
        metadata,
        request.signal
      );
      if (sourceFiles) {
        base64Images = [];
        for (const file of sourceFiles)
          base64Images.push(
            `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`
          );
      }
    }
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid input images",
      request.signal.aborted
        ? 499
        : error instanceof InputImageReferenceError
          ? error.status
          : 400
    );
  }

  const taskId = randomUUID();
  const runOnce = async () => {
    const result = await runEditableFileForUser({
      userId,
      kind,
      prompt,
      base64Images,
      taskId,
    });
    let creditsCharged = result.creditsCharged;
    // chat(web) 会话内生成:成功后再按套餐轮次价扣一次(复用 chat 轮次费,幂等键防重复扣)。
    // 只在生成成功后扣,失败不扣;与生成扣费是两笔独立幂等消费。
    if (chatRound) {
      const billing = await getPlanBillingConfig(plan.plan);
      const roundFee = Math.max(0, Math.trunc(billing.chatRoundCredits || 0));
      if (roundFee > 0) {
        await consumeCredits({
          userId,
          amount: roundFee,
          serviceName: "editable_file_chat_round",
          description:
            kind === "psd" ? "chat(web) PSD 轮次" : "chat(web) PPT 轮次",
          sourceRef: `editable-file-round:${taskId}`,
          metadata: { kind, taskId, chatRound: true },
        });
        creditsCharged += roundFee;
      }
    }
    return {
      object: "editable_file_task",
      taskId,
      status: "success",
      kind,
      result: {
        conversation_id: result.conversationId,
        primary_url: result.primaryUrl,
        zip_url: result.zipUrl,
      },
      credits_charged: creditsCharged,
    };
  };
  // 上传确认独立于生成结果；生成失败也回传，客户端先保存输入再展示错误。
  return createJsonKeepAliveResponse(async () => {
    try {
      return { ...(await runOnce()), sourceImageReferences };
    } catch (error) {
      return {
        ...toOpenAIErrorPayload(
          error instanceof Error ? error.message : "Image request failed"
        ),
        sourceImageReferences,
      };
    }
  });
});
