/**
 * 可编辑文件(PPT/PSD)编排:租 web 账号 → generateFileWithChatGptWeb → 存 storage → 扣固定积分。
 *
 * 职责:把「对话式生成可编辑文件」串成一条同步链路(供 v1 handler / UOL / 前端调用):
 *   ① base64 输入图解码;② 从后端池租一个 web 账号(accountBackendPreference="web",失败换号,
 *   带 in-flight 租约 + 结果上报,保证不泄露租约、不误伤池健康);③ 调 generateFileWithChatGptWeb
 *   出 .pptx/.psd(+可选 zip);④ 二进制存进站内 storage(与生图同 bucket/签名 URL);
 *   ⑤ 成功后按固定价 consumeCredits(双重记账,幂等键 sourceRef=editable-file:{taskId},只成功才扣)。
 *
 * WHY:符合 CLAUDE.md 单一账号池/单一计费真相;不复用图片 batch-runner(产物非图片)。
 * 账号能力(plus/pro + 代码解释器 + gpt-5-5-thinking)由后续调度过滤保证(见设计文档 §8);
 * 本编排在无可用账号/生成失败时明确报错、不扣费。
 * 长任务态(queued→轮询)与账号 plus/pro 过滤见后续迭代(⑥),本文件先做同步打通。
 */
import { consumeCredits } from "@repo/shared/credits/core";
import { logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import {
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { nanoid } from "nanoid";
import {
  ImageBackendPoolUnavailableError,
  releaseImageBackendInflightLease,
  reportImageBackendResult,
  resolveImageBackendPoolConfig,
} from "@/features/image-backend-pool/service";
import {
  type EditableFileBinary,
  type EditableFileKind,
  generateFileWithChatGptWeb,
} from "./chatgpt-web";
import {
  decodeBase64DataUrl,
  editableFileExtension,
  editableFileServiceName,
  NO_WEB_ACCOUNT_ERROR,
} from "./editable-file-util";

const DEFAULT_EDITABLE_CREDITS = 25;
const MAX_ACCOUNT_SWITCHES = 3;

export type EditableFileOutput = {
  conversationId: string;
  primaryUrl: string;
  zipUrl: string | null;
  creditsCharged: number;
};

/** pool-account/api → 租约/上报用的 memberType。web 账号为 pool-account → "account"。 */
function poolMemberType(type?: string): "api" | "account" {
  if (type === "pool-api") return "api";
  return "account";
}

async function storageBucket(): Promise<string> {
  return (
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations"
  );
}

/** 把一个文件二进制存进站内 storage,返回签名下载 URL(与生图同 bucket/路由)。 */
async function storeEditableBinary(
  userId: string,
  kind: EditableFileKind,
  binary: EditableFileBinary,
  isZip: boolean
): Promise<string> {
  const bucket = await storageBucket();
  const key = `${userId}/${nanoid(32)}.${editableFileExtension(kind, isZip)}`;
  const storage = await getStorageProvider();
  await storage.putObject(
    key,
    bucket,
    binary.buffer,
    binary.mimeType || "application/octet-stream"
  );
  return buildSignedStorageImageUrl(key, bucket) ?? "";
}

/**
 * 生成一份可编辑文件(PPT/PSD)。同步链路:租号→生成→存储→扣费。
 * @param taskId 幂等/审计标识(计费 sourceRef=editable-file:{taskId})。
 * @throws base64_images is empty(PSD 必须有输入图)/ no available web account / 生成失败信息。
 */
export async function runEditableFileForUser(params: {
  userId: string;
  apiKeyId?: string;
  kind: EditableFileKind;
  prompt: string;
  base64Images: string[];
  taskId: string;
}): Promise<EditableFileOutput> {
  const { userId, apiKeyId, kind, prompt, taskId } = params;
  // PSD 强制要输入图(与 chatgpt2api 一致);PPT 可空。
  if (kind === "psd" && params.base64Images.length === 0) {
    throw new Error("base64_images is empty");
  }
  const images = params.base64Images.map((raw, index) =>
    decodeBase64DataUrl(raw, index + 1)
  );

  const excluded: string[] = [];
  let lastError = "";
  for (let attempt = 0; attempt <= MAX_ACCOUNT_SWITCHES; attempt++) {
    let resolved: Awaited<ReturnType<typeof resolveImageBackendPoolConfig>> =
      null;
    try {
      resolved = await resolveImageBackendPoolConfig({
        userId,
        apiKeyId,
        requestKind: "image_generation",
        accountBackendPreference: "web",
        // PPT/PSD 需代码解释器,限付费账号:池只在付费级 web 账号里选(见 planType 回填/导入 check)。
        accountPlanFilter: "paid",
        // 跨组直取付费 web,忽略 API key/偏好的分组作用域——PPT/PSD 像站内 UI 一样必须命中付费
        // web 账号,不受外部 key 绑定的(可能是 api-only 的)分组限制。apiKeyId 仍用于计费归属。
        spanGroupsForWeb: true,
        excludedMemberKeys: excluded,
      });
    } catch (error) {
      if (!(error instanceof ImageBackendPoolUnavailableError)) throw error;
    }
    const backend = resolved?.config.backend;
    if (!backend) break; // 池已无候选,跳出走最终报错(NO_WEB_ACCOUNT_ERROR)
    const memberType = poolMemberType(backend.type);

    // 本功能必须用真正的 ChatGPT 网页会话账号(accountBackend==="web",与主图像管线分派 web
    // 路径同一判据)。WHY:web 偏好只把"账号"候选滤成 web 实现,但池在 web 车道里仍可能返回
    // web 分组内的 api/responses 后端;这些不是 ChatGPT 网页会话,跑不了 web 文件生成。有些
    // 用户的池只有 api/codex 后端、无 web 账号——必须明确报错,绝不拿非 web 后端硬跑。
    // 遇到非 web:仅释放租约(不上报失败——它没失败,只是不适配本功能)、排除后换下一个。
    if (backend.accountBackend !== "web") {
      if (backend.id) excluded.push(`${memberType}:${backend.id}`);
      await releaseImageBackendInflightLease({
        memberType,
        memberId: backend.id,
        leaseId: backend.inflightLeaseId,
        leasePersisted: backend.inflightLeasePersisted,
      }).catch(() => {});
      lastError = NO_WEB_ACCOUNT_ERROR;
      continue;
    }

    let success = false;
    try {
      const result = await generateFileWithChatGptWeb({
        config: resolved!.config,
        kind,
        prompt,
        images,
      });
      // 存 storage(先存后扣费:存失败不扣费)。
      const primaryUrl = await storeEditableBinary(
        userId,
        kind,
        result.primary,
        false
      );
      const zipUrl = result.zip
        ? await storeEditableBinary(userId, kind, result.zip, true)
        : null;
      // 按固定价扣费(仅成功;幂等键防重复扣;金额后台可配,默认 25)。
      const amount = Math.max(
        0,
        Math.trunc(
          await getRuntimeSettingNumber(
            kind === "psd"
              ? "EDITABLE_FILE_PSD_CREDITS"
              : "EDITABLE_FILE_PPT_CREDITS",
            DEFAULT_EDITABLE_CREDITS
          )
        )
      );
      let creditsCharged = 0;
      if (amount > 0) {
        await consumeCredits({
          userId,
          amount,
          serviceName: editableFileServiceName(kind),
          description: kind === "psd" ? "生成 PSD 文件" : "生成 PPT 文件",
          sourceRef: `editable-file:${taskId}`,
          metadata: {
            kind,
            taskId,
            conversationId: result.conversationId,
            apiKeyId: apiKeyId || null,
          },
        });
        creditsCharged = amount;
      }
      success = true;
      return {
        conversationId: result.conversationId,
        primaryUrl,
        zipUrl,
        creditsCharged,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (backend.id) excluded.push(`${memberType}:${backend.id}`);
      logWarn("可编辑文件生成失败,换号重试", {
        taskId,
        kind,
        attempt,
        memberId: backend.id,
        error: lastError,
      });
    } finally {
      // 无论成败都释放租约 + 上报池健康(不阻断主流程)。
      await releaseImageBackendInflightLease({
        memberType,
        memberId: backend.id,
        leaseId: backend.inflightLeaseId,
        leasePersisted: backend.inflightLeasePersisted,
      }).catch(() => {});
      await reportImageBackendResult({
        memberType,
        memberId: backend.id,
        success,
        error: success ? undefined : lastError,
      }).catch(() => {});
    }
  }
  throw new Error(lastError || "editable file generation failed after retries");
}
