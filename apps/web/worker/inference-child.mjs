/** 单任务隔离进程：先校验字节/像素，再加载 ONNX；只通过 IPC 返回有限字节。 */
import sharp from "sharp";
import {
  INPUT_FORMATS,
  LIMITS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  validDimensions,
} from "./inference-protocol.mjs";

sharp.cache(false);
sharp.concurrency(1);

/** IPC 一次性输入，模型失败只返回固定状态，禁止泄漏路径/模型错误正文。 */
process.once("message", async ({ operation, image }) => {
  try {
    if (
      !Object.hasOwn(LIMITS, operation) ||
      !Buffer.isBuffer(image) ||
      !image.length ||
      image.length > MAX_INPUT_BYTES
    )
      throw new Error("input");
    const metadata = await sharp(image, {
      limitInputPixels: LIMITS[operation].maxPixels,
    }).metadata();
    if (
      !INPUT_FORMATS.includes(metadata.format) ||
      !validDimensions(operation, metadata)
    )
      throw new Error("dimensions");
    const models = await import("./inference-models.mjs");
    const run =
      operation === "restoration"
        ? models.restoreImage
        : operation === "matte"
          ? models.removeBackground
          : models.superResolve;
    const output = await run(image);
    if (
      !Buffer.isBuffer(output) ||
      !output.length ||
      output.length > MAX_OUTPUT_BYTES
    )
      throw new Error("output");
    const result = await sharp(output, {
      limitInputPixels: 16_777_216,
    }).metadata();
    if (
      result.format !== "png" ||
      (result.pages ?? 1) !== 1 ||
      result.width !== metadata.width * LIMITS[operation].scale ||
      result.height !== metadata.height * LIMITS[operation].scale ||
      (operation === "matte" && !result.hasAlpha)
    )
      throw new Error("output_dimensions");
    process.send?.({ output });
  } catch {
    process.send?.({ error: "inference_failed" });
  }
});
// 父进程消失即退出；不生成临时文件，也不将用户内容打印到日志。
process.once("disconnect", () => process.exit(0));
