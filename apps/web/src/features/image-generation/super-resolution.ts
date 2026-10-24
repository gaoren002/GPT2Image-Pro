/**
 * Real-ESRGAN Web 客户端：与修复/抠图共用有界 relay，ONNX 只在独立 worker 子进程运行。
 * 保留既有 scale、路由、认证头及 PNG Buffer 契约；取消/超时/关闭/协议错误显式上抛。
 */
import {
  type InferenceOptions,
  invokeInferenceWorker,
} from "./inference-worker";

/** 固定 4x，保留调用方与分辨率校准依赖的协议 metadata。 */
export const SUPER_RESOLUTION_SCALE = 4;

/**
 * 发送原始图片字节并返回精确 4x PNG；统一禁止跳转、限制输入/响应及共用四槽。
 * 非取消故障由 calibration 决定原图降级；调用方 signal 传入同一 relay 期限链。
 */
export async function superResolve(
  image: Buffer,
  options: InferenceOptions = {}
): Promise<Buffer> {
  return invokeInferenceWorker("super-resolution", image, options);
}
