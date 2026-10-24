/** Web 高清修复 adapter；SCUNet 仅在独立 worker 子进程内运行。 */
import { logWarn } from "@repo/shared/logger";
import {
  type InferenceOptions,
  InferenceWorkerError,
  invokeInferenceWorker,
} from "./inference-worker";

/**
 * 修复成功返回同尺寸 PNG；关闭/超限/故障返回原图 applied=false。
 * 显式取消上抛，不转换成成功；任何失败均不尝试 Web 推理。
 */
export async function restoreImage(
  image: Buffer,
  options: InferenceOptions = {}
): Promise<{ buffer: Buffer; applied: boolean }> {
  try {
    const buffer = await invokeInferenceWorker("restoration", image, options);
    return { buffer, applied: true };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logWarn("图像修复未应用，返回原图", {
      code: error instanceof InferenceWorkerError ? error.code : "unavailable",
    });
    return { buffer: image, applied: false };
  }
}
