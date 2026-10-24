/** 用微型假包检查 standalone 链接协议；不安装依赖、不加载原生模块。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("standalone 显式链接 ONNX/common/sharp，支持 exports 限制和重复构建", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inference-packaging-"));
  try {
    const app = path.join(root, "apps/web");
    const standalone = path.join(app, ".next/standalone/node_modules");
    await mkdir(path.join(app, "scripts"), { recursive: true });
    await mkdir(path.join(app, "node_modules"), { recursive: true });
    const script = path.join(
      app,
      "scripts/link-super-resolution-worker-dependencies.mjs"
    );
    await cp(
      new URL(
        "../scripts/link-super-resolution-worker-dependencies.mjs",
        import.meta.url
      ),
      script
    );
    for (const name of ["onnxruntime-node", "onnxruntime-common", "sharp"]) {
      const relative = `.pnpm/${name}@fixture/node_modules/${name}`;
      const directory = path.join(root, "node_modules", relative);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({
          name,
          main: "index.cjs",
          exports: { require: "./index.cjs" },
        })
      );
      await writeFile(
        path.join(directory, "index.cjs"),
        'throw new Error("must not load native package");'
      );
      await mkdir(path.dirname(path.join(standalone, relative)), {
        recursive: true,
      });
      await cp(directory, path.join(standalone, relative), { recursive: true });
      if (name !== "onnxruntime-common")
        await symlink(directory, path.join(app, "node_modules", name));
    }
    await symlink(
      path.join(
        root,
        "node_modules/.pnpm/onnxruntime-common@fixture/node_modules/onnxruntime-common"
      ),
      path.join(
        root,
        "node_modules/.pnpm/onnxruntime-node@fixture/node_modules/onnxruntime-common"
      )
    );
    for (let i = 0; i < 2; i++)
      execFileSync(process.execPath, [script], { stdio: "pipe" });
    for (const name of ["onnxruntime-node", "onnxruntime-common", "sharp"]) {
      assert.equal(
        await realpath(path.join(standalone, name)),
        path.join(standalone, `.pnpm/${name}@fixture/node_modules/${name}`)
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
