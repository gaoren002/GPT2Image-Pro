# Adobe Firefly 兼容转换

在非纯 Web 主组中，当一个请求带 `force_firefly`，或本身就是 `firefly-*` 模型、或在普通调度里兜底到了 adobe
后端时，我们把**站内标准请求（你的 prompt / size / quality / model / images）兼容转换成
Adobe Firefly 接受的格式**再派发。本转换是有损/语义近似的：站内的部分参数 Adobe 不消费，
会被静默忽略；gpt-image 请求落到 adobe 实际走的是 Firefly 侧的 gpt-image，风格/能力与
OpenAI 原生并非 1:1。

纯 Web 主组的图片请求统一使用 `gpt-image-2.5`，忽略图片别名与 `force_firefly`，不进入
Adobe 或 Adobe 来源 API，也不应用这里的模型转换和 Adobe 模型族倍率。

转换逻辑均可在源码核对：

- 模型族解析：`apps/web/src/features/image-generation/adobe-direct.ts`
  `resolveAdobeFamilyFromModel`（约 350-367 行；非 firefly → gpt-image-2）。
- size → 比例/分辨率：`packages/shared/src/adobe/firefly-request.ts` `mapSizeToAdobe`
  （约 55-81 行）。
- quality → detailLevel、图生图 referenceBlobs：
  `packages/shared/src/adobe/firefly-direct/payloads.ts`
  （`gptImageDetailLevelFromQuality` 约 139-149 行；gpt-image 图生图 referenceBlobs
  约 219-234 行）。
- 视频图生视频 referenceBlobs/referenceFrames：同文件约 286-345 行。

## 站内参数 → Adobe 字段/行为 映射表

| 站内参数 | Adobe 字段 / 行为 | 规则 |
| --- | --- | --- |
| `model` | Firefly 模型族（family） | `firefly-<family>...` 按最长前缀匹配出族；非 firefly 模型（含普通 gpt-image 经 force_firefly）一律落 `gpt-image-2`。family ∈ gpt-image-2 / gpt-image-1.5 / nano-banana / nano-banana2 / nano-banana-pro |
| `size`（WxH） | ratio + resolution | 见下「size 映射规则」 |
| `quality` | gpt-image detailLevel | low/medium/high → 1/3/5；`auto` 或未选 → 回退后端 `gpt_image_quality`（当前配置 high）→ 5。nano-banana 系不消费 detailLevel，透传无害 |
| 图生图 `images[]` | `referenceBlobs` | 先 `uploadImage` 拿 Adobe image id；GPT Image 使用 `usage:"subject"`，Nano Banana 使用 `usage:"general"`（新 API 已拒收 referenceImages） |
| 图生视频 输入图 | `referenceBlobs` / `referenceFrames` | 按视频族不同：kling 用 `{id, usage:"frame", order}`；sora2/veo31 用 `{id, usage:"general", promptReference:1}` |

### size 映射规则（mapSizeToAdobe）

- ratio：把 WxH 的宽高比取最接近的通用比例集合 `1x1 / 16x9 / 9x16 / 4x3 / 3x4`。
- resolution：按长边——`≤1024 → 1k`，`≤2048 → 2k`，否则 `4k`。
- size 非法 / `auto` → 回退后端默认（当前配置 ratio=1x1、resolution=2k）。

示例（按 mapSizeToAdobe 实算）：

| 站内 size | 宽高比目标 | 长边 | 映射结果 |
| --- | --- | --- | --- |
| 1024x1024 | 1.000 → 1x1 | 1024 | `1x1` / `1k` |
| 1792x1024 | 1.750 → 16x9（1.778 最近） | 1792 | `16x9` / `2k` |
| 1536x1024 | 1.500 → 4x3（1.333）与 16x9（1.778）中取 4x3 更近 | 1536 | `4x3` / `2k` |
| 2048x2048 | 1.000 → 1x1 | 2048 | `1x1` / `2k` |
| 4096x2304 | 1.778 → 16x9 | 4096 | `16x9` / `4k` |

> 注意：`1024x1024` 长边正好 1024，落 `1k`（非 2k）。要 2K 方图请用 `2048x2048`。

## 被忽略的参数（Firefly 不消费，静默忽略、不报错）

- `output_format`（Firefly 产物格式由上游决定，站内 re-host 后统一处理）
- `background` / 透明底（不支持透明背景）
- OpenAI moderation 级别（站内审核独立，见 operations 管线）
- `thinking`（思考强度，仅对站内 chat/agent 有意义）
- `output_compression`

这些参数传了不会让请求失败，只是不影响 Adobe 派发结果。

## 计费换算

图像总积分按以下链路相乘（见 `operations.ts` 约 1349-1377 行与
`image-backend-pool/service.ts` 约 2867 行）：

```
总积分 = 基础积分(按尺寸) × 模型族倍率 × Adobe 后端倍率 × 分组倍率
```

- 基础积分：按输出像素插值（1024² 与 4096² 两端之间线性插值，admin 可配 base1024 / base4k）。
- 模型族倍率：`resolveImageModelMultiplier`，从 IMAGE_MODEL_MULTIPLIERS 取，非 firefly 族为 1。
- Adobe 后端倍率：该 adobe 成员的 `billing_multiplier`（当前配置 1）。
- 分组倍率：选中分组（含子组叠乘）的 billingMultiplier（`getEffectiveBillingMultiplierForSelectedGroup`）。

> 实现细节：service.ts 把 `分组倍率 × Adobe 后端倍率` 预先折进 `config.backend.billingMultiplier`，
> operations.ts 再乘模型族倍率，得到本次请求统一的 `billingMultiplier`，扣费/明细/退款口径一致。

视频总积分：

```
总积分 = ceil2(每秒基价(默认 30) × 时长秒数 × 视频模型族倍率) × Adobe 后端倍率 × 分组倍率
```

### 算例：nano-banana-pro、2K、混合分组

- 基础积分（2048x2048 ≈ 4.19M 像素，按当前 base 配置）≈ **1.91**（admin 可配，示例值）。
- 模型族倍率 nano-banana-pro = **1.5**。
- Adobe 后端倍率 = **1**。
- 混合分组倍率 = **1**。
- 总积分 ≈ `ceil2(1.91 × 1.5 × 1 × 1)` ≈ **2.87**（最终向上取整口径以扣费实现为准）。

## 有损/语义近似声明

本转换是「尽力适配」而非等价映射：

- 普通 gpt-image 请求经 force_firefly 落 adobe，实际由 Firefly 的 gpt-image 出图，风格、
  细节控制与 OpenAI 原生有差异。
- size 被量化到 Firefly 支持的有限比例/分辨率集合，非任意像素精确还原。
- quality 仅对 gpt-image 族映射成 detailLevel，对 nano-banana 系不生效。
- 透明底、output_format 等站内参数在 Firefly 侧无对应能力，被忽略。

## 相关文档

- 路由与兜底调度（adobe 如何挂入分组、按 priority 兜底）：`docs/adobe-firefly-routing.md`
