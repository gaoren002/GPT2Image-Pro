/** standalone worker 的依赖链接：按构建源包定位，不依赖 Web 的隐式 ONNX trace。 */
import {
  access,
  readFile,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(appDir, ".next", "standalone", "node_modules");

const require = createRequire(import.meta.url);
const onnxRequire = createRequire(require.resolve("onnxruntime-node"));

/** 兼容不导出 package.json 的包；只解析路径和 JSON，不执行原生模块。 */
async function packageDirectory(resolver, packageName) {
  let directory = path.dirname(resolver.resolve(packageName));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8")
      );
      if (metadata.name === packageName) return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error("worker package metadata is missing");
}

for (const packageName of ["onnxruntime-node", "onnxruntime-common", "sharp"]) {
  const resolver = packageName === "onnxruntime-common" ? onnxRequire : require;
  const original = await packageDirectory(resolver, packageName);
  const source = path.relative(
    path.resolve(appDir, "../../node_modules"),
    original
  );
  if (!source.startsWith(`.pnpm${path.sep}`)) {
    throw new Error("worker dependency is outside the project pnpm store");
  }
  const sourcePath = path.join(nodeModules, source);
  const destination = path.join(nodeModules, packageName);
  await access(sourcePath);

  try {
    const existingTarget = await readlink(destination);
    if (
      existingTarget !== source &&
      (await realpath(destination)) !== (await realpath(sourcePath))
    ) {
      throw new Error(
        `${destination} points to ${existingTarget}; expected ${source}`
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EINVAL") throw error;
    if (error?.code === "EINVAL") {
      throw new Error(`${destination} exists and is not a symbolic link`);
    }
    await symlink(source, destination, "dir");
  }
}

console.info("Linked standalone dependencies for the super-resolution worker");
