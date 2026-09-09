# Adobe Firefly 路由与兜底调度

本文描述 Adobe Firefly 后端（adobe，mode=direct「Adobe Firefly 直连」）如何作为一个
特殊的 firefly account 成员挂入后端分组，并按 priority 参与同池调度，从而天然成为
非纯 Web 主组中普通图像请求的兜底层。所有行为均可在下列源文件核对：

- 调度选择：`apps/web/src/features/image-backend-pool/service.ts` 的 `selectPoolMember`
  （`fireflyOnly` 判定见约 2099-2101 行，adobe 候选构造见约 2536-2590 行，候选合并/按
  priority 排序见约 2592-2698 行）。
- 主组优先与模型前缀规则：`apps/web/src/features/image-backend-pool/model-routing.ts`。
- force_firefly 透传：`apps/web/src/features/image-generation/operations.ts`
  （约 1118-1129 行，force_firefly/firefly-* 强制关闭 preferWebFirst）。

> 注意：本文中的具体数值取自下方「当前生产配置（示例，以 admin 实际为准）」。这些字段
> 全部在 admin 控制台「Adobe 后端」tab 与「分组」配置中可改，文档随配置而变。

纯 Web 主组的图片请求接受任意图片别名，统一使用 `gpt-image-2.5`；旧版、Sunburst、
Flare、`firefly-*` 或其他图片名称均不改变实际型号。`force_firefly` 不能覆盖此规则，
Adobe 直连与 Adobe 来源 API 均被排除，不作为兜底。Chat/Responses 顶层文本模型仍按原
白名单和套餐权限校验。下文 Adobe 路由规则适用于非纯 Web 主组；混合主组选择 Web 子组
不会改变其原有模型路由规则。

## 1. adobe 作为分组成员如何参与调度

`selectPoolMember` 把一个分组（或其子组 child groups 展开后的多个分组）的三类成员一起
拉取为候选：

- `api`：通用 OpenAI 兼容中转后端；
- `account`：ChatGPT web / codex 账号后端；
- `adobe`：Adobe Firefly 直连后端（本特殊成员）。

三类成员合并后进入同一个候选池，统一按以下顺序排序选取（见 service.ts 约 2654-2692 行）：

1. 先按 `priority` 升序（数字越小越先选）；
2. priority 相同再按健康度分桶（错误率/时延 EWMA、连败惩罚）；
3. 再按最近占用时间 `lastAcquiredAt` / `lastUsedAt` / `createdAt` 做负载均衡。

排在前面的候选先尝试获取并发租约（concurrency 限额）；若该候选已满额/被排除/暂时不可用，
继续尝试下一个。这就是「兜底」的机制本质：把 adobe 的 `priority` 设为一个大数，它在排序
中自然落到该组其它成员之后，只有当前面成员都限流/耗尽/不可切换时才会轮到它。

## 2. 当前生产配置（示例，以 admin 实际为准）

Adobe 后端「Adobe Firefly 直连」字段：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| mode | direct | 本仓库直连 Firefly（非外部 adobe2api 网关） |
| 所属分组 | 混合分组（默认组，用户可选） | 经子组纳入 web/codex 成员 |
| priority | 100 | 大数 = 该组兜底层（见下） |
| concurrency | 10 | 并发租约上限 |
| always_active | 是 | 无视临时冷却始终入选（status=error 仍踢出） |
| supports_video | true | 参与视频（图生视频）派发 |
| enabled_models | gpt-image-2、gpt-image-1.5、nano-banana、nano-banana2、nano-banana-pro | 该后端可用的 Firefly 图像族 |
| 默认 ratio | 1x1 | size 缺省/auto 时回退比例 |
| 默认 resolution | 2k | size 缺省/auto 时回退分辨率 |
| gpt_image_quality | high | quality=auto/未选时的 detailLevel 取值依据 |
| billing_multiplier | 1 | 本后端计费倍率（与分组倍率相乘） |

已配模型族倍率（系统设置 IMAGE_MODEL_MULTIPLIERS / VIDEO_MODEL_MULTIPLIERS，其余族默认 1）：

- 图像：`{ gpt-image-2: 1, nano-banana-pro: 1.5 }`
- 视频：`{ sora2: 1, sora2-pro: 2, veo31: 1.5 }`

在「混合分组」里 adobe priority=100 是大数，而组内 web/codex 账号与 api 成员通常优先级更小
（数字更小先选），因此普通图像请求会优先打到 web/codex/api；只有当它们限流、耗尽配额或
返回可切换错误（见 service.ts 的 `isImageBackendSwitchableError`）时，调度才轮到 adobe
兜底出图。

## 3. 三种进入 adobe 的方式

非纯 Web 主组中，`forceFirefly` 或 `firefly-*` 前缀决定候选集是否收敛到 Adobe 路由
（含 Adobe 来源 API）。据此有三种进入路径：

### ① 普通请求兜底（fireflyOnly = false）

- 判定条件：请求模型不是 `firefly-*` 前缀，且未带 `force_firefly`。
- 候选集：`api` + `account` + `adobe` 一起按 priority 排序。
- 结果：adobe 只是候选之一。是否真的轮到它，取决于 adobe 是否在用户所在分组、以及它的
  priority 是否高于（数字大于）其它成员。当前配置下（priority=100）它是兜底层。

### ② 模型名以 `firefly-` 开头（fireflyOnly = true）

- 判定条件：`requestedModel` 以 `firefly-` 开头（如 `firefly-nano-banana-pro-2k-16x9`，
  或只写族名 `firefly-gpt-image-2`）。
- 候选集：排除普通 `api` 与 `account`，保留 adobe 和 Adobe 来源 API。
- 结果：显式选 Firefly 族出图，绕过 web/codex/普通 api。

### ③ `force_firefly: true`（fireflyOnly = true）

- 判定条件：请求带站内扩展标志 `force_firefly`（或 `forceFirefly`）为真。
- 透传链：route/handlers → `operations.ts`（同时强制 `preferWebFirst=false`，见约 1123-1129
  行）→ `getEffectiveConfig` → `resolveImageBackendPoolConfig` → `selectPoolMember`
  （`forceFirefly` 参数）。
- 候选集：与 ② 相同，保留 adobe 和 Adobe 来源 API。
- 结果：对任意模型（含普通 gpt-image）强制改用 adobe 出图；模型族解析见兼容转换文档。

## 4. 如果 adobe 不在用户所在分组会怎样

adobe 候选来自当前分组（含子组展开）。纯 Web 主组始终按前述固定型号规则出图。
若非纯 Web 主组不含 adobe 或 Adobe 来源 API 成员：

- 方式 ②（firefly-* 模型）与方式 ③（force_firefly）：候选收敛到 Adobe 路由，但该组没有
  对应成员，候选为空，`selectPoolMember` 返回 null，上层抛
  `ImageBackendPoolUnavailableError`（「当前生图后端分组没有可用账号或 API」）。即对这两类
  请求表现为「无可用后端」。
- 方式 ①（普通请求）：不受影响——候选仍有该组的 api/account 成员，照常出图，只是没有
  adobe 兜底。

因此把 adobe 加入哪些分组、设何 priority，直接决定了「谁能用 firefly/强制 adobe」以及
「普通请求是否有 adobe 兜底」。这些都在 admin「Adobe 后端」tab 与分组配置里调整。

## 相关文档

- 兼容转换（站内标准请求如何被改写成 Adobe 接受的格式）：`docs/adobe-firefly-compat.md`
