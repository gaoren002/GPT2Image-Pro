/** 使用真实 HTTP/子进程检验隔离协议；绝不运行模型。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkTensor,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  validDimensions,
} from "./inference-protocol.mjs";
import {
  childEnvironment,
  createInferenceServer,
  runInChild,
  workerConfig,
} from "./inference-worker-runtime.mjs";

const headers = {
  "content-type": "application/octet-stream",
  "x-super-resolution-secret": "test-secret",
};

/** 启动短生命期回环测试服务；自动清理所有 socket 和运行任务。 */
async function serve(
  t,
  runTask = async (_operation, image) => image,
  overrides = {}
) {
  const config = {
    ...workerConfig({}),
    secret: "test-secret",
    maxBodyBytes: 128,
    timeoutMs: 2000,
    ...overrides,
  };
  const runtime = createInferenceServer(config, runTask);
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  t.after(() => {
    runtime.shutdown();
    runtime.server.closeAllConnections();
  });
  return `http://127.0.0.1:${runtime.server.address().port}`;
}

/** 以健康协议观察准入状态，不读取内部任务对象。 */
async function state(url, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await (await fetch(`${url}/healthz`)).json();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail("worker state did not converge");
}

/** POST 二进制协议。 */
function post(url, route = "matte", extra = {}) {
  return fetch(`${url}/v1/${route}`, {
    method: "POST",
    headers,
    body: Buffer.from("tiny"),
    ...extra,
  });
}

test("同一认证头保护三个入口；非法路由/内容类型拒绝且不执行模型", async (t) => {
  let calls = 0;
  const url = await serve(t, async (_operation, image) => {
    calls++;
    return image;
  });
  for (const route of ["matte", "restoration", "super-resolution"]) {
    assert.equal(
      (
        await post(url, route, {
          headers: { "content-type": "application/octet-stream" },
        })
      ).status,
      401
    );
    const response = await post(url, route);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "tiny");
  }
  assert.equal((await post(url, "../secret")).status, 404);
  assert.equal(
    (
      await post(url, "matte", {
        headers: { ...headers, "content-type": "text/plain" },
      })
    ).status,
    415
  );
  assert.equal(calls, 3);
});

test("配置默认有限，非 loopback 无认证拒绝，特性可关闭", async (t) => {
  assert.equal(
    workerConfig({ SUPER_RESOLUTION_WORKER_MAX_QUEUE: "10000" }).maxQueue,
    2
  );
  assert.equal(
    workerConfig({ SUPER_RESOLUTION_WORKER_CONCURRENCY: "8" }).concurrency,
    1
  );
  assert.throws(
    () => workerConfig({ SUPER_RESOLUTION_WORKER_BIND: "0.0.0.0" }),
    /authentication/
  );
  const url = await serve(t, async () => assert.fail("must not run"), {
    matte: false,
  });
  assert.equal((await post(url)).status, 503);
});

test("Content-Length 与 chunked 实际字节均受限；空输入拒绝", async (t) => {
  const url = await serve(t, async () => assert.fail("must not run"));
  assert.equal(
    (await post(url, "matte", { body: Buffer.alloc(129) })).status,
    413
  );
  assert.equal(
    (await post(url, "matte", { body: Buffer.alloc(0) })).status,
    400
  );
  const status = await new Promise((resolve, reject) => {
    const req = request(
      `${url}/v1/matte`,
      {
        method: "POST",
        headers: { ...headers, "transfer-encoding": "chunked" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.write(Buffer.alloc(80));
    req.end(Buffer.alloc(80));
  });
  assert.equal(status, 413);
});

test("接收中的慢请求已占队列额度，断连释放，无上传绕过", async (t) => {
  const url = await serve(t, async (_operation, image) => image, {
    maxQueue: 1,
  });
  const slow = [];
  for (let i = 0; i < 2; i++) {
    const req = request(`${url}/v1/matte`, {
      method: "POST",
      headers: { ...headers, "content-length": "100" },
    });
    req.on("error", () => undefined);
    req.write("x");
    slow.push(req);
  }
  await state(url, (value) => value.admitted === 2);
  assert.equal((await post(url)).status, 503);
  for (const req of slow) req.destroy();
  await state(url, (value) => value.admitted === 0);
  assert.equal((await post(url)).status, 200);
});

test("三个模型共用串行队列；排队断连立即取消且不调用模型", async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const url = await serve(
    t,
    async (operation, image, signal) => {
      calls.push(operation);
      if (operation === "restoration")
        await Promise.race([gate, once(signal, "abort")]);
      return image;
    },
    { maxQueue: 1 }
  );
  const first = post(url, "restoration");
  await state(url, (value) => value.active === 1);
  const controller = new AbortController();
  const second = post(url, "matte", { signal: controller.signal }).catch(
    () => undefined
  );
  await state(url, (value) => value.queued === 1);
  assert.equal((await post(url, "super-resolution")).status, 503);
  controller.abort();
  await second;
  await state(url, (value) => value.queued === 0 && value.admitted === 1);
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(calls, ["restoration"]);
});

test("超时包含运行与排队；运行槽等待取消完成才释放", async (t) => {
  let stopped = false;
  const url = await serve(
    t,
    async (_operation, image, signal) => {
      await once(signal, "abort");
      await delay(35);
      stopped = true;
      return image;
    },
    { timeoutMs: 50, maxQueue: 1 }
  );
  const first = post(url);
  await state(url, (value) => value.active === 1);
  const second = post(url, "restoration");
  assert.equal((await second).status, 504);
  const response = await first;
  assert.equal(response.status, 504);
  assert.equal(stopped, true);
  await state(url, (value) => value.active === 0 && value.admitted === 0);
});

test("慢上传受绝对期限限制，模型错误正文不外泄", async (t) => {
  const url = await serve(
    t,
    async () => {
      throw new Error("private-path secret-value");
    },
    { timeoutMs: 50 }
  );
  const status = await new Promise((resolve, reject) => {
    const req = request(
      `${url}/v1/matte`,
      { method: "POST", headers: { ...headers, "content-length": "100" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.write("x");
  });
  assert.equal(status, 504);
  const response = await post(url);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '{"error":"inference_failed"}');
});

test("真实子进程退出后返回；取消/崩溃不遗留工作，业务凭据不继承", async () => {
  const fixture = new URL("./test/fixture-child.mjs", import.meta.url);
  const controller = new AbortController();
  const output = await runInChild(
    "echo",
    Buffer.from("fixture"),
    controller.signal,
    fixture
  );
  assert.equal(output.toString(), "fixture");
  const keys = JSON.parse(
    (
      await runInChild(
        "environment",
        Buffer.from("x"),
        controller.signal,
        fixture
      )
    ).toString()
  );
  assert.deepEqual(
    keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
    ["NODE_ENV", "UV_THREADPOOL_SIZE"]
  );
  assert.deepEqual(
    childEnvironment({
      DATABASE_URL: "private",
      NODE_OPTIONS: "private",
      SUPER_RESOLUTION_WORKER_SECRET: "private",
      SCUNET_MODEL_PATH: "/server/model",
    }),
    {
      NODE_ENV: "production",
      UV_THREADPOOL_SIZE: "2",
      SCUNET_MODEL_PATH: "/server/model",
    }
  );
  const run = runInChild("hold", Buffer.from("x"), controller.signal, fixture);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, /cancelled/);
  await assert.rejects(
    runInChild(
      "echo",
      Buffer.from("x"),
      new AbortController().signal,
      new URL("./test/missing.mjs", import.meta.url)
    ),
    /child_failed/
  );
});

test("HTTP 运行中断连终止真实 fixture 子进程，释放槽后可处理后续任务", async (t) => {
  const fixture = new URL("./test/fixture-child.mjs", import.meta.url);
  const url = await serve(t, (operation, image, signal) =>
    runInChild(
      operation === "restoration" ? "hold" : "echo",
      image,
      signal,
      fixture
    )
  );
  const controller = new AbortController();
  const running = post(url, "restoration", { signal: controller.signal }).catch(
    () => undefined
  );
  await state(url, (value) => value.active === 1);
  controller.abort();
  await running;
  await state(url, (value) => value.active === 0 && value.admitted === 0);
  assert.equal((await post(url, "matte")).status, 200);
});

test("实际子进程在图像解码/尺寸检查失败时拒绝，未运行 ONNX", async () => {
  await assert.rejects(
    runInChild(
      "matte",
      Buffer.from("invalid-image"),
      new AbortController().signal
    ),
    /inference_failed/
  );
});

test("像素/页数/整数与 tensor shape/类型/有限值边界", () => {
  assert.equal(MAX_INPUT_BYTES, 32 * 1024 * 1024);
  assert.equal(MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
  assert.equal(
    validDimensions("restoration", { width: 2048, height: 2048 }),
    true
  );
  assert.equal(
    validDimensions("restoration", { width: 2049, height: 1 }),
    false
  );
  assert.equal(validDimensions("matte", { width: 8192, height: 2048 }), true);
  assert.equal(validDimensions("matte", { width: 8192, height: 2049 }), false);
  assert.equal(validDimensions("matte", { width: 1.5, height: 1 }), false);
  assert.equal(
    validDimensions("matte", { width: 10, height: 10, pages: 2 }),
    false
  );
  assert.equal(
    validDimensions("super-resolution", { width: 1024, height: 1024 }),
    true
  );
  assert.equal(
    validDimensions("super-resolution", { width: 1024, height: 1025 }),
    false
  );
  checkTensor({ data: new Float32Array([0, 1]), dims: [1, 2] }, [1, 2]);
  for (const tensor of [
    { data: new Float32Array([1]), dims: [1, 2] },
    { data: new Float32Array([1, 2]), dims: [2, 1] },
    { data: new Float32Array([NaN, 0]), dims: [1, 2] },
    { data: new Uint8Array([1, 2]), dims: [1, 2] },
  ])
    assert.throws(() => checkTensor(tensor, [1, 2]), /tensor/);
});
