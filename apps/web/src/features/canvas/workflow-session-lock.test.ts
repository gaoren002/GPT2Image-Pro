/** 独占编辑锁回归：多会话互斥、StrictMode 取消、延迟 flush、浏览器缺失与失败后释放。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireWorkflowSessionLock,
  type WorkflowLockManager,
} from "./workflow-session-lock";
import {
  createWorkflowTestLocks,
  workflowTestGate,
} from "./workflow-test-locks";

afterEach(() => vi.unstubAllGlobals());

describe("工作流会话独占锁", () => {
  it("同账号同时只能一份会话可写，显式释放后可重新获取", async () => {
    const fake = createWorkflowTestLocks();
    const first = await acquireWorkflowSessionLock(
      "exclusive",
      new AbortController().signal,
      fake.manager
    );
    expect(fake.calls[0]).toMatchObject({
      mode: "exclusive",
      ifAvailable: true,
    });
    await expect(
      acquireWorkflowSessionLock(
        "exclusive",
        new AbortController().signal,
        fake.manager
      )
    ).rejects.toThrow(/另一个标签页/);
    expect(fake.held.size).toBe(1);
    await Promise.all([first.release(), first.release()]);
    expect(fake.held.size).toBe(0);
    const second = await acquireWorkflowSessionLock(
      "exclusive",
      new AbortController().signal,
      fake.manager
    );
    await second.release();
  });
  it("不同账号独立持锁", async () => {
    const fake = createWorkflowTestLocks();
    const first = await acquireWorkflowSessionLock(
      "independent-a",
      new AbortController().signal,
      fake.manager
    );
    const second = await acquireWorkflowSessionLock(
      "independent-b",
      new AbortController().signal,
      fake.manager
    );
    expect(fake.held.size).toBe(2);
    await Promise.all([first.release(), second.release()]);
  });
  it("浏览器拒绝锁时立即失败，不能进入可编辑的无锁降级", async () => {
    const fake = createWorkflowTestLocks();
    fake.denyRequests(true);
    await expect(
      acquireWorkflowSessionLock(
        "external",
        new AbortController().signal,
        fake.manager
      )
    ).rejects.toThrow(/关闭该页面/);
    expect(fake.held.size).toBe(0);
    fake.denyRequests(false);
    const retry = await acquireWorkflowSessionLock(
      "external",
      new AbortController().signal,
      fake.manager
    );
    await retry.release();
  });
  it("StrictMode 初始化取消后，第二 effect 等待旧异步回调真正释放", async () => {
    const fake = createWorkflowTestLocks();
    const gate = workflowTestGate();
    fake.pauseNextCallback(gate.promise);
    const firstSignal = new AbortController();
    const first = acquireWorkflowSessionLock(
      "strict-pending",
      firstSignal.signal,
      fake.manager
    );
    const cancelled = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    firstSignal.abort();
    const second = acquireWorkflowSessionLock(
      "strict-pending",
      new AbortController().signal,
      fake.manager
    );
    await Promise.resolve();
    expect(fake.calls).toHaveLength(1);
    gate.release();
    await cancelled;
    const lock = await second;
    expect(fake.calls).toHaveLength(2);
    expect(fake.held.size).toBe(1);
    await lock.release();
  });
  it("已交付的会话在取消后仍保护末次 flush，第二 effect 等待显式 release", async () => {
    const fake = createWorkflowTestLocks();
    const firstSignal = new AbortController();
    const first = await acquireWorkflowSessionLock(
      "strict-flush",
      firstSignal.signal,
      fake.manager
    );
    firstSignal.abort();
    const second = acquireWorkflowSessionLock(
      "strict-flush",
      new AbortController().signal,
      fake.manager
    );
    await Promise.resolve();
    expect(fake.calls).toHaveLength(1);
    expect(fake.held.size).toBe(1);
    await first.release();
    const lock = await second;
    expect(fake.calls).toHaveLength(2);
    await lock.release();
  });
  it("已取消的初始化不向浏览器申请锁", async () => {
    const fake = createWorkflowTestLocks();
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireWorkflowSessionLock("pre-aborted", controller.signal, fake.manager)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.calls).toHaveLength(0);
  });
  it("不支持 Web Locks 时 fail closed，明确提示升级浏览器", async () => {
    vi.stubGlobal("navigator", {});
    await expect(
      acquireWorkflowSessionLock("unsupported", new AbortController().signal)
    ).rejects.toThrow(/不支持 Web Locks/);
  });
  it("浏览器请求同步异常不遗留本页占用记录", async () => {
    const broken: WorkflowLockManager = {
      request() {
        throw new Error("security denied");
      },
    };
    await expect(
      acquireWorkflowSessionLock(
        "broken-request",
        new AbortController().signal,
        broken
      )
    ).rejects.toThrow(/security denied/);
    const fake = createWorkflowTestLocks();
    const lock = await acquireWorkflowSessionLock(
      "broken-request",
      new AbortController().signal,
      fake.manager
    );
    await lock.release();
  });
});
