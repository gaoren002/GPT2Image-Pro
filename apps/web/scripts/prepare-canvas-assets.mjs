/** dev/build 前复制锁定版本的画布字体和许可证，生产不依赖第三方字体 CDN。 */
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const editorRoot = dirname(require.resolve("@excalidraw/excalidraw"));
const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(webRoot, "public/excalidraw-assets/fonts");
await mkdir(destination, { recursive: true });
await cp(join(editorRoot, "fonts"), destination, { recursive: true });
