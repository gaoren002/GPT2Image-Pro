# 2026-09-09 模型升级蓝绿部署

本文记录本次生产部署的版本、验证结果与回滚位置，供后续维护使用；操作遵循
`docs/deploy-nginx-ab.md`，线上实例由 systemd 管理并经 Nginx 主备转发。

## 上线版本

- 用户明确要求蓝绿部署；2026-09-09 22:04 UTC 完成先备 3307、后主 3308 的切换。
- 生产代码提交：`7889acca52a91b832d852b36ac0da22eac0a5a7a`。
- 包含图片默认 GPT Image 2.5、文本模型与套餐权限更新、HAR 模型表兼容，以及纯 Web 主组任意图片型号统一路由至 2.5。
- 新 release：`/home/user1/gpt2image-releases/gpt2image-models-7889acca-20260909-220046`。
- 静态前缀：`/gpt2-assets-v20260909-models-7889acca-220046`；Next build ID：`H5iq72kblJVQWOdANmVX2`。
- 两个 Web 单元均指向新 release 的 `apps/web/.next/standalone/apps/web`；3307 PID 为 `1539382`，3308 PID 为 `1540606`。
- Nginx 配置未变；运行时配置继续使用共享 EnvironmentFile。

## 验证结果

- 上线前 1,308 项测试与全仓类型检查通过，改动代码文件 lint 无错误；全仓 lint 仍有 7 个已知历史错误，详见模型升级记录。
- 生产构建成功；release 包含 standalone 依赖、静态资源与 public，`sharp` 和 `onnxruntime-node` 加载成功。
- 3307、3308 和公网 `https://gpt2image.superapi.buzz` 各通过 8 项冒烟检查：首页 200 且使用新前缀、实际 JS/CSS 各 200、中英系统文档包含新增模型、两个模型列表入口匿名访问均为 401、生图页匿名访问为 307 并跳转 `/zh/sign-in`。
- 发布窗口内两个 Web 单元日志未出现所检查的模块缺失、端口冲突、未捕获异常、语法错误或查询失败标记。
- 数据库、超分 Worker、相关依赖相对旧生产 `7cb8fd45` 无变化，无需迁移或重启 Worker。Worker 保持旧 release、PID `355875`，`3310/healthz` 返回 `ok: true`。
- 本次部署未调用真实上游生图；冒烟结果不代表所有上游模型的真实生成均已验证。

## 回滚与取证

- 旧 release 保留：`/home/user1/gpt2image-releases/gpt2image-billing-7cb8fd45-20260831-061240`；超分 Worker 仍依赖该目录，不可清理。
- 部署状态、检查结果、构建日志及配置备份位于 `/home/user1/build/gpt2image-bluegreen-7889acca-20260909-220046`。
- 私有目录中的 `state.json` 记录切换前后目录、PID 与完成时间；`verification-3307.json`、`verification-3308.json`、`verification-public.json` 记录冒烟结果。
- 回滚时按 runbook 先恢复 3307、验证旧版就绪，再恢复 3308；对应 drop-in 原件为私有目录内的 `gpt2image-3307-agentparse.conf.before` 与 `gpt2image-3308-nopending.conf.before`，恢复后执行 `daemon-reload` 和对应服务重启。Worker 本次未变，无需回滚。
- 构建环境备份包含敏感配置，仅保留在私有目录，不提交仓库或输出内容。
