# MEMORY — 实时关键记忆索引

> 项目长期记忆索引。详细记忆见 `docs/memory/`，计划见 `docs/plan/`，待办见 `docs/TODO.md`。
> 这是所有贡献者 Agent 的共享长期记忆，请保持精简，每条一行。

## 安全

- [2026-05 安全审计](security-audit-2026-05.md) — 6 维度并发安全审查；高危经济/入侵口子已在 dev 修复（2beb0e0/b69c10b/14a88d8/07d7a18）
- [2026-05-31 对抗式审计报告](plan/2026-05-31-audit-report.md) — 12子系统x3镜头确认128条(critical1/high27/medium58/low39/info3)
- **2026-05-31 修复 workflow 完成**：先修 S-C1(03cc6bd)/S-H5(edbc0d6)/S-H1+H2(f1216df)；再经 15 单元并行修复 workflow 共修 94 条、未修 23 条、defer 4 个上帝组件；dev 9 主题提交 0babd1f..01906e0(封禁会话/回调SSRF/存储越权/限流fail-open/moderate恒定时间/注册冷却/external-api+支付+订阅+生成覆盖)；终验 typecheck+test 全绿(shared235+web257=492)。未修与 defer backlog 见 [测试重构计划](plan/2026-05-31-audit-test-refactor.md)
- **2026-05-31 安全修复 workflow 二轮（遗留项）**：7 单元对抗复核后保留 5 条(dev 提交 4208681..6f48522)——S-L2 webhook 不吞异常 / S-L1 consumeCredits 按 userId 归属+迁移0029 / S-M8 设置范围校验 / M-H5 admin 集中守卫 / v1 per-key 限流；S-M11 仅 detect-only 软门闩(默认不拒)。**回退 2 条**：U3 S-L7 generations 桶 cookie 鉴权(破坏 v1 API 默认 url 返回的无 cookie 拉取，须改签名 URL)；U7 SSRF pin(Next16 patchFetch 致生产不走 pin+假绿灯)。详见 [测试重构计划](plan/2026-05-31-audit-test-refactor.md)
- **#1/#15/#16 浏览器实测通过**（api2 隔离测试栈 2026-05-31，未发现真实 Bug；积分首屏短暂0为异步发放假象自愈）
- **2026-05-31 安全修复三轮（全部遗留项）**：4 条并行修复+对抗复核，dev 提交 cfb3861..06e4709——S-L7 签名 URL 替代 cookie 鉴权 / S-M11 Creem 纯函数抽离+369 行单测 / SSRF 无条件 DNS pin(node:http/https 不经 Next patch) / COST quality+thinking 积分倍率。288 web + shared 全绿。残留：裸 fetch 路径(operations.ts toImageBuffer/images.ts getImageBase64)未接 pin，见 TODO。
- [待办清单](TODO.md) — 仍存在的代码层问题 + 部署前必做

## 架构

- [Agent 集成架构](plan/2026-05-31-agent-integration-architecture.md) — 统一接口层(UOL)优先；MCP 适配器默认关闭+管理秘钥；内置 agent 直连接口层；配套盘点表 plan/2026-05-31-feature-interface-inventory.md。**开发新功能前必读**（CLAUDE.md 已立约束）
- **UOL Phase 0+1 已实现**（分支 `feat/uol-phase0-phase1`，已推送）：脚手架 7 核心模块 + 144 个操作注册(10 域) + 3 测试文件(registry/access/invoke)全绿。execute 均为 stub("Not yet wired")，待 Phase 2 委托对接。合并 dev 前须经 CI。

- [图像后端池调度策略](image-backend-pool-scheduling.md) — 车道模型(web/codex/mixed × mixed-only)、候选资格(account 靠 implementationMode、api/adobe 靠分组车道)、mixed 分组 web 先行→回退 codex、满并发短等、冷却=已尝试;**常驻 alwaysActive 与换号判断正交**(只动持久化状态,不影响要不要换/换到谁/回退)

## 功能

- [2026-09-09 模型升级](memory/2026-09-09-model-upgrade.md) — 图片默认 `gpt-image-2.5` 别名出站映射 Sunburst；普通文本仅 5.5，Ultra+ 通过 `models.premium` 开放 Astra 与 5.6 三款；2.5 混合组跳过无法锁定版本的 Web，报价同步。

- [纯中转 API Key](plan/2026-05-30-relay-only-api-key.md) — relay_only key：不记录/不存储/仍扣费仍审核；附带修复 consumeCredits 幂等（dev: 7c6da21→e957f48）
- **首页影片化 v1.2（2026-07-23/24，已落地 main）**：自研水墨 NPR 管线（gl/ink 共享 GLSL 库）+ 三大奇观（dive 入画千里江山/展墙墨池真倒影焦散/macro 浮雕迎光）+ 光标抚墨三路分发 + 镜头签名 + 单项熔断（最贵 pass 先行牺牲，breakerListener→context 通知 DOM 兜底恢复）；落地记录与 11 条实施勘误见 [设计稿十一节](plan/2026-07-23-homepage-cinema-v12-design.md)
- **首页数据分层缓存（2026-07-24，2026-07-25 更新，main）**：营销首页稳定配置使用 1h 进程内单飞缓存，最近 1000 条已完结生成的 SLA 使用独立 120s 单飞缓存（`features/marketing/home-data.ts`）；settings 查询失败按空设置兜底（负缓存 5s，DB 抖动不整站 500）；管理端写设置经 `setSettingsCacheInvalidator` 级联失效立即生效；SLA 统计失败隐藏区块并负缓存 120s，session 失败按匿名。**注意**：负缓存 5s 窗口内计费读路径落默认值（下单/扣费写路径仍 fail-closed），多副本部署时其余副本首页配置最长 1h 滞后，SLA 最长 120s 滞后（单容器无影响）。
- **Issue #1/#15/#16 修复**（dev: a2dd4dc/10d0bc8/c8e9118，详见 [TODO.md](TODO.md)）— #1 管理员建号/改密改邮箱(superAdminAction+better-auth hashPassword)；#15 瀑布流 tier/参数/3警告对齐原项目；#16 数量控件改数字输入+滚轮、上限与服务端 count 校验统一挂 `imageGenerationConcurrency`（**语义变化**：单次张数上限不再用 maxBatchCount）。待 UI 实测。

## 工程 / CI

- [CI/CD 流水线](CI-CD.md) — ci.yml 6 门禁（docs-mirror/lint/typecheck/test/build/docker-build）+ docker-release(tag) + dependabot
- lint 门禁**仅 PR、仅改动文件**用 `biome lint --changed`（非 `biome ci`——全仓历史未 biome 格式化；对齐团队 `turbo lint` 约定）；typecheck/test/build 全仓 push+PR 双跑
- typecheck job 必须先 `pnpm --filter @repo/web exec fumadocs-mdx` 生成 `.source`（gitignore 忽略、独立 tsc 不自生成），否则连锁 any 报错
- CLAUDE.md ≡ AGENTS.md 为镜像文件，CI `docs-mirror` job 强制逐字一致；改一个必须同步另一个
- **分支保护已启用**（dev+main，5 required checks，strict）；远端仓库已迁移至 `MeowFree/GPT2Image-Pro`（旧 `MoYeRanqianzhi/...` 会重定向）
- 第三方 GitHub Action 全部钉 40 位 SHA（dependabot 维护）；第三方 action major 升级是单独人工决策
- Dependabot 已忽略 semver-major（npm + actions）；major 升级人工评估
- **kysely 被 pnpm override 钉在 0.28.17**（根 package.json）：better-auth 1.6 放宽 peer 让 kysely 浮到 0.29，而 0.29 把迁移导出迁到 `kysely/migration` 子路径、随 better-auth 打包的 kysely-adapter 仍从根导入 → next build 编译炸。待上游修复后移除（见 docs/TODO.md）

## 关键架构事实

- 5 个 v1 handler 最终汇入 `apps/web/src/features/image-generation/operations.ts` 同一管线（`runImageGenerationForUser`）
- 财务真相在 `credits_transaction`（双重记账），不在 `generation` 行；`generation` 仅历史/画廊展示
- 扣费幂等键：`consumeCredits(sourceRef)` + `credits_transaction (type, source_ref)` 偏唯一索引（opt-in，不传则行为不变）
- 发放/退款幂等键：`credits_batch (source_type, source_ref)` 偏唯一索引
