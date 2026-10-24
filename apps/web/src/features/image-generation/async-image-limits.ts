/** images async 的交付上界；供管线执行前预留与成功结算前校验共用，不影响同步请求。 */
export const ASYNC_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const ASYNC_IMAGE_MAX_RELAY_OUTPUTS = 4;
/** 请求批次与每次生成的候选图是两个维度；n 个生成需预留 n × 4 个候选。 */
export const ASYNC_IMAGE_MAX_RELAY_BATCH_COUNT = 4;
export const ASYNC_IMAGE_MAX_STORAGE_OUTPUTS = 64;
export const ASYNC_IMAGE_METADATA_BYTES = 32 * 1024;
export const ASYNC_IMAGE_STORAGE_RESERVATION_BYTES = 128 * 1024;
export const ASYNC_IMAGE_RELAY_RESERVATION_BYTES =
  ASYNC_IMAGE_MAX_RELAY_OUTPUTS * Math.ceil(ASYNC_IMAGE_MAX_BYTES / 3) * 4 +
  ASYNC_IMAGE_STORAGE_RESERVATION_BYTES;
