/** 工作流测试专用 Web Locks 替身；真实互斥与回调延迟可控，不参与生产编辑器依赖。 */
import type { WorkflowLockManager } from "./workflow-session-lock";

/** 建立手动完成的异步屏障，用于初始化与末次保存竞态测试，不使用定时等待。 */
export function workflowTestGate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 模拟浏览器 exclusive/ifAvailable 契约：锁在请求回调结束时才释放。 */
export function createWorkflowTestLocks() {
  const held = new Set<string>();
  const calls: { name: string; mode: string; ifAvailable: boolean }[] = [];
  let deny = false;
  let nextCallbackGate: Promise<void> | undefined;
  const manager: WorkflowLockManager = {
    async request(name, options, callback) {
      calls.push({ name, ...options });
      const available = !deny && !held.has(name);
      if (available) held.add(name);
      const gate = nextCallbackGate;
      nextCallbackGate = undefined;
      try {
        await Promise.resolve();
        if (gate) await gate;
        await callback(available ? { name } : null);
      } finally {
        if (available) held.delete(name);
      }
    },
  };
  return {
    manager,
    held,
    calls,
    /** 模拟另一个浏览器标签页已经持锁，当前页面内没有协调器记录。 */
    denyRequests(value: boolean) {
      deny = value;
    },
    /** 暂停下一次回调，模拟 effect 清理发生在浏览器完成初始化之前。 */
    pauseNextCallback(promise: Promise<void>) {
      nextCallbackGate = promise;
    },
  };
}
