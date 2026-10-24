/** Web 与独立 worker 共用的纯协议常量；不得引入模型、文件或业务凭据。 */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// 上游生成与 PSD 层只接受栅格产物，禁止 SVG 等可包含外部资源引用的输入。
export const INPUT_FORMATS = Object.freeze(["png", "jpeg", "webp"]);
export const LIMITS = Object.freeze({
  restoration: Object.freeze({ maxEdge: 2048, maxPixels: 4_194_304, scale: 1 }),
  matte: Object.freeze({ maxEdge: 8192, maxPixels: 16_777_216, scale: 1 }),
  "super-resolution": Object.freeze({
    maxEdge: 4096,
    maxPixels: 1_048_576,
    scale: 4,
  }),
});
/** 校验整数尺寸、单页图像及输出像素预算；只读 metadata，不解码大图。 */
export function validDimensions(operation, metadata) {
  const limit = LIMITS[operation];
  const { width, height, pages = 1 } = metadata;
  return Boolean(
    limit &&
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      pages === 1 &&
      Math.max(width, height) <= limit.maxEdge &&
      width * height <= limit.maxPixels
  );
}
/** 模型只允许固定 float32 shape；拒绝缺失/过长/非有限数据，避免越界编码。 */
export function checkTensor(tensor, shape) {
  if (
    !(tensor.data instanceof Float32Array) ||
    tensor.dims.length !== shape.length ||
    shape.some((value, index) => value !== tensor.dims[index]) ||
    tensor.data.length !== shape.reduce((a, b) => a * b, 1)
  )
    throw new Error("invalid tensor");
  for (const value of tensor.data)
    if (!Number.isFinite(value)) throw new Error("invalid tensor");
}
