# CI/CD 流水线说明

> 落实 `CLAUDE.md` / `AGENTS.md` 第 0 章协作准则的**自动化执法层**。
> 所有协作者与 PR 贡献者的提交都必须通过本流水线的门禁。

## 总览

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | PR / push → `dev`·`main`，手动 | 提交门禁：文档镜像、风格、类型、测试、构建、容器可构建性 |
| `.github/workflows/docker-release.yml` | push tag `v*.*.*`，手动 | 发布：构建并推送 4 个镜像到 GHCR + 起草 GitHub Release |
| `.github/actions/setup/action.yml` | 被 ci.yml 复用 | 统一 Node 22 + pnpm + frozen-lockfile 安装 |
| `.github/dependabot.yml` | 每周 | 依赖 / Action 安全更新自动开 PR |

## ci.yml —— 提交门禁（6 个 job）

并行运行，各自在 PR 的 Checks 面板独立显示，便于设为「必须通过」。

1. **docs-mirror**（push + PR）：断言 `CLAUDE.md` 与 `AGENTS.md` 逐字一致（镜像文件约束）。秒级、免依赖。
2. **lint（仅 PR、仅改动文件）**：用仓库锁定的 Biome 2.3.11，对本次 **PR 触及的文件**执行 `biome lint --changed --since=<base.sha>`。
   - **为何用 `biome lint` 而非 `biome ci`**：仓库历史代码从未全量 biome 格式化（全仓 `biome ci` 有 300+ 格式报错），团队既有约定 `turbo lint` 即 `biome lint`。强制格式会误伤大量历史文件，故只查 lint 规则、不查格式。
   - **为何只在 PR**：贡献者门禁的精确点是 PR，diff = PR 相对目标分支的净改动（小而准）。push（尤其合并提交）改动集巨大，会把所触碰文件里的历史 lint 债一并暴露，造成无关失败。
   - **退出码**：有 lint 错误（如 `noExplicitAny` / `noUnusedImports`）即失败；告警级规则（如 `noNonNullAssertion: warn`）不阻断（与本地 `biome lint` 一致）。
   - 纯文档 PR（无 JS/TS 改动）→ `Checked 0 files` → 通过。
3. **typecheck**（push + PR）：先 `pnpm --filter @repo/web exec fumadocs-mdx` 生成 Fumadocs 的 `.source`（被 .gitignore 忽略、平时由 `next dev/build` 的 createMDX 产出；独立 `tsc` 不会触发，缺失会引发 `src/lib/source.ts` 找不到 `.source/server` 的连锁 any 报错），再 `pnpm turbo typecheck`（全仓 strict `tsc --noEmit`）。
4. **test**（push + PR）：`pnpm turbo test`（全仓 vitest，DB-free）。覆盖积分/扣费/幂等/API 等核心逻辑。
5. **build**（push + PR）：`pnpm turbo build --filter=@repo/web`（Next standalone 生产构建，`next build` 会自行生成 `.source`）。环境变量为占位值，与 `Dockerfile.web` 的 build-args 一致；**不设 `NODE_ENV=production`**（否则 pnpm 跳过 devDependencies 导致构建失败）。
6. **docker-build（仅 PR）**：用 `Dockerfile.web` 实打实构建 web 镜像但**不推送**，验证多阶段 Dockerfile（turbo prune → install → build → standalone）未损坏。在前 4 个 job 通过后才跑（`needs`），gha 缓存加速。

> 门禁有效性已本地验证：`biome lint --changed` 对含 `noExplicitAny` 的改动文件失败（EXIT≠0），对仅含 `noNonNullAssertion` 告警的文件通过；纯文档改动 `Checked 0 files` 通过。
> 首次推送（2026-05-30）经 CI 实跑修正：typecheck 因缺 `.source` 失败 → 增生成步骤；lint 原用 `biome ci`（含格式）在大合并改动集上暴露 300+ 历史格式债 → 改 `biome lint` 且仅 PR。

## docker-release.yml —— 发布（tag 触发）

- 触发：推送形如 `v*.*.*` 的 tag（含预发布 `v1.0.0-rc.1`，glob `v*.*.*` 同样匹配）。
- 构建 + 推送到 GHCR（`ghcr.io/${{ github.repository_owner }}`）4 个镜像：`web`、`migrate`、`chatgpt-web-proxy`、`chatgpt-register`，tag 含语义 tag、`latest`、`sha-<sha>`。
- 起草（draft）一份 GitHub Release，附 docker-compose 部署包（`.tar.gz` / `.zip`）。

## 版本与发布流程（对齐 §0.2）

版本格式：`v<MAJOR>.<MINOR>.<PATCH>-<alpha|beta|rc>.<N>`（正式版去后缀）。

```bash
# 在 dev 验证通过、（按需）合入 main 后，在目标提交上打 tag 触发发布：
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1   # → 触发 docker-release.yml
```

## 分支保护（已启用）

`dev` 与 `main` 已通过 gh API 启用分支保护（2026-05-30）。Required status checks（5 个）：
`Docs mirror (CLAUDE == AGENTS)`、`Lint & format (changed files)`、`Typecheck`、`Unit tests`、`Build web`。
另：`strict=true`（合并前须与目标分支同步）、禁 force-push、禁删除、要求会话解决；`enforce_admins=false`（管理员可应急直推）。
`docker-build` 在 PR 上运行但未列为 required（保 PR 迭代速度），可按需提升。

修改配置示例：
```bash
gh api -X PUT repos/gaoren002/GPT2Image-Pro/branches/<dev|main>/protection --input <config>.json
gh api repos/gaoren002/GPT2Image-Pro/branches/<dev|main>/protection/required_status_checks  # 查看当前
```

## 已知边界 / 后续

### 首尔服务器精简部署

2 核、4 GB 内存服务器采用根目录的 `docker-compose.seoul.yml`，运行
PostgreSQL、一次性迁移和 Web 服务。生产域名与
生成图、头像桶名必须通过 `workflow_dispatch` 输入参与镜像构建。完整步骤见
[`deploy-seoul.md`](./deploy-seoul.md)。

- **第三方 Action 已钉 SHA**：`ci.yml` / `docker-release.yml` / `actions/setup` 中的第三方 Action 均钉到 40 位 commit SHA（行尾注释保留可读大版本），防 tag 重指向供应链攻击；由 dependabot 周更自动维护。升级大版本（如 checkout v5→v6）是单独的人工决策。
- **lint 仅覆盖改动文件**：若未来对全仓做一次性 `biome format` 重排，可将门禁升级为全仓 `biome ci`。
- **build 与 docker-build 在 PR 上各构建一次**：分别校验「代码可构建」与「镜像可打包」，刻意保留以提高鲁棒性；如需省额度可二选一。
- **测试为 DB-free 单测**：涉及真实 DB 的集成测试目前不在 CI 内（见 `docs/TODO.md` 端到端实测项）。
- **Windows 本地 `turbo build` 会在 standalone 拷贝阶段报 `EINVAL`**：Next 生成的 trace 文件名含冒号（`[externals]_node:fs_promises...`），Windows 文件名非法。编译本身成功；CI（Linux runner）与 Docker 构建不受影响——本仓库生产构建走 Docker/Linux。
- **行尾**：`.mjs` 等文件的 git blob 为 LF，CI（Linux）下 biome 检查通过；Windows 开发机因 `core.autocrlf=true` 本地工作副本为 CRLF，本地直接跑 `biome` 可能报 `format`（CRLF）告警，属本地假象，不影响 CI。
