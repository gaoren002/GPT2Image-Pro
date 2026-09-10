/**
 * 解算 ChatGPT Sentinel 返回的 Turnstile dx 字节码；供 Web 会话请求生成挑战令牌。
 *
 * 该模块只模拟挑战程序会访问的少量浏览器 API，不执行远端脚本。所有输入均按不可信
 * 数据处理，畸形程序或超过执行步数上限时返回 undefined。
 */
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

export const CHATGPT_TURNSTILE_VM_MAX_STEPS = 20_000;

const TURNSTILE_NATIVE_STRINGS = new Map<string, string>([
  ["window.Math", "[object Math]"],
  ["window.Reflect", "[object Reflect]"],
  ["window.performance", "[object Performance]"],
  ["window.localStorage", "[object Storage]"],
  ["window.Object", "function Object() { [native code] }"],
  ["window.Reflect.set", "function set() { [native code] }"],
  ["window.performance.now", "function () { [native code] }"],
  ["window.Object.create", "function create() { [native code] }"],
  ["window.Object.keys", "function keys() { [native code] }"],
  ["window.Math.random", "function random() { [native code] }"],
]);

const TURNSTILE_LOCAL_STORAGE_KEYS = [
  "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
  "STATSIG_LOCAL_STORAGE_STABLE_ID",
  "client-correlated-secret",
  "oai/apps/capExpiresAt",
  "oai-did",
  "STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
  "UiState.isNavigationCollapsed.1",
];

const TURNSTILE_SCRIPT_SOURCE = "https://chatgpt.com/sentinel/current/sdk.js";

const TURNSTILE_WINDOW_VALUES = new Map<string, unknown>([
  ["window.history.length", 2],
  ["window.navigator.deviceMemory", 8],
  ["window.navigator.hardwareConcurrency", 8],
  ["window.navigator.maxTouchPoints", 0],
  ["window.navigator.platform", "Win32"],
  ["window.navigator.vendor", "Google Inc."],
  ["window.screen.availHeight", 1400],
  ["window.screen.availLeft", 0],
  ["window.screen.availTop", 0],
  ["window.screen.availWidth", 2560],
  ["window.screen.colorDepth", 24],
  ["window.screen.height", 1440],
  ["window.screen.pixelDepth", 24],
  ["window.screen.width", 2560],
]);

type VmCallable = (...args: unknown[]) => unknown;
type VmQueue = unknown[][];

/** 保存 Object.create 结果的插入顺序，供 Reflect.set 与 Object.keys 配合使用。 */
class OrderedMap {
  readonly keys: string[] = [];
  readonly values = new Map<string, unknown>();

  /** 写入属性；覆盖已有属性时保留它原来的枚举位置。 */
  add(key: string, value: unknown): void {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }

  /** 模拟浏览器中 Object.create(null) 对象的 JSON 枚举结果。 */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(
      this.keys.map((key) => [key, this.values.get(key)])
    );
  }
}

/** 标识必须终止整个 VM 的结构错误或资源上限，避免被单条指令的容错捕获。 */
class VmAbortError extends Error {}

/** 创建挑战会访问的最小 DOM 元素，不运行网页脚本。 */
function createVmElement(tagName: string): Record<string, unknown> {
  if (tagName.toLowerCase() === "canvas") {
    const debugInfo = {
      UNMASKED_VENDOR_WEBGL: 37_445,
      UNMASKED_RENDERER_WEBGL: 37_446,
    };
    const context = {
      getExtension: (name: unknown) =>
        name === "WEBGL_debug_renderer_info" ? debugInfo : null,
      getParameter: (parameter: unknown) =>
        parameter === debugInfo.UNMASKED_VENDOR_WEBGL
          ? "Google Inc. (NVIDIA)"
          : parameter === debugInfo.UNMASKED_RENDERER_WEBGL
            ? "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
            : null,
    };
    return {
      getContext: (name: unknown) =>
        typeof name === "string" && name.includes("webgl") ? context : null,
    };
  }

  const style: Record<string, unknown> = {};
  const element: Record<string, unknown> = { style };
  element.getBoundingClientRect = () => {
    const fontSize = Number.parseFloat(String(style.fontSize || "20")) || 20;
    const characterCount = Array.from(String(element.innerText || "")).length;
    return {
      width: Math.round(characterCount * fontSize * 0.56 * 1_000) / 1_000,
      height: Math.round(fontSize * 1.2 * 1_000) / 1_000,
    };
  };
  return element;
}

/** 判断动态寄存器中的值能否作为 VM 子程序调用。 */
function isVmCallable(value: unknown): value is VmCallable {
  return typeof value === "function";
}

/** 判断值是否为可以安全读取和写入字符串属性的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格解码标准 Base64 和 UTF-8。
 *
 * Buffer 默认会忽略非法字符，因此先检查规范形式，防止损坏的 dx 被悄悄修正。
 */
function decodeBase64Utf8(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    return undefined;
  }

  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** 使用 p 按 Unicode 码点循环异或 dx 文本；空密钥保持上游的直通行为。 */
function xorString(text: string, key: string): string {
  if (!key) return text;

  const keyPoints = Array.from(key);
  return Array.from(text, (character, index) => {
    const keyCharacter = keyPoints[index % keyPoints.length];
    if (keyCharacter === undefined) throw new VmAbortError("invalid_xor_key");
    const codePoint =
      (character.codePointAt(0) ?? 0) ^ (keyCharacter.codePointAt(0) ?? 0);
    if (codePoint > 0x10ffff) {
      throw new VmAbortError("invalid_xor_code_point");
    }
    return String.fromCodePoint(codePoint);
  }).join("");
}

/** 按挑战脚本需要的 JavaScript 展示形式转换值。 */
function turnstileToString(value: unknown): string {
  if (value === undefined || value === null) return "undefined";
  if (typeof value === "string") {
    return TURNSTILE_NATIVE_STRINGS.get(value) ?? value;
  }
  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value.join(",");
  }
  return String(value);
}

/** 将 VM 数值操作数转换为有限数字；不接受空字符串等隐式零值。 */
function toVmNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** 将数组属性转换为 Python 参考实现采用的整数下标。 */
function toArrayIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * 解算一个 Sentinel Turnstile dx 程序。
 *
 * @param dx Base64 编码、再以 p 异或保护的 JSON 指令队列。
 * @param p Sentinel 请求对应的异或密钥。
 * @returns VM 产出的 Base64 令牌；输入损坏、程序无结果或超过 20,000 步时返回
 * undefined。函数不访问网络，也不会修改调用方传入的数据。
 */
export function solveChatGptTurnstileToken(
  dx: unknown,
  p: unknown
): string | undefined {
  if (typeof dx !== "string" || typeof p !== "string") return undefined;

  const decoded = decodeBase64Utf8(dx);
  if (decoded === undefined) return undefined;

  let parsedProgram: unknown;
  try {
    parsedProgram = JSON.parse(xorString(decoded, p));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsedProgram)) return undefined;

  const processMap = new Map<unknown, unknown>();
  const startTime = performance.now();
  let result = "";
  let executedSteps = 0;

  /** 读取寄存器；不存在的键与显式 undefined 均按 undefined 处理。 */
  function getValue(key: unknown): unknown {
    return processMap.get(key);
  }

  /** 写入寄存器；Map 避免特殊字符串键污染对象原型。 */
  function setValue(key: unknown, value: unknown): void {
    processMap.set(key, value);
  }

  /** 模拟 Math.abs(Number(value))，转换失败时依照参考实现返回零。 */
  function jsAbs(value: unknown): number {
    return Math.abs(toVmNumber(value) ?? 0);
  }

  /** 模拟挑战程序用到的对象、数组和 window 属性读取。 */
  function jsProp(object: unknown, key: unknown): unknown {
    if (object instanceof OrderedMap) {
      return object.values.get(String(key));
    }
    if (object instanceof Map) return object.get(key);
    if (Array.isArray(object)) {
      const index = toArrayIndex(key);
      return index === undefined ? undefined : object[index];
    }
    if (isRecord(object)) return object[String(key)];
    if (typeof object === "string") {
      const keyText = turnstileToString(key);
      if (keyText === "location" && object === "window.document") {
        return "https://chatgpt.com/";
      }
      if (keyText && keyText !== "undefined" && keyText !== "None") {
        const path = `${object}.${keyText}`;
        return TURNSTILE_WINDOW_VALUES.has(path)
          ? TURNSTILE_WINDOW_VALUES.get(path)
          : path;
      }
    }
    return undefined;
  }

  /** 调用受限的浏览器 API 或 VM 子程序；未知目标不产生结果。 */
  function callTarget(target: unknown, args: unknown[]): unknown {
    if (typeof target === "string") {
      if (target === "window.performance.now") {
        return performance.now() - startTime + Math.random() / 1_000_000;
      }
      if (target === "window.Object.create") return new OrderedMap();
      if (target === "window.Object.keys") {
        const object = args[0];
        if (object === "window.localStorage") {
          return [...TURNSTILE_LOCAL_STORAGE_KEYS];
        }
        if (object instanceof OrderedMap) return [...object.keys];
        if (object instanceof Map) return [...object.keys()];
        if (isRecord(object)) return Object.keys(object);
        return undefined;
      }
      if (target === "window.Math.random") return Math.random();
      if (target === "window.document.createElement") {
        return createVmElement(String(args[0] || "div"));
      }
      if (target === "window.document.body.appendChild") return args[0];
      if (target === "window.document.body.removeChild") return args[0];
      if (target === "window.localStorage.setItem") return undefined;
      if (target === "window.navigator.storage.estimate") {
        return { quota: 10 * 1024 ** 3, usage: 0 };
      }
      if (target === "window.Reflect.set") {
        const [object, key, value] = args;
        if (object instanceof OrderedMap) {
          object.add(String(key), value);
          return true;
        }
        if (object instanceof Map) {
          object.set(String(key), value);
          return true;
        }
        if (isRecord(object)) {
          object[String(key)] = value;
          return true;
        }
        return false;
      }
    }
    return isVmCallable(target) ? target(...args) : undefined;
  }

  /**
   * 执行寄存器 9 中的队列。计数在嵌套调用间共享，确保子程序无法绕过总步数上限。
   */
  function runQueue(): void {
    while (true) {
      const queue = processMap.get(9);
      if (!Array.isArray(queue) || queue.length === 0) return;

      executedSteps += 1;
      if (executedSteps > CHATGPT_TURNSTILE_VM_MAX_STEPS) {
        throw new VmAbortError("turnstile_vm_step_limit");
      }

      const instruction = queue.shift();
      if (
        !Array.isArray(instruction) ||
        instruction.length === 0 ||
        (typeof instruction[0] !== "number" &&
          typeof instruction[0] !== "string")
      ) {
        throw new VmAbortError("malformed_turnstile_instruction");
      }

      const operation = processMap.get(instruction[0]);
      if (!isVmCallable(operation)) continue;
      try {
        operation(...instruction.slice(1));
      } catch (error) {
        if (error instanceof VmAbortError) throw error;
        // 单条指令失败是原 VM 的容错语义；队列仍继续执行后续指令。
      }
    }
  }

  /** 指令 1：将两个寄存器转成字符串后异或，写回第一个寄存器。 */
  function operation1(target: unknown, key: unknown): void {
    setValue(
      target,
      xorString(
        turnstileToString(getValue(target)),
        turnstileToString(getValue(key))
      )
    );
  }

  /** 指令 2：把立即数写入目标寄存器。 */
  function operation2(target: unknown, value: unknown): void {
    setValue(target, value);
  }

  /** 指令 3：把立即数字符串编码为最终 Base64 令牌。 */
  function operation3(value: unknown): void {
    if (typeof value !== "string") throw new TypeError("invalid_result_value");
    result = Buffer.from(value, "utf8").toString("base64");
  }

  /** 指令 5：向数组追加寄存器值，或执行字符串拼接。 */
  function operation5(target: unknown, source: unknown): void {
    const current = getValue(target);
    const incoming = getValue(source);
    if (Array.isArray(current)) {
      setValue(target, [...current, incoming]);
      return;
    }
    if (
      typeof current === "string" ||
      typeof current === "number" ||
      typeof incoming === "string" ||
      typeof incoming === "number"
    ) {
      setValue(
        target,
        turnstileToString(current) + turnstileToString(incoming)
      );
      return;
    }
    setValue(target, "NaN");
  }

  /** 指令 6：读取对象属性并写入目标寄存器。 */
  function operation6(target: unknown, object: unknown, key: unknown): void {
    setValue(target, jsProp(getValue(object), getValue(key)));
  }

  /** 指令 7：调用目标寄存器，参数先按寄存器索引解析，忽略返回值。 */
  function operation7(target: unknown, ...args: unknown[]): void {
    callTarget(getValue(target), args.map(getValue));
  }

  /** 指令 8：复制一个已存在的寄存器；源缺失时让当前指令失败。 */
  function operation8(target: unknown, source: unknown): void {
    if (!processMap.has(source)) throw new TypeError("missing_source_register");
    setValue(target, processMap.get(source));
  }

  /** 指令 11：在模拟的 document.scripts 中返回首个脚本 URL 匹配片段。 */
  function operation11(target: unknown, query: unknown): void {
    const pattern = getValue(query);
    const match =
      typeof pattern === "string"
        ? TURNSTILE_SCRIPT_SOURCE.match(pattern)
        : null;
    setValue(target, match?.[0] ?? null);
  }

  /** 指令 13：以立即数参数调用目标，并仅在异常时记录错误文本。 */
  function operation13(
    errorTarget: unknown,
    callable: unknown,
    ...args: unknown[]
  ): void {
    try {
      callTarget(getValue(callable), args);
    } catch (error) {
      if (error instanceof VmAbortError) throw error;
      setValue(errorTarget, String(error));
    }
  }

  /** 指令 14：解析寄存器中的 JSON 字符串。 */
  function operation14(target: unknown, source: unknown): void {
    const value = processMap.get(source);
    if (typeof value !== "string") throw new TypeError("invalid_json_source");
    setValue(target, JSON.parse(value));
  }

  /** 指令 15：把寄存器值序列化为 JSON 字符串。 */
  function operation15(target: unknown, source: unknown): void {
    const value = JSON.stringify(processMap.get(source));
    if (value === undefined) throw new TypeError("invalid_json_value");
    setValue(target, value);
  }

  /** 指令 17：调用目标寄存器，并把返回值写入目标寄存器。 */
  function operation17(
    target: unknown,
    callable: unknown,
    ...args: unknown[]
  ): void {
    setValue(target, callTarget(getValue(callable), args.map(getValue)));
  }

  /** 指令 18：把目标寄存器中的 Base64 文本解码为 UTF-8。 */
  function operation18(target: unknown): void {
    const decodedValue = decodeBase64Utf8(
      turnstileToString(processMap.get(target))
    );
    if (decodedValue === undefined) throw new TypeError("invalid_base64_value");
    setValue(target, decodedValue);
  }

  /** 指令 19：把目标寄存器中的文本编码为 Base64。 */
  function operation19(target: unknown): void {
    setValue(
      target,
      Buffer.from(turnstileToString(processMap.get(target)), "utf8").toString(
        "base64"
      )
    );
  }

  /** 指令 20：两个寄存器严格相等时，以立即数参数调用分支子程序。 */
  function operation20(
    left: unknown,
    right: unknown,
    callable: unknown,
    ...args: unknown[]
  ): void {
    const target = getValue(callable);
    if (getValue(left) === getValue(right) && isVmCallable(target)) {
      target(...args);
    }
  }

  /** 指令 21：两数差值超过阈值时，以立即数参数调用分支子程序。 */
  function operation21(
    left: unknown,
    right: unknown,
    threshold: unknown,
    callable: unknown,
    ...args: unknown[]
  ): void {
    const leftNumber = toVmNumber(getValue(left));
    const rightNumber = toVmNumber(getValue(right));
    const delta =
      leftNumber === undefined || rightNumber === undefined
        ? 0
        : leftNumber - rightNumber;
    const target = getValue(callable);
    if (Math.abs(delta) > jsAbs(getValue(threshold)) && isVmCallable(target)) {
      target(...args);
    }
  }

  /** 指令 22：临时执行一段嵌套队列，并恢复调用者队列。 */
  function operation22(target: unknown, queue: unknown): void {
    if (!Array.isArray(queue)) {
      throw new VmAbortError("malformed_nested_turnstile_queue");
    }
    const previous = processMap.get(9);
    const previousQueue = Array.isArray(previous) ? [...previous] : [];
    setValue(9, [...queue] as VmQueue);
    try {
      runQueue();
    } catch (error) {
      if (error instanceof VmAbortError) throw error;
      setValue(target, String(error));
    } finally {
      setValue(9, previousQueue);
    }
  }

  /** 指令 23：首个寄存器有值时，以立即数参数调用第二个寄存器。 */
  function operation23(
    guard: unknown,
    callable: unknown,
    ...args: unknown[]
  ): void {
    const target = getValue(callable);
    if (getValue(guard) !== undefined && isVmCallable(target)) {
      target(...args);
    }
  }

  /** 指令 24：读取对象方法并绑定原对象，保留 Array.push 等方法的 this。 */
  function operation24(target: unknown, object: unknown, key: unknown): void {
    const source = getValue(object);
    const property = getValue(key);
    if (
      typeof source === "string" &&
      (source === "window" || source.startsWith("window."))
    ) {
      const browserMethod = jsProp(source, property);
      if (typeof browserMethod !== "string") {
        throw new TypeError("invalid_browser_method");
      }
      setValue(target, browserMethod);
      return;
    }
    let method: unknown;
    if (typeof source === "string") {
      method = Reflect.get(Object(source), turnstileToString(property));
    } else if (Array.isArray(source)) {
      method = Reflect.get(source, turnstileToString(property));
    } else if (source instanceof Map) {
      method = Reflect.get(source, turnstileToString(property));
    } else if (isRecord(source)) {
      method = source[turnstileToString(property)];
    }
    if (typeof method !== "function") {
      throw new TypeError("invalid_bound_method");
    }
    setValue(target, method.bind(source));
  }

  /** 指令 27：从数组删除首个匹配值，或执行数值减法。 */
  function operation27(target: unknown, source: unknown): void {
    const current = getValue(target);
    const incoming = getValue(source);
    if (Array.isArray(current)) {
      const index = current.indexOf(incoming);
      if (index >= 0) current.splice(index, 1);
      return;
    }
    const currentNumber = toVmNumber(current);
    const incomingNumber = toVmNumber(incoming);
    setValue(
      target,
      currentNumber === undefined || incomingNumber === undefined
        ? 0
        : currentNumber - incomingNumber
    );
  }

  /** 指令 29：比较两个同类型数字或字符串寄存器。 */
  function operation29(target: unknown, left: unknown, right: unknown): void {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      setValue(target, leftValue < rightValue);
      return;
    }
    if (typeof leftValue === "string" && typeof rightValue === "string") {
      setValue(target, leftValue < rightValue);
      return;
    }
    setValue(target, false);
  }

  /** 指令 30：创建可捕获调用参数的 VM 子程序。 */
  function operation30(
    target: unknown,
    returnRegister: unknown,
    capturesOrQueue: unknown,
    possibleQueue?: unknown
  ): void {
    const hasCaptures = Array.isArray(possibleQueue);
    if (!Array.isArray(capturesOrQueue)) {
      throw new VmAbortError("malformed_turnstile_subroutine");
    }
    const captureKeys: unknown[] = hasCaptures ? capturesOrQueue : [];
    const queue: unknown[] = Array.isArray(possibleQueue)
      ? possibleQueue
      : capturesOrQueue;
    const subroutineQueue = [...queue] as VmQueue;

    /** 执行闭包队列，并在返回后恢复调用者尚未执行的指令。 */
    function subroutine(...callArgs: unknown[]): unknown {
      const previous = processMap.get(9);
      const previousQueue = Array.isArray(previous) ? [...previous] : [];
      if (hasCaptures) {
        captureKeys.forEach((key, index) => {
          if (index < callArgs.length) setValue(key, callArgs[index]);
        });
      }
      setValue(9, [...subroutineQueue]);
      try {
        runQueue();
        return getValue(returnRegister);
      } finally {
        setValue(9, previousQueue);
      }
    }

    setValue(target, subroutine);
  }

  /** 指令 33：将两个寄存器转为数字后相乘，转换失败时写入零。 */
  function operation33(target: unknown, left: unknown, right: unknown): void {
    const leftNumber = toVmNumber(getValue(left));
    const rightNumber = toVmNumber(getValue(right));
    setValue(
      target,
      leftNumber === undefined || rightNumber === undefined
        ? 0
        : leftNumber * rightNumber
    );
  }

  /** 指令 34：复制寄存器值；源不存在时写入 undefined。 */
  function operation34(target: unknown, source: unknown): void {
    setValue(target, getValue(source));
  }

  /** 指令 35：两个寄存器转为数字后相除；除数为零时写入零。 */
  function operation35(target: unknown, left: unknown, right: unknown): void {
    const leftNumber = Number(getValue(left));
    const rightNumber = Number(getValue(right));
    setValue(target, rightNumber === 0 ? 0 : leftNumber / rightNumber);
  }

  /** 指令 25、26、28：上游保留的空操作。 */
  function noop(): void {}

  processMap.set(1, operation1);
  processMap.set(2, operation2);
  processMap.set(3, operation3);
  processMap.set(5, operation5);
  processMap.set(6, operation6);
  processMap.set(7, operation7);
  processMap.set(8, operation8);
  processMap.set(9, [...parsedProgram] as VmQueue);
  processMap.set(10, "window");
  processMap.set(11, operation11);
  processMap.set(12, (target: unknown) => setValue(target, processMap));
  processMap.set(13, operation13);
  processMap.set(14, operation14);
  processMap.set(15, operation15);
  processMap.set(16, p);
  processMap.set(17, operation17);
  processMap.set(18, operation18);
  processMap.set(19, operation19);
  processMap.set(20, operation20);
  processMap.set(21, operation21);
  processMap.set(22, operation22);
  processMap.set(23, operation23);
  processMap.set(24, operation24);
  processMap.set(25, noop);
  processMap.set(26, noop);
  processMap.set(27, operation27);
  processMap.set(28, noop);
  processMap.set(29, operation29);
  processMap.set(30, operation30);
  processMap.set(33, operation33);
  processMap.set(34, operation34);
  processMap.set(35, operation35);

  try {
    runQueue();
  } catch {
    return undefined;
  }
  return result || undefined;
}
