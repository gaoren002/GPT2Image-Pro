/** images async 的交付上界；供管线执行前预留与成功结算前校验共用，不影响同步请求。 */
import { IMAGE_PROMPT_MAX_CHARACTERS } from "./resolution";

export const ASYNC_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const ASYNC_IMAGE_MAX_RELAY_OUTPUTS = 4;
/** 请求批次与每次生成的候选图是两个维度；n 个生成需预留 n × 4 个候选。 */
export const ASYNC_IMAGE_MAX_RELAY_BATCH_COUNT = 4;
export const ASYNC_IMAGE_MAX_STORAGE_OUTPUTS = 64;
/**
 * 每张图允许完整的 32000 字符 revised_prompt；最坏 JSON 转义每 UTF-16
 * 码元占 6 字节，另留 4 KiB 给 URL 与字段名。不能把字符上限误作 UTF-8 字节。
 */
export const ASYNC_IMAGE_METADATA_BYTES_PER_OUTPUT =
  IMAGE_PROMPT_MAX_CHARACTERS * 6 + 4 * 1024;
/** 仅计每张图实际交付的字段，不重复计入内部提示词副本；1024 字节覆盖数组封装。 */
export const ASYNC_IMAGE_METADATA_BYTES =
  ASYNC_IMAGE_MAX_STORAGE_OUTPUTS * ASYNC_IMAGE_METADATA_BYTES_PER_OUTPUT +
  1024;
export const ASYNC_IMAGE_STORAGE_RESERVATION_BYTES =
  ASYNC_IMAGE_METADATA_BYTES + 128 * 1024;
export const ASYNC_IMAGE_RELAY_RESERVATION_BYTES =
  ASYNC_IMAGE_MAX_RELAY_OUTPUTS * Math.ceil(ASYNC_IMAGE_MAX_BYTES / 3) * 4 +
  ASYNC_IMAGE_MAX_RELAY_OUTPUTS * ASYNC_IMAGE_METADATA_BYTES_PER_OUTPUT +
  1024 +
  128 * 1024;
