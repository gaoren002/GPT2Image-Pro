import { createMDX } from "fumadocs-mdx/next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * 创建 Fumadocs MDX 插件
 */
const withMDX = createMDX();

/**
 * 创建 next-intl 插件
 * 指定国际化请求配置文件路径
 */
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || "",
  images: {
    minimumCacheTTL: 2_592_000,
  },
  // Enable standalone output for Docker deployment
  output: "standalone",
  // ONNX 仅由独立 worker 子进程加载，Web 不再 import。显式 trace 完整 JS/native 包，
  // 避免 standalone 因没有 Web import 而漏打包；模型与 worker 入口也必须显式包含。
  // sharp 同理:Next 只 trace 它的 .node 绑定,不 trace @img/sharp-libvips-linux-x64
  // 运行时 dlopen 的 libvips-cpp.so.*(约 18MB)。standalone 缺它时 sharp 加载即
  // 抛「Could not load the sharp module」,而存储路由 /api/storage 顶层 import sharp
  // → 整路由 500 → 所有图片下载/缩略图全挂(2026-06-22 事故:dependabot 升 sharp
  // 0.34→0.35 后,新版 libvips 1.3.1 的 .so 未被 trace,客户 image_url 下载 500、
  // 拿不到图)。版本号用通配,升级 sharp 后无需改这里;同时显式带 .node 绑定。
  outputFileTracingIncludes: {
    "/*": [
      // ONNX 仅由独立 worker 的子进程 import，必须显式打包 JS 与 native 依赖。
      "../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/**",
      "../../node_modules/.pnpm/onnxruntime-common@*/node_modules/onnxruntime-common/**",
      "./models/isnet.onnx",
      "./models/realesr-general-x4v3.onnx",
      "./models/scunet-color-real-gan.onnx",
      "./worker/super-resolution-worker.mjs",
      "./worker/inference-worker-runtime.mjs",
      "./worker/inference-child.mjs",
      "./worker/inference-models.mjs",
      "./worker/inference-protocol.mjs",
      "../../node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**",
      "../../node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-linux-x64/**",
    ],
  },
  // middleware 会先把请求体按 proxyClientMaxBodySize 读入并复制约 3 倍，发生在鉴权
  // 之前。大上传与自鉴权入口已在 middleware matcher 中排除并在 handler 内限长读取；
  // 其余经过 middleware 的请求只需容纳最大的 Server Action（管理员批量导入令牌，
  // 1 万条约 25MB）。代理上限略大于 Action 上限：超限 Action 得到明确的 413，
  // 而不是被截断后解析失败。
  experimental: {
    proxyClientMaxBodySize: "32mb",
    serverActions: {
      bodySizeLimit: "30mb",
    },
  },
  // Transpile monorepo packages
  transpilePackages: ["@repo/ui", "@repo/database", "@repo/shared"],
  // Exclude packages with webpack-specific syntax from server bundling
  serverExternalPackages: [
    "anki-apkg-export",
    "sql.js",
    "pino",
    "pino-pretty",
    "@axiomhq/pino",
    // 原生模块（存储路由的按需缩略图缩放）：保持外置，避免被打进 server bundle。
    "sharp",
    // PSD 导出组装库:仅被 server action 经 use server 引用,Next 默认未把它 trace 进
    // standalone(运行时会 Cannot find module 'ag-psd')。外置后 Next 会把它及其依赖
    // (base64-js/pako)一并拷入 standalone node_modules。
    "ag-psd",
    // 仅供独立 worker 子进程使用。Web 无 import，打包靠上面的显式 tracing。
    "onnxruntime-node",
  ],
};

// 组合插件: MDX -> NextIntl -> NextConfig
export default withMDX(withNextIntl(nextConfig));
