/** 工作流编辑会话的浏览器独占锁；保护整文档保存和付费运行，禁止多标签页互相擦除任务锁。 */
export type WorkflowLockManager = {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => Promise<void>
  ): Promise<void>;
};
export type WorkflowSessionLock = {
  release: () => Promise<void>;
};
type LocalSession = {
  signal: AbortSignal;
  releasing: boolean;
  finished: Promise<void>;
};
const localSessions = new Map<string, LocalSession>();
const LOCK_UNAVAILABLE =
  "另一个标签页正在编辑此账号的工作流。请关闭该页面后点击重新读取。";

/** 浏览器不支持独占锁时显式拒绝，不能退化为可能擦除已提交任务记录的无锁编辑。 */
function browserLockManager(): WorkflowLockManager {
  const manager = globalThis.navigator?.locks;
  if (!manager || typeof manager.request !== "function") {
    throw new Error(
      "当前浏览器不支持 Web Locks，无法安全编辑工作流。请升级或更换支持 Web Locks 的新版浏览器。已有草稿未被修改。"
    );
  }
  return manager;
}

/**
 * 在读取 IDB 前获取整段编辑会话的独占锁。其他标签页立刻失败，不进入排队编辑。
 * 同页 StrictMode 旧 effect 已取消时，先等其真实 release，避免新 effect 被旧请求误挡。
 * signal 只取消初始化；已交付的锁必须由调用方在末次保存结束后 release，不能提前解锁。
 */
export async function acquireWorkflowSessionLock(
  userId: string,
  signal: AbortSignal,
  manager?: WorkflowLockManager
): Promise<WorkflowSessionLock> {
  signal.throwIfAborted();
  if (!userId.trim()) throw new Error("工作流独占锁需要非空账号");
  const locks = manager ?? browserLockManager();
  const name = JSON.stringify(["gpt2image-canvas", userId, "workflow"]);
  while (true) {
    const previous = localSessions.get(name);
    if (!previous) break;
    if (!previous.signal.aborted && !previous.releasing)
      throw new Error(LOCK_UNAVAILABLE);
    await previous.finished;
    signal.throwIfAborted();
  }
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entry: LocalSession = { signal, finished, releasing: false };
  localSessions.set(name, entry);

  return new Promise<WorkflowSessionLock>((resolve, reject) => {
    let acquired = false;
    let settled = false;
    /** 只拒绝尚未交付的初始化；已取得锁的 effect 会在 flush 后显式释放。 */
    const onAbort = () => {
      if (!acquired && !settled) {
        settled = true;
        reject(signal.reason ?? new DOMException("初始化已取消", "AbortError"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    /** 浏览器真正释放后再移除本页屏障，后续 effect 不会抢在原回调退出前获取。 */
    const complete = () => {
      signal.removeEventListener("abort", onAbort);
      if (localSessions.get(name) === entry) localSessions.delete(name);
      finish();
    };
    /** 同步异常或浏览器拒绝请求均显式传播，不启用无锁降级。 */
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      complete();
    };
    try {
      const request = locks.request(
        name,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            if (!settled) {
              settled = true;
              reject(new Error(LOCK_UNAVAILABLE));
            }
            return;
          }
          if (signal.aborted || settled) {
            onAbort();
            return;
          }
          let releaseHold: () => void = () => undefined;
          const hold = new Promise<void>((resolveHold) => {
            releaseHold = resolveHold;
          });
          acquired = true;
          settled = true;
          resolve({
            /** 幂等释放，返回浏览器确认释放的屏障，不能只等待调用 release 的时刻。 */
            release() {
              entry.releasing = true;
              releaseHold();
              return finished;
            },
          });
          await hold;
        }
      );
      void request.then(complete, fail);
    } catch (error) {
      fail(error);
    }
  });
}
