# 2026-09-09 纯 Web 分组统一图片模型

## 用户决定

用户确认 Web 默认图片引擎已是 GPT Image 2.5，并进一步明确：“对于 web 组就当是什么模型都路由至 2.5”。此规则覆盖纯 Web 主组的任意图片型号，包括旧 GPT Image、Sunburst、Flare、Firefly 和自定义图片别名。

## 执行规则

- 按实际选中的主分组类型判断。纯 `web` 主组固定图片型号为 `gpt-image-2.5`；`mixed` 主组选到 Web 子组不会改变整个主组的型号规则。
- 后端池在候选过滤前归一型号并清除 Firefly 意图，纯 Web 组的 `force_firefly` 也不改走 Adobe。换号、递归选号和结果配置写回使用同一策略。
- Adobe 和 Adobe 来源 API 会把普通图片请求改回旧模型，故从纯 Web 组候选中排除；普通 API 保留，并明确发送标准 2.5 图片型号。账号和 API 的实际失败仍走既有重试，不跨纯 Web 分组。
- 出站服务将纯 Web 组图片请求统一为 2.5；真正的网页请求继续 `picture_v2`，普通 API 的本站别名映射为 `gpt-image-2.5-sunburst`。
- 统一操作在积分倍率与生成记录之前解析实际图片型号，纯 Web 不按传入的 Firefly 型号加模型族倍率。生成/编辑记录为 2.5；聊天仍记录文本主模型，图片元数据为 2.5。
- 图片 API 的字符串别名交给选组后的统一操作处理；空白仍使用默认值，非法类型仍拒绝。非 Web 分组继续校验图片型号，错误仍为 HTTP 400。
- 聊天顶层文本模型、`gptModel`、旗舰权限、套餐能力、请求类型限制和分组访问权限保持各自校验，不因图片归一而放开。
- 创作页纯 Web 下的有效图片型号固定 2.5，消除旧 Firefly 选择对控件和临时卡的影响；原选择仍保存在状态中，切回其他组时恢复。

## 实现位置

- `image-backend-pool/model-routing.ts`：主组型号和 Adobe 候选策略。
- `image-generation/resolution.ts` 的 `getImageModelForGroup`：实际图片型号，供计费、记录及出站使用。
- `external-api/image-model-input.ts`：图片字段结构校验后的别名保留。
- `image-generation/operations.ts`、`service.ts`、`components/create-page-client.tsx`：执行、计费、展示一致。

本次没有更改数据库结构，没有使用 HAR 凭据或真实账号回放，也没有部署。

## 验证

- `pnpm turbo test -- --fileParallelism=false`：Shared 552、Web 756，共 1,308 项通过。
- `pnpm turbo typecheck`：四个包通过；改动代码 Biome lint 无 error，diff 与 AGENTS/CLAUDE 镜像检查通过。
- 先复现未知型号提前被拒绝、旧型号透传和纯 Web 路由错误，再验证图片生成/编辑/聊天入口、非法类型、400 错误、主文本型号保持独立和非 Web 分组规则。
- 全仓 lint 仍有七个此前存在且本次未改动的错误，涉及两个 loading 文件、JSON-LD、PSD orchestrator 与 internal-job-scheduler。
