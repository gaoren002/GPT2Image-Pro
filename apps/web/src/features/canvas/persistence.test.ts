/**
 * 画布局部持久化回归：使用真实 fake-indexeddb 事务验证隔离、恢复和失败回滚。
 * 仅在故障注入处拦截原生入口；不模拟成功事务或依赖浏览器 localStorage。
 */
import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory as FakeIDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
  forceCloseDatabase,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CANVAS_BYTES, openCanvasStorage } from "./persistence";

const DATABASE_NAME = "gpt2image-canvas";
const STORE_NAME = "scenes";
type Storage = Awaited<ReturnType<typeof openCanvasStorage>>;
type Workspace = NonNullable<Parameters<typeof openCanvasStorage>[1]>;

let factory: IDBFactory;
const handles = new Set<Storage>();
const rawConnections = new Set<IDBDatabase>();

/** 构造含内嵌图片与未知附加字段的 v2 JSON，验证原文无损往返。 */
function scene(label: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [{ id: "image", type: "image", fileId: "file" }],
    files: {
      file: {
        id: "file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aGVsbG8=",
        created: 1,
      },
    },
    appState: { viewBackgroundColor: "#fff" },
    label,
  });
}

/** 工作流只约束顶层形状，节点内部与 viewport 细字段交给 UI 校验。 */
function workflow(label: string): string {
  return JSON.stringify({
    type: "gpt2image-workflow",
    version: 1,
    nodes: [{ arbitrary: label }],
    edges: [{ custom: true }],
    viewport: { x: 1, y: 2, zoom: 0.5 },
    label,
  });
}

/** 构造指定 UTF-8 字节数的合法 ASCII 场景，图片字符串占据主要体积。 */
function sceneWithBytes(bytes: number): string {
  const prefix =
    '{"type":"excalidraw","version":2,"elements":[],"files":{"image":{"dataURL":"';
  const suffix = '"}}}';
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

/** 注册公开句柄，测试结束时释放，避免连接污染后续用例。 */
async function storage(
  userId = "alice",
  workspace?: Workspace
): Promise<Storage> {
  const handle = await openCanvasStorage(userId, workspace);
  handles.add(handle);
  return handle;
}

/** 直接连接真实数据库，用于注入坏记录、冲突版本或观察原始持久数据。 */
function rawDatabase(version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("测试数据库连接被阻塞"));
    request.onsuccess = () => {
      rawConnections.add(request.result);
      resolve(request.result);
    };
  });
}

/** 在测试的原生连接上执行事务并等待提交，不跳过 IDB 的异步错误路径。 */
function rawTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => {
      result = request.result;
    };
  });
}

beforeEach(() => {
  factory = new FakeIDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

afterEach(() => {
  for (const handle of handles) handle.close();
  for (const connection of rawConnections) connection.close();
  handles.clear();
  rawConnections.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas IndexedDB persistence", () => {
  it("returns null only for a missing record and round-trips embedded files", async () => {
    const handle = await storage();
    expect(await handle.read()).toBeNull();
    const original = `\n ${scene("图片草稿")}\n`;
    await handle.write(original);
    expect(await handle.read()).toBe(original);
  });

  it("isolates exact account keys and stores one replaceable workspace per user", async () => {
    const alice = await storage("alice");
    const bob = await storage("bob");
    const padded = await storage(" alice");
    const unusual = await storage("__proto__");
    await alice.write(scene("alice old"));
    expect(await bob.read()).toBeNull();
    expect(await padded.read()).toBeNull();
    expect(await unusual.read()).toBeNull();
    await bob.write(scene("bob"));
    await padded.write(scene("padded"));
    await unusual.write(scene("unusual"));
    await alice.write(scene("alice new"));
    expect(await alice.read()).toBe(scene("alice new"));
    expect(await bob.read()).toBe(scene("bob"));
    expect(await padded.read()).toBe(scene("padded"));
    expect(await unusual.read()).toBe(scene("unusual"));
  });

  it("restores committed JSON after closing and reopening", async () => {
    const first = await storage();
    await first.write(scene("persisted"));
    first.close();
    const second = await storage();
    expect(await second.read()).toBe(scene("persisted"));
    expect(await (await storage("bob")).read()).toBeNull();
  });

  it("isolates all three tabs for each account and restores every composite key", async () => {
    const workspaces: Workspace[] = ["images", "whiteboard", "workflow"];
    for (const userId of ["alice", "bob"]) {
      for (const workspace of workspaces) {
        const handle = await storage(userId, workspace);
        expect(await handle.read()).toBeNull();
        const label = `${userId}/${workspace}`;
        await handle.write(
          workspace === "workflow" ? workflow(label) : scene(label)
        );
        handle.close();
      }
    }
    await (await storage("alice", "whiteboard")).write(
      scene("only whiteboard")
    );
    for (const userId of ["alice", "bob"]) {
      for (const workspace of workspaces) {
        const label = `${userId}/${workspace}`;
        const expected =
          userId === "alice" && workspace === "whiteboard"
            ? scene("only whiteboard")
            : workspace === "workflow"
              ? workflow(label)
              : scene(label);
        expect(await (await storage(userId, workspace)).read()).toBe(expected);
      }
    }
    expect(await (await storage()).read()).toBe(scene("alice/images"));
  });

  it.each<Workspace>([
    "images",
    "whiteboard",
    "workflow",
  ])("retains other tabs and accounts when a %s write fails", async (workspace) => {
    const images = await storage("alice", "images");
    const whiteboard = await storage("alice", "whiteboard");
    const graph = await storage("alice", "workflow");
    const otherAccount = await storage("bob", workspace);
    await images.write(scene("images"));
    await whiteboard.write(scene("whiteboard"));
    await graph.write(workflow("workflow"));
    const existing = workspace === "workflow" ? workflow("bob") : scene("bob");
    await otherAccount.write(existing);
    const target = await storage("alice", workspace);
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Quota exhausted", "QuotaExceededError");
    });
    await expect(
      target.write(workspace === "workflow" ? workflow("new") : scene("new"))
    ).rejects.toThrow(/QuotaExceededError/);
    expect(await images.read()).toBe(scene("images"));
    expect(await whiteboard.read()).toBe(scene("whiteboard"));
    expect(await graph.read()).toBe(workflow("workflow"));
    expect(await otherAccount.read()).toBe(existing);
  });

  it("rejects an unknown runtime workspace before opening IDB", async () => {
    const open = vi.spyOn(factory, "open");
    await expect(
      openCanvasStorage("alice", "other" as Workspace)
    ).rejects.toThrow(/workspace/);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    "images",
    "whiteboard",
  ] as const)("rejects workflow data in the %s workspace", async (workspace) => {
    const handle = await storage("alice", workspace);
    await handle.write(scene("old"));
    await expect(handle.write(workflow("wrong workspace"))).rejects.toThrow();
    expect(await handle.read()).toBe(scene("old"));
  });

  it("accepts workflow without viewport and leaves node semantics to the UI", async () => {
    const handle = await storage("alice", "workflow");
    const original =
      '{"type":"gpt2image-workflow","version":1,"nodes":[null,1],"edges":[{}]}';
    await handle.write(original);
    expect(await handle.read()).toBe(original);
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    scene("wrong workspace"),
    '{"type":"gpt2image-workflow","version":2,"nodes":[],"edges":[]}',
    '{"type":"gpt2image-workflow","version":"1","nodes":[],"edges":[]}',
    '{"type":"gpt2image-workflow","version":1,"nodes":{},"edges":[]}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[]}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[],"edges":{}}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[],"edges":[],"viewport":null}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[],"edges":[],"viewport":[]}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[],"edges":[],"viewport":1}',
  ])("rejects bad workflow shape/version before writing: %s", async (invalid) => {
    const handle = await storage("alice", "workflow");
    await handle.write(workflow("old"));
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    await expect(handle.write(invalid)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(await handle.read()).toBe(workflow("old"));
  });

  it("allows independent handles for the same account and commits in call order", async () => {
    const first = await storage();
    const second = await storage();
    await Promise.all([
      first.write(scene("first")),
      second.write(scene("last")),
    ]);
    first.close();
    expect(await second.read()).toBe(scene("last"));
  });

  it("does not access localStorage", async () => {
    const access = vi.fn(() => {
      throw new Error("localStorage must not be used");
    });
    vi.stubGlobal("localStorage", { getItem: access, setItem: access });
    const handle = await storage();
    await handle.write(scene("idb"));
    expect(await handle.read()).toBe(scene("idb"));
    expect(access).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " ",
    "\n\t",
  ])("rejects an empty account %j before opening IDB", async (id) => {
    const open = vi.spyOn(factory, "open");
    await expect(openCanvasStorage(id)).rejects.toThrow(/userId/);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects unavailable IndexedDB without using a fallback", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openCanvasStorage("alice")).rejects.toThrow(/IndexedDB/);
  });

  it("preserves synchronous SecurityError when opening is denied", async () => {
    const cause = new DOMException("Storage is denied", "SecurityError");
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw cause;
    });
    await expect(openCanvasStorage("alice")).rejects.toMatchObject({
      message: expect.stringContaining("SecurityError"),
      cause,
    });
  });

  it("rejects an incompatible database version through the real open error event", async () => {
    (await rawDatabase(2)).close();
    await expect(openCanvasStorage("alice")).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "VersionError" }),
    });
  });

  it("rejects schema upgrade failures and rolls back the incomplete database", async () => {
    const cause = new DOMException("Disk unavailable", "UnknownError");
    const create = vi
      .spyOn(FakeIDBDatabase.prototype, "createObjectStore")
      .mockImplementationOnce(() => {
        throw cause;
      });
    await expect(openCanvasStorage("alice")).rejects.toMatchObject({ cause });
    create.mockRestore();
    expect(await (await storage()).read()).toBeNull();
  });

  it("rejects a blocked open and releases the late upgrade request", async () => {
    const blocker = await rawDatabase();
    const nativeOpen = factory.open;
    let lateRequest: IDBOpenDBRequest | undefined;
    vi.spyOn(factory, "open").mockImplementationOnce((name) => {
      lateRequest = nativeOpen.call(factory, name, 2);
      return lateRequest;
    });
    const opening = openCanvasStorage("alice");
    await expect(opening).rejects.toThrow(/阻塞/);
    const finished = new Promise<void>((resolve) => {
      lateRequest?.addEventListener("error", () => resolve());
    });
    blocker.close();
    await finished;
    expect(await (await storage()).read()).toBeNull();
  });

  it("rejects read and write after an idempotent close but finishes in-flight work", async () => {
    const handle = await storage();
    const writing = handle.write(scene("in flight"));
    handle.close();
    handle.close();
    await expect(handle.read()).rejects.toThrow(/关闭/);
    await expect(handle.write(scene("too late"))).rejects.toThrow(/关闭/);
    await writing;
    expect(await (await storage()).read()).toBe(scene("in flight"));
  });

  it("closes stale handles on versionchange and does not block other connections", async () => {
    const handle = await storage();
    await handle.write(scene("old schema"));
    (await rawDatabase(2)).close();
    await expect(handle.read()).rejects.toThrow(/关闭/);
    await expect(handle.write(scene("stale"))).rejects.toThrow(/关闭/);
  });

  it("rejects access after an unexpected native database close", async () => {
    let opened: IDBDatabase | undefined;
    const nativeOpen = factory.open;
    vi.spyOn(factory, "open").mockImplementationOnce((name, version) => {
      const request = nativeOpen.call(factory, name, version);
      request.addEventListener("success", () => {
        opened = request.result;
      });
      return request;
    });
    const handle = await storage();
    await handle.write(scene("persisted"));
    if (!opened) throw new Error("测试未捕获数据库连接");
    // 6.2.5 声明误将参数标成构造器；实际 API 接受数据库实例。
    const forceClose = forceCloseDatabase as unknown as (
      database: IDBDatabase
    ) => void;
    const closed = new Promise<void>((resolve) => {
      opened?.addEventListener("close", () => resolve());
    });
    forceClose(opened);
    await closed;
    await expect(handle.read()).rejects.toThrow(/关闭/);
    await expect(handle.write(scene("too late"))).rejects.toThrow(/关闭/);
    expect(await (await storage()).read()).toBe(scene("persisted"));
  });

  it("reports transaction creation failures instead of returning an empty draft", async () => {
    const handle = await storage();
    const cause = new DOMException("Database failed", "UnknownError");
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(
      () => {
        throw cause;
      }
    );
    await expect(handle.read()).rejects.toMatchObject({ cause });
  });

  it("preserves the old scene on synchronous quota failure", async () => {
    const handle = await storage();
    await handle.write(scene("old"));
    const cause = new DOMException("Quota exhausted", "QuotaExceededError");
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw cause;
    });
    await expect(handle.write(scene("new"))).rejects.toMatchObject({
      message: expect.stringContaining("QuotaExceededError"),
      cause,
    });
    expect(await handle.read()).toBe(scene("old"));
  });

  it("keeps DOM-style error names even without instanceof Error", async () => {
    const handle = await storage();
    const cause = { name: "QuotaExceededError", message: "Quota exhausted" };
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw cause;
    });
    await expect(handle.write(scene("new"))).rejects.toMatchObject({
      message: expect.stringContaining("QuotaExceededError"),
      cause,
    });
    expect(await handle.read()).toBeNull();
  });

  it("preserves the old scene on a real asynchronous request error and abort", async () => {
    const handle = await storage();
    await handle.write(scene("old"));
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(
      function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        // 重复键的 add 由真实 IDB 产生 ConstraintError，并自动中止写事务。
        return this.add(value, key);
      }
    );
    await expect(handle.write(scene("new"))).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ConstraintError" }),
    });
    expect(await handle.read()).toBe(scene("old"));
  });

  it("waits for commit and rolls back a put aborted after its success event", async () => {
    const handle = await storage();
    await handle.write(scene("old"));
    const nativePut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(
      function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativePut.call(this, value, key);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      }
    );
    await expect(handle.write(scene("new"))).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "AbortError" }),
    });
    expect(await handle.read()).toBe(scene("old"));
    handle.close();
    expect(await (await storage()).read()).toBe(scene("old"));
  });

  it("rejects a read whose transaction aborts after getting a result", async () => {
    const handle = await storage();
    await handle.write(scene("old"));
    const nativeOpenCursor = FakeIDBObjectStore.prototype.openCursor;
    vi.spyOn(FakeIDBObjectStore.prototype, "openCursor").mockImplementationOnce(
      function (
        this: IDBObjectStore,
        key?: IDBValidKey | IDBKeyRange | null,
        direction?: IDBCursorDirection
      ) {
        const request = nativeOpenCursor.call(this, key, direction);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      }
    );
    await expect(handle.read()).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "AbortError" }),
    });
    expect(await handle.read()).toBe(scene("old"));
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"type":"other","version":2,"elements":[],"files":{}}',
    '{"type":"excalidraw","version":1,"elements":[],"files":{}}',
    '{"type":"excalidraw","version":3,"elements":[],"files":{}}',
    '{"type":"excalidraw","version":"2","elements":[],"files":{}}',
    '{"type":"excalidraw","version":2,"elements":{},"files":{}}',
    '{"type":"excalidraw","version":2,"elements":[]}',
    '{"type":"excalidraw","version":2,"elements":[],"files":null}',
    '{"type":"excalidraw","version":2,"elements":[],"files":[]}',
  ])("rejects invalid JSON/format before writing: %s", async (invalid) => {
    const handle = await storage();
    await handle.write(scene("old"));
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    await expect(handle.write(invalid)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(await handle.read()).toBe(scene("old"));
  });

  it.each([
    "not JSON",
    undefined,
    null,
    42,
    '{"type":"excalidraw","version":3,"elements":[],"files":{}}',
    '{"type":"excalidraw","version":2,"elements":[],"files":[]}',
  ])("rejects corrupted persisted data without removing it: %j", async (invalid) => {
    const database = await rawDatabase();
    await rawTransaction(database, "readwrite", (store) =>
      store.put(invalid, ["alice", "images"])
    );
    const handle = await storage();
    await expect(handle.read()).rejects.toThrow();
    expect(
      await rawTransaction(database, "readonly", (store) =>
        store.get(["alice", "images"])
      )
    ).toEqual(invalid);
    expect(await (await storage("bob")).read()).toBeNull();
  });

  it.each([
    scene("wrong workspace"),
    '{"type":"gpt2image-workflow","version":9,"nodes":[],"edges":[]}',
    '{"type":"gpt2image-workflow","version":1,"nodes":[],"edges":[],"viewport":[]}',
  ])("rejects corrupt workflow data on read and retains it: %s", async (invalid) => {
    const database = await rawDatabase();
    const key = ["alice", "workflow"];
    await rawTransaction(database, "readwrite", (store) =>
      store.put(invalid, key)
    );
    const handle = await storage("alice", "workflow");
    await expect(handle.read()).rejects.toThrow();
    expect(
      await rawTransaction(database, "readonly", (store) => store.get(key))
    ).toBe(invalid);
    expect(await (await storage("alice", "images")).read()).toBeNull();
    expect(await (await storage("bob", "workflow")).read()).toBeNull();
  });

  it("accepts exactly 32 MiB and rejects one extra byte before parsing or writing", async () => {
    expect(MAX_CANVAS_BYTES).toBe(32 * 1024 * 1024);
    const handle = await storage();
    const exact = sceneWithBytes(MAX_CANVAS_BYTES);
    await handle.write(exact);
    expect(await handle.read()).toBe(exact);
    const parse = vi.spyOn(JSON, "parse");
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    // 故意用非法 JSON，确认超预算错误优先于 JSON 解析错误。
    await expect(
      handle.write("x".repeat(MAX_CANVAS_BYTES + 1))
    ).rejects.toThrow(/32 MiB/);
    expect(parse).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await handle.read()).toBe(exact);
  });

  it.each([
    "汉",
    "\u{1f600}",
    "\ud800",
    "\udc00",
  ])("counts UTF-8 bytes rather than UTF-16 units for %j", async (character) => {
    const handle = await storage();
    await handle.write(scene("old"));
    const bytesPerCharacter = new TextEncoder().encode(character).length;
    const oversized = character.repeat(
      Math.floor(MAX_CANVAS_BYTES / bytesPerCharacter) + 1
    );
    expect(oversized.length).toBeLessThan(MAX_CANVAS_BYTES);
    const parse = vi.spyOn(JSON, "parse");
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    await expect(handle.write(oversized)).rejects.toThrow(/32 MiB/);
    expect(parse).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await handle.read()).toBe(scene("old"));
  });

  it("rejects oversized stored records and retains their original value", async () => {
    const database = await rawDatabase();
    const oversized = "x".repeat(MAX_CANVAS_BYTES + 1);
    await rawTransaction(database, "readwrite", (store) =>
      store.put(oversized, ["alice", "images"])
    );
    await expect((await storage()).read()).rejects.toThrow(/32 MiB/);
    expect(
      await rawTransaction(database, "readonly", (store) =>
        store.get(["alice", "images"])
      )
    ).toBe(oversized);
  });
});
