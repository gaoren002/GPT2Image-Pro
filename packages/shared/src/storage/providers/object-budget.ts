/** 存储提供者共用的流式读取预算：真实字节超限或取消时关闭流，不先缓冲完整对象。 */
export type ObjectReadOptions = { signal?: AbortSignal; maxBytes?: number };

/** 校验服务端传入的读取预算；非法值失败关闭，不能无意关掉保护。 */
export function assertObjectReadBudget(options?: ObjectReadOptions) {
  if (
    options?.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
  ) {
    throw new Error("Invalid object byte limit.");
  }
  options?.signal?.throwIfAborted();
}

/** 合并有界正文，允许未提供上限的既有调用方保持原行为；所有路径均释放reader。 */
export async function readObjectBody(
  body: ReadableStream<Uint8Array>,
  options?: ObjectReadOptions,
  contentLength?: number
): Promise<Buffer> {
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(options?.signal?.reason).catch(() => undefined);
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    assertObjectReadBudget(options);
    if (
      options?.maxBytes !== undefined &&
      contentLength !== undefined &&
      contentLength > options.maxBytes
    ) {
      throw new Error("Object exceeds the byte limit.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      options?.signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (options?.maxBytes !== undefined && size > options.maxBytes) {
        throw new Error("Object exceeds the byte limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
