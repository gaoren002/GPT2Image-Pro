/** PSD 与透明背景回退共用的 ISNet relay；本模块不得加载 ONNX 或 session。 */
import {
  type InferenceOptions,
  invokeInferenceWorker,
} from "../image-generation/inference-worker";

/** 移除背景并返回同尺寸透明 PNG；关闭/超限/故障/取消显式失败，无本地备用推理。 */
export async function removeBackground(
  image: Buffer,
  options: InferenceOptions = {}
): Promise<Buffer> {
  return invokeInferenceWorker("matte", image, options);
}
