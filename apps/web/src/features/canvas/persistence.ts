/**
 * 画布 UI 的本地草稿存储：原生 IndexedDB 按账号和工作区保存 JSON 草稿。
 * 只负责显式读写和校验；序列化、恢复及保存调度由调用方负责，无运行时依赖。
 */
import { assertWorkflowAttemptTransition } from "./workflow-attempt-guard";

export const MAX_CANVAS_BYTES = 32 * 1024 * 1024;

const DATABASE_NAME = "gpt2image-canvas";
const DATABASE_VERSION = 1;
const STORE_NAME = "scenes";

type CanvasWorkspace = "images" | "whiteboard" | "workflow";

type CanvasStorage = {
  read(): Promise<string | null>;
  write(scene: string): Promise<void>;
  close(): void;
};

/** 包装存储故障，显示配额、安全限制等原因，不主动拼入账号或画布内容。 */
function storageError(action: string, cause: unknown): Error {
  const reason =
    isObject(cause) &&
    typeof cause.name === "string" &&
    typeof cause.message === "string"
      ? `（${cause.name}: ${cause.message}）`
      : "";
  return new Error(`画布 IndexedDB ${action}失败${reason}。`, { cause });
}

/**
 * 校验读写两侧的不可信输入，按工作区检查顶层结构，不检查节点内部语义。
 * 先按 UTF-8 限额再解析，避免超大输入触发 JSON 解析或额外的大块编码分配。
 */
function validateScene(
  scene: unknown,
  workspace: CanvasWorkspace
): asserts scene is string {
  if (typeof scene !== "string") {
    throw new TypeError("画布必须是 JSON 字符串。");
  }
  const tooLarge = () => new RangeError("画布超过 32 MiB 的 UTF-8 存储预算。");
  if (scene.length > MAX_CANVAS_BYTES) throw tooLarge();

  let bytes = 0;
  for (let index = 0; index < scene.length; index += 1) {
    const code = scene.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      scene.charCodeAt(index + 1) >= 0xdc00 &&
      scene.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // 孤立代理项按 UTF-8 的替换字符计为三字节，与 TextEncoder 一致。
      bytes += 3;
    }
    if (bytes > MAX_CANVAS_BYTES) throw tooLarge();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(scene);
  } catch (cause) {
    throw new Error("画布不是有效的 JSON。", { cause });
  }
  if (workspace === "workflow") {
    if (
      !isObject(parsed) ||
      parsed.type !== "gpt2image-workflow" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges) ||
      ("viewport" in parsed && !isObject(parsed.viewport))
    ) {
      throw new TypeError(
        "工作流必须为 type='gpt2image-workflow'、version=1，包含 nodes/edges 数组及可选的 viewport 对象。"
      );
    }
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    parsed.type !== "excalidraw"
  ) {
    throw new TypeError("画布必须是 type='excalidraw' 的场景。");
  }
  if (!("version" in parsed) || parsed.version !== 2) {
    throw new TypeError("画布版本不受支持，仅支持 Excalidraw version=2。");
  }
  if (
    !("elements" in parsed) ||
    !Array.isArray(parsed.elements) ||
    !("files" in parsed) ||
    typeof parsed.files !== "object" ||
    parsed.files === null ||
    Array.isArray(parsed.files)
  ) {
    throw new TypeError("画布必须包含 elements 数组和 files 对象。");
  }
}

/** 区分 JSON 对象与 null/数组，仅收窄顶层结构，不递归遍历不可信数据。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 打开独立的画布数据库；拒绝阻塞与升级失败，迟到的连接也会关闭。 */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (cause: unknown) => {
      settled = true;
      reject(storageError("打开", cause));
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (cause) {
      fail(cause);
      return;
    }
    request.onerror = () => fail(request.error);
    request.onblocked = () =>
      fail(new Error("数据库被其他页面阻塞，请关闭占用页面后重试"));
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      try {
        request.result.createObjectStore(STORE_NAME);
      } catch (cause) {
        fail(cause);
        // 此回调中升级事务仍活跃，必须回滚，不能留下不完整的表结构。
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
      } else if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.close();
        fail(new Error("画布数据库缺少 scenes 存储区"));
      } else {
        settled = true;
        resolve(database);
      }
    };
  });
}

/**
 * 执行单请求事务，等 complete 才交付结果，确保请求成功后再 abort 也会失败。
 * 同步请求错误主动回滚；异步请求错误保留默认 abort 行为与原始 cause。
 */
function transact<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const action = mode === "readonly" ? "读取" : "写入";
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch (cause) {
      reject(storageError(action, cause));
      return;
    }
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => {
      failure ??= transaction.error;
    };
    transaction.onabort = () =>
      reject(
        storageError(
          action,
          failure ??
            transaction.error ??
            new DOMException("画布事务已中止", "AbortError")
        )
      );
    try {
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        failure ??= request.error;
      };
    } catch (cause) {
      failure = cause;
      transaction.abort();
    }
  });
}

/** 原子读取当前工作流再检查未知任务；跨浏览器标签页和内存恢复稿都不能绕过。 */
function writeWorkflowScene(
  database: IDBDatabase,
  key: IDBValidKey,
  scene: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, "readwrite");
    } catch (cause) {
      reject(storageError("写入", cause));
      return;
    }
    let failure: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      failure ??= transaction.error;
    };
    transaction.onabort = () =>
      reject(storageError("写入", failure ?? transaction.error));
    try {
      const store = transaction.objectStore(STORE_NAME);
      const current = store.openCursor(key);
      current.onerror = () => {
        failure ??= current.error;
      };
      current.onsuccess = () => {
        try {
          if (current.result) {
            const previous: unknown = current.result.value;
            validateScene(previous, "workflow");
            assertWorkflowAttemptTransition(previous, scene);
          }
          const write = store.put(scene, key);
          write.onerror = () => {
            failure ??= write.error;
          };
        } catch (cause) {
          failure = cause;
          transaction.abort();
        }
      };
    } catch (cause) {
      failure = cause;
      transaction.abort();
    }
  });
}

/**
 * 打开账号的指定工作区，默认 images；复合键精确隔离账号与三个 Tab。
 * 保留原始账号键，不裁剪或映射到共享默认账号。
 * 不可用、配额、事务和坏数据均显式拒绝；close 幂等，拒绝之后的新读写，
 * 已开始的事务继续提交或回滚。数据库版本变化或意外关闭也会使句柄失效。
 */
export async function openCanvasStorage(
  userId: string,
  workspace: CanvasWorkspace = "images"
): Promise<CanvasStorage> {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new TypeError("打开画布需要非空 userId。");
  }
  if (
    workspace !== "images" &&
    workspace !== "whiteboard" &&
    workspace !== "workflow"
  ) {
    throw new TypeError(
      "画布 workspace 必须是 images、whiteboard 或 workflow。"
    );
  }
  const key = [userId, workspace];
  let factory: IDBFactory;
  try {
    factory = globalThis.indexedDB;
    if (!factory) throw new Error("当前环境不支持 IndexedDB");
  } catch (cause) {
    throw storageError("访问", cause);
  }
  const database = await openDatabase(factory);
  let closed = false;

  /** 立即关闭后续访问；IDB 自身等待已发起事务完成，不丢弃在途写入。 */
  function close(): void {
    closed = true;
    database.close();
  }
  database.onversionchange = close;
  database.onclose = () => {
    closed = true;
  };

  /** 已关闭的句柄不重连，避免账号切换后旧 UI 再次使用它。 */
  function assertOpen(): void {
    if (closed) throw new Error("画布 IndexedDB 存储已关闭，请重新打开。");
  }

  return {
    /** 仅当前账号和工作区无记录时返回 null；坏记录保留并抛错供 UI 处理。 */
    async read() {
      assertOpen();
      const cursor = await transact(database, "readonly", (store) =>
        store.openCursor(key)
      );
      if (cursor === null) return null;
      // get() 无法区分缺失记录与损坏的 undefined 值；游标保留这个区别。
      const scene: unknown = cursor.value;
      validateScene(scene, workspace);
      return scene;
    },
    /** 校验后原子替换；工作流还在事务内保护已提交的未知任务，失败保留原记录。 */
    async write(scene) {
      assertOpen();
      validateScene(scene, workspace);
      if (workspace === "workflow") {
        await writeWorkflowScene(database, key, scene);
        return;
      }
      await transact(database, "readwrite", (store) => store.put(scene, key));
    },
    close,
  };
}
