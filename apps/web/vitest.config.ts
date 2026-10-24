import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    // 真实 locale 中间件使用 Next 的无扩展名入口，交给 Vite 解析而非 Node ESM。
    server: { deps: { inline: ["next-intl"] } },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
