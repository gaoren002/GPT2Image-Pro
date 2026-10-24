/** 既有内部 worker 的共享认证、准入、期限与子进程生命周期；不导入 ONNX。 */
import { fork } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
} from "./inference-protocol.mjs";

/** 只传模型与线程设置，不向推理进程继承数据库、云存储或业务认证信息。 */
export function childEnvironment(env = process.env) {
  const result = { NODE_ENV: "production", UV_THREADPOOL_SIZE: "2" };
  for (const key of [
    "REALESR_MODEL_PATH",
    "SCUNET_MODEL_PATH",
    "ISNET_MODEL_PATH",
    "SUPER_RESOLUTION_INTRA_OP_THREADS",
  ]) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}

/**
 * 每任务启动子进程；完成、失败、超时或取消都 kill，等 exit 才释放槽。
 * childFile 仅供本地测试注入 fixture，不接收 HTTP 参数或环境配置。
 */
export function runInChild(
  operation,
  image,
  signal,
  childFile = new URL("./inference-child.mjs", import.meta.url)
) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const child = fork(fileURLToPath(childFile), [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: childEnvironment(),
      execArgv: ["--max-old-space-size=256"],
    });
    let output;
    let failure;
    const stop = () => child.kill("SIGKILL");
    const abort = () => {
      failure = new Error("cancelled");
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      failure = new Error("child_failed");
      stop();
    });
    child.once("message", (message) => {
      if (
        Buffer.isBuffer(message?.output) &&
        message.output.length > 0 &&
        message.output.length <= MAX_OUTPUT_BYTES
      ) {
        output = message.output;
      } else failure = new Error("inference_failed");
      stop();
    });
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (failure || !output || signal.aborted)
        reject(failure || new Error("child_failed"));
      else resolve(output);
    });
    child.send({ operation, image }, (error) => {
      if (error) {
        failure = new Error("child_failed");
        stop();
      }
    });
  });
}

/** 配置数字允许收紧、限制最大值；禁止旧部署的巨大队列扩大内存预算。 */
function integer(value, fallback, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0
    ? Math.min(number, max)
    : fallback;
}

/** 从既有 worker 环境配置生成受限运行配置；默认串行、两个等待名额。 */
export function workerConfig(env = process.env) {
  const bind = env.SUPER_RESOLUTION_WORKER_BIND?.trim() || "127.0.0.1";
  const secret = env.SUPER_RESOLUTION_WORKER_SECRET?.trim() || "";
  if (!["127.0.0.1", "localhost", "::1"].includes(bind) && !secret)
    throw new Error("worker authentication required");
  return {
    bind,
    port: integer(env.SUPER_RESOLUTION_WORKER_PORT, 3310, 65535),
    secret,
    // 单个模型峰值可能达 GB 级；同一 worker 只允许一个 native 任务。
    concurrency: 1,
    maxQueue: integer(env.SUPER_RESOLUTION_WORKER_MAX_QUEUE, 2, 2),
    maxBodyBytes: Math.min(
      MAX_INPUT_BYTES,
      integer(env.SUPER_RESOLUTION_WORKER_MAX_BODY_MB, 32, 32) * 1024 * 1024
    ),
    timeoutMs: integer(
      env.SUPER_RESOLUTION_WORKER_TIMEOUT_MS,
      300_000,
      300_000
    ),
    enabled: env.INFERENCE_WORKER_ENABLED !== "false",
    restoration: env.RESTORATION_WORKER_ENABLED !== "false",
    matte: env.MATTE_WORKER_ENABLED !== "false",
  };
}

/** 恒定时间认证，沿用现有认证头；非 loopback 无密钥在启动时拒绝。 */
function authorized(request, secret) {
  if (!secret) return true;
  const supplied = request.headers["x-super-resolution-secret"];
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 固定错误响应，不带请求体/头、模型路径或原生错误。拒绝后关闭连接。 */
function sendError(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  const data = Buffer.from(JSON.stringify({ error: code }));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": data.length,
    connection: "close",
  });
  response.end(data);
}

/** 有界读取请求体；signal 包含接收阶段的绝对期限。 */
function readBody(request, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const abort = () => fail(new Error("cancelled"));
    const data = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error("body_limit"));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      if (!size) reject(new Error("empty_body"));
      else resolve(Buffer.concat(chunks, size));
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** 等待回包结束/连接关闭，防止慢读客户端使响应 Buffer 无界滞留。 */
function sendOutput(response, output, signal) {
  return new Promise((resolve) => {
    const done = () => {
      response.off("finish", done);
      response.off("close", done);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      response.destroy();
      done();
    };
    response.once("finish", done);
    response.once("close", done);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": output.length,
    });
    response.end(output);
  });
}

/** 创建可测试的真实 HTTP runtime；注入模型替身时也使用相同认证/队列/取消代码。 */
export function createInferenceServer(
  config = workerConfig(),
  runTask = runInChild
) {
  const tasks = new Set();
  const queue = [];
  let active = 0;
  let stopping = false;

  /** 从共享队列启动唯一运行任务；取消任务不再占队列内容。 */
  function drain() {
    while (active < config.concurrency && queue.length) {
      const task = queue.shift();
      if (task.controller.signal.aborted) {
        task.reject(new Error("cancelled"));
        continue;
      }
      active++;
      Promise.resolve().then(async () => {
        try {
          const output = await runTask(
            task.operation,
            task.image,
            task.controller.signal
          );
          task.controller.signal.throwIfAborted();
          if (
            !Buffer.isBuffer(output) ||
            !output.length ||
            output.length > MAX_OUTPUT_BYTES
          )
            throw new Error("output_limit");
          if (!task.controller.signal.aborted)
            await sendOutput(task.response, output, task.controller.signal);
          task.resolve();
        } catch (error) {
          task.reject(error);
        } finally {
          active--;
          drain();
        }
      });
    }
  }

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const body = JSON.stringify({
        ok: !stopping,
        active,
        queued: queue.length,
        admitted: tasks.size,
        concurrency: config.concurrency,
      });
      response.writeHead(stopping ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(body);
      return;
    }
    const operation = request.url?.replace(/^\/v1\//, "");
    if (
      request.method !== "POST" ||
      request.url !== `/v1/${operation}` ||
      !Object.hasOwn(LIMITS, operation)
    ) {
      sendError(response, 404, "not_found");
      return;
    }
    if (!authorized(request, config.secret)) {
      sendError(response, 401, "unauthorized");
      return;
    }
    if (stopping || !config.enabled || config[operation] === false) {
      sendError(response, 503, "disabled");
      return;
    }
    if (tasks.size >= config.concurrency + config.maxQueue) {
      sendError(response, 503, "busy");
      return;
    }
    const length = request.headers["content-length"];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > config.maxBodyBytes)
    ) {
      sendError(response, 413, "body_limit");
      return;
    }
    if (request.headers["content-type"] !== "application/octet-stream") {
      sendError(response, 415, "content_type");
      return;
    }

    const controller = new AbortController();
    const task = { operation, response, controller };
    tasks.add(task); // 必须在 await readBody 前占位，防并发上传绕过队列。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const cancel = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", cancel);
    const abandonQueued = () => {
      const index = queue.indexOf(task);
      if (index >= 0) {
        queue.splice(index, 1);
        task.reject(new Error("cancelled"));
      }
    };
    controller.signal.addEventListener("abort", abandonQueued, { once: true });
    try {
      task.image = await readBody(
        request,
        controller.signal,
        config.maxBodyBytes
      );
      controller.signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
        queue.push(task);
        drain();
      });
    } catch (error) {
      const code = timedOut
        ? "timeout"
        : controller.signal.aborted
          ? "cancelled"
          : error.message === "body_limit"
            ? "body_limit"
            : error.message === "empty_body"
              ? "empty_body"
              : "inference_failed";
      sendError(
        response,
        timedOut
          ? 504
          : code === "body_limit"
            ? 413
            : code === "empty_body"
              ? 400
              : 502,
        code
      );
    } finally {
      clearTimeout(timer);
      response.off("close", cancel);
      controller.signal.removeEventListener("abort", abandonQueued);
      task.image = undefined;
      tasks.delete(task);
      // 接收失败时不继续 drain 外部内容，响应写完即关闭该 socket。
      if (!request.complete) response.once("finish", () => request.destroy());
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 300_000;
  server.maxConnections = 32;
  /** 停机取消接收/队列/运行任务；外部资源管理器保留最终强杀期限。 */
  const shutdown = () => {
    stopping = true;
    for (const task of tasks) task.controller.abort();
    server.close();
    server.closeIdleConnections();
  };
  return { server, shutdown };
}
