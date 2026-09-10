# 2026-09-10 ChatGPT Web 请求协议校准

## 证据与边界

本次继续离线读取用户提供的 `captured-hars-raw.zip`，只核对请求结构、模型字段和挑战
算法，不保存凭据、消息标识、提示词或挑战令牌。会话信封以 Images 首页最新、5.6、5.5
三个版本的五档请求为核心证据，共 15 组 `conversation/prepare → conversation`；另以
Images/Work 合计 42 次正式提交交叉核对稳定字段。代码未使用 HAR 凭据重放真实账号。

ChatGPT Web 生图继续通过 `system_hints: ["picture_v2"]` 触发。抓包没有
Responses 风格的 `tools[].model`，也没有 Sunburst/Flare 图片型号字段，因此纯 Web
主组无论选择哪个图片型号，出站都按站内默认 GPT Image 2.5 协议处理；顶层 `model`
仍用于选择文字主模型。

`yukkcat/chatgpt2api` 的 2026-09-09
[`v3.2.3`](https://github.com/yukkcat/chatgpt2api/releases/tag/v3.2.3) 同样把 2.5
图片别名转换为 `model: "auto"` 加 `picture_v2`，没有发送独立图片型号。本站把图片
型号与文字主模型分开，因此只沿用“不发送 Web 图片版本字段”的结论。

## 会话信封

- 同一轮 prepare 与 submit 复用父消息 ID、`X-Oai-Turn-Trace-Id`、主模型和思考档位；
  草稿 `partial_query.id` 与正式消息 ID 分开。草稿发送完整提示词，不模仿浏览器逐字
  输入的 debounce 时机。
- prepare 使用 `Accept: */*`、`client_prepare_state: "none"`、
  `client_prepare_dispatch: "debounced"` 和
  `client_prepare_source: "composer_editor_state"`，不提前携带 Sentinel、conduit、
  `force_parallel_switch` 或 COT 展示字段。
- submit 使用 `Accept: text/event-stream`、`client_prepare_state: "success"`，并携带
  Sentinel 挑战令牌、prepare 返回的 conduit token、并行开关和 COT 展示字段。
- 两段请求都发送 `local_function_names: ["local.continue_in_work"]`、
  `photo_upload_action.v1` 响应契约和 Web Push 能力字段；正式用户消息增加
  `submission_mode: "manual_send"`。
- Images 的顶层和消息 metadata 都保留 `picture_v2`；Work 顶层 hints 为空，消息
  metadata 使用 `selected_sources: []`。调用方显式传入 `images | work` profile，模型
  目录不再依赖 hints 是否为空来猜测。
- 客户端标识更新为抓包最新的版本与 build，并添加稳定出现的
  `OAI-GenUI-Client-Actions: open_entity_detail`。账号 metadata 中存在
  `chatgptAccountId` 时，Web 请求会条件透传 `ChatGPT-Account-Id`；手工 AT/RT、账号
  换绑和已有账号也会从 access token 的嵌套 auth workspace claim 补全该字段，当前
  token 的 claim 优先于旧 metadata。结构化扫描压缩包内 53 个 HAR/JSON 文件时，去重后
  找到的 1 个 JWT 也使用该嵌套结构；文档不记录 claim 值。
- Sentinel 的 `oai-sc` 会被 requirements prepare/finalize 响应刷新。代理继续使用其
  session cookie jar；直连 Node fetch 以完整凭据、workspace 与后端 ID 的摘要隔离会话，
  保存一个同名 cookie，并在后续请求覆盖回传。HAR 中 requirements prepare 86/86、
  finalize 80/80 都设置了该 cookie。

## Sentinel 挑战

旧实现先 bootstrap，再调用已消失的单段
`POST /backend-api/sentinel/chat-requirements`，随后才发会话 prepare；其 PoW 使用
SHA3-512、18 项配置，且没有生成 Turnstile token。

当前普通 Images/Work 请求顺序为：

1. bootstrap ChatGPT 首页，读取 Sentinel SDK 资源；
2. `POST /backend-api/f/conversation/prepare`；
3. `POST /backend-api/sentinel/chat-requirements/prepare`，body 为 `{ p }`；
4. 解算 PoW 和 Turnstile；
5. `POST /backend-api/sentinel/chat-requirements/finalize`，body 为
   `{ prepare_token, proofofwork, turnstile }`；
6. `POST /backend-api/f/conversation`，在 headers 中回传最终 requirements、PoW、
   Turnstile 和 conduit token。

后端每轮在 submit 前获取新挑战，避免复用过期令牌；浏览器抓包中也存在缓存令牌的
时序，不能据此断言网页每次都会重新握手。抓包没有 PPT/PSD 专用请求；可编辑文件路径只
同步同端点已验证的 parent/trace、草稿 ID、prepare state 和调用顺序，继续保留原来的
专用模型、思考档位与消息 metadata。

PoW 已按当前 Sentinel SDK 改为 25 项浏览器配置、32 位 FNV-1a 风格哈希与 avalanche，
成功 token 以 `~S` 结尾。本站模拟一套内部一致的 Windows Edge 环境，时间区、语言、
Chromium heap limit、屏幕和 CPU 字段与会话上下文保持一致，不复制 HAR 中 Safari 设备的
个人指纹。`p` 与 proof 只复用同一设备 UUID，其余动态项在 proof 阶段重新采样。离线检查
的 31/31 个抓包 proof 样本都满足新算法；旧 SHA3 算法不满足。

Turnstile 使用受限 VM 解算 `dx`，包含总步数上限、严格输入校验，以及挑战访问的最小
DOM、Canvas、screen 和 navigator 环境。`Object.create(null)` 的属性按浏览器枚举语义
序列化；33/33 个配对挑战均能执行完且没有未知 opcode，其中能用本地环境密钥结构比对的
28 个样本，其 JSON 类型、字段数和字段键与浏览器逐一一致。随机数、计时、显卡和设备
环境不同，因此不能要求 token 逐字或等长；本次没有使用真实账号在线重放验证服务端接受。
若必需的 PoW、Turnstile 或 Arkose 无法满足，请求会在 finalize/submit 前明确失败。当前
抓包的 `so.required` 没有对应 submit token，参考的纯协议实现也未解算 SO；finalize 若
返回兼容性的 `so_token`，本站仍会转发。

## 主模型映射

- GPT-5.5 与 GPT-5.6 Sol 使用 Images 抓包直接验证的 slug 和档位。
- GPT-6 Astra、GPT-5.6 Terra、GPT-5.6 Luna 使用 Work 抓包验证的 `*-wm` slug、档位、
  `conversation_origin` 和 `service_tier`，再与 Images 的 `picture_v2` 组合。两部分字段
  分别有抓包证据，但该组合没有完整矩阵抓包，属于明确的集成推断。
- 管理员自定义 Web slug 继续走兼容 fallback，不写入已验证目录。

## 验证

- 回归测试覆盖会话两段信封、父/草稿/正式消息 ID、trace、Images/Work metadata、
  Sentinel prepare/finalize 字段、PoW 配置、Turnstile 成功与失败、主模型映射，以及
  Web 请求不包含 `tools` 或 `image_model`。
- Turnstile VM 单测覆盖基础指令、动态 opcode、嵌套队列、方法绑定、子程序返回、畸形
  输入和步数上限。
- `pnpm turbo test -- --fileParallelism=false`：Shared 552、Web 787，共 1,339 项通过。
- `pnpm turbo typecheck` 四个包通过；`pnpm --filter @repo/web build` 通过，仍只有仓库既有
  的 NFT 动态追踪与 middleware 命名警告。
- `pnpm turbo lint` 全量通过；同时清理了此前阻断该质量门的 7 个既有
  Biome error。
- 本次协议校准尚未部署。
