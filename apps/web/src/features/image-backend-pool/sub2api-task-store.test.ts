/** Sub2API 配置写路径：用事务替身编排行锁，避免缓存/并发覆写与故障清空。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  value: [
    { id: "a", enabled: true },
    { id: "b", enabled: true },
  ] as unknown,
  failure: false,
  reads: 0,
  writes: 0,
  locks: 0,
  cacheReads: 0,
  queue: Promise.resolve(),
}));
vi.mock("@repo/database/schema", () => ({
  systemSetting: { key: "key", value: "value" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: vi.fn(),
  getRuntimeSettingJson: () => {
    state.cacheReads++;
    return [];
  },
}));
vi.mock("@repo/database", () => {
  function select() {
    const read = () => {
      state.reads++;
      if (state.failure) throw new Error("read failed");
      return [{ value: structuredClone(state.value) }];
    };
    const query = {
      from: () => query,
      where: () => query,
      limit: () => Promise.resolve().then(read),
      for: () => {
        state.locks++;
        return Promise.resolve().then(read);
      },
    };
    return query;
  }
  const tx = {
    select,
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    }),
    update: () => ({
      set: (value: { value: unknown }) => ({
        where: async () => {
          state.writes++;
          state.value = structuredClone(value.value);
        },
      }),
    }),
  };
  return {
    db: {
      ...tx,
      transaction: async (run: (t: typeof tx) => Promise<unknown>) => {
        const previous = state.queue;
        let unlock = () => {};
        state.queue = new Promise<void>((done) => {
          unlock = done;
        });
        await previous;
        try {
          return await run(tx);
        } finally {
          unlock();
        }
      },
    },
  };
});
import {
  mutateSub2ApiTaskSetting,
  readSub2ApiTaskSetting,
} from "./sub2api-task-store";
type Task = { id: string; enabled: boolean; result?: string };
function normalize(value: unknown): Task | null {
  return value && typeof value === "object" && "id" in value
    ? (value as Task)
    : null;
}
beforeEach(() => {
  Object.assign(state, {
    value: [
      { id: "a", enabled: true },
      { id: "b", enabled: true },
    ],
    failure: false,
    reads: 0,
    writes: 0,
    locks: 0,
    cacheReads: 0,
    queue: Promise.resolve(),
  });
});
describe("atomic task setting", () => {
  it("reads authoritative data without the empty runtime cache", async () => {
    expect(await readSub2ApiTaskSetting(normalize)).toHaveLength(2);
    expect(state.cacheReads).toBe(0);
  });
  it("aborts on read failure with zero writes", async () => {
    state.failure = true;
    await expect(
      mutateSub2ApiTaskSetting(normalize, () => ({ tasks: [], result: null }))
    ).rejects.toThrow();
    expect(state.writes).toBe(0);
    expect(state.value).toHaveLength(2);
  });
  it("serializes independent concurrent edits and merges result into current options", async () => {
    await Promise.all([
      mutateSub2ApiTaskSetting(normalize, (tasks) => ({
        tasks: tasks.map((t) => (t.id === "a" ? { ...t, enabled: false } : t)),
        result: null,
      })),
      mutateSub2ApiTaskSetting(normalize, (tasks) => ({
        tasks: tasks.map((t) => (t.id === "b" ? { ...t, enabled: false } : t)),
        result: null,
      })),
      mutateSub2ApiTaskSetting(normalize, (tasks) => ({
        tasks: tasks.map((t) => (t.id === "a" ? { ...t, result: "done" } : t)),
        result: null,
      })),
    ]);
    expect(state.value).toEqual([
      { id: "a", enabled: false, result: "done" },
      { id: "b", enabled: false },
    ]);
    expect(state.locks).toBe(3);
    expect(state.cacheReads).toBe(0);
  });
  it("does not resurrect deleted tasks when late results arrive", async () => {
    await mutateSub2ApiTaskSetting(normalize, (tasks) => ({
      tasks: tasks.filter((t) => t.id !== "a"),
      result: null,
    }));
    await mutateSub2ApiTaskSetting(normalize, (tasks) => ({
      tasks: tasks.map((t) => (t.id === "a" ? { ...t, result: "late" } : t)),
      result: null,
    }));
    expect(state.value).toEqual([{ id: "b", enabled: true }]);
  });
  it.each([
    null,
    {},
    "not json",
    [{ invalid: true }],
  ])("rejects malformed stored values instead of replacing them with []: %j", async (value) => {
    state.value = value;
    await expect(
      mutateSub2ApiTaskSetting(normalize, () => ({ tasks: [], result: null }))
    ).rejects.toThrow();
    expect(state.writes).toBe(0);
  });
  it("accepts the legacy {tasks: [...]} envelope", async () => {
    state.value = { tasks: [{ id: "a", enabled: true }] };
    expect(await readSub2ApiTaskSetting(normalize)).toEqual([
      { id: "a", enabled: true },
    ]);
  });
  it("accepts JSON text saved by the legacy settings editor", async () => {
    state.value = JSON.stringify([{ id: "a", enabled: true }]);
    expect(await readSub2ApiTaskSetting(normalize)).toEqual([
      { id: "a", enabled: true },
    ]);
  });
});
