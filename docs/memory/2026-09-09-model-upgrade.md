# 2026-09-09 模型默认值与套餐权限升级

## 行为

- 图片默认值为 `gpt-image-2.5`，这是本站别名；向 Images API 和 Responses 图像工具发送时解析为 `gpt-image-2.5-sunburst`。显式 Sunburst、Flare、旧 `gpt-image-2` 保持原样，前端选择器与 `/v1/models` 同步列出。
- 普通套餐文本模型仅 `gpt-5.5`；`models.premium` 默认从 Ultra 开放 `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。默认文本模型仍为 GPT-5.5。已有 `models.gpt55` 配置的门槛兼容迁移到新能力，显式新配置优先。
- 统一管线和出站服务都校验文本模型；原样 Responses 请求写回已校验模型，逐个解析图像工具别名。Astra 的 `none/minimal` 推理强度归一为 `low`。
- 合并远端 `1a005a7f`，保留已有 2.5 双款模型和 `xhigh/max` 图像质量档位支持。Adobe Firefly 的模型族不变。

## Web 边界

- 用户确认 ChatGPT Web 默认图片引擎已经是 GPT Image 2.5，沿用 `picture_v2` 即可。先前因缺少 API 风格版本字段而加入的限制被用户否决并移除。
- 默认、Sunburst、Flare 图片选择均可进入 Web 生成/编辑流程；混合组恢复既有 Web 优先、失败后回退逻辑，报价按预测车道计算。真正需要 Responses 的 Agent 等请求仍按原业务限制调度。
- 后续依据用户 HAR 补齐五模型的 Work slug 与 Images 预设，详见 [HAR 模型表](2026-09-09-har-model-catalog.md)。套餐权限、API/Codex 的图片模型字段映射保持不变。

## 来源

- [OpenAI Docs：GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [OpenAI Docs：GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI Docs：GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [chatgpt2api 固定提交源码](https://github.com/basketikun/chatgpt2api/blob/dc105e51bd486bd75c8ef4f74be4bc4724bdfc33/services/openai_backend_api.py)

## 验证

- `pnpm turbo test`：Shared 552 项、Web 652 项，共 1,204 项通过。
- `pnpm turbo typecheck`：四个包通过。
- `pnpm turbo build --filter=@repo/web`：通过；使用占位数据库和站点配置做构建验证，不作为线上部署产物。
- 本次 36 个代码与 JSON 文件的 Biome lint 通过；`git diff --check`、AGENTS/CLAUDE 镜像校验通过。
- 全仓 `pnpm turbo lint` 仍有 7 个既有错误，涉及两个 loading.tsx 的数组索引 key、json-ld.tsx 的 HTML 注入规则、PSD orchestrator.ts 的表达式赋值、internal-job-scheduler.ts 的不可达代码；这些文件与合并后的远端基线一致。
- 未进行真实账号出图验证，未切换线上运行服务。
