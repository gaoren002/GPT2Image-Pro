# 2026-09-09 HAR 模型表与 Web 协议校准

## 证据范围

来源为用户提供的 `captured-hars-raw.zip`，SHA-256：
`173f410e9def48032b089dd90369e887e3f7a34c6389a0af894e96d38ce9ec7b`。
以下索引均从 0 开始。仅持久化模型字段、请求位置和验证结论，不复制凭据、会话标识或用户内容；没有使用 HAR 凭据重新请求上游。

模型目录、实际请求和最终结果分别核对。目录声明可用不等于完成实测；HTTP 200、SSE DONE 或 stream handoff 也不能单独证明完成。原始 HAR 比汇总文件更优先：早期 summary 中部分“未验证”结论已被后续捕获补齐。

## Work 普通聊天

| 站内/API 模型 | Web 请求 slug | Work 支持的 thinking_effort | Work 目录默认档 |
| --- | --- | --- | --- |
| `gpt-6-astra` | `gpt-6-astra-wm` | min / standard / extended / xhigh / max / ultra | standard |
| `gpt-5.6-sol` | `gpt-5.6-sol-wm` | min / standard / extended / xhigh / max / ultra | min |
| `gpt-5.6-terra` | `gpt-5.6-terra-wm` | min / standard / extended / xhigh / max / ultra | standard |
| `gpt-5.6-luna` | `gpt-5.6-luna-wm` | min / standard / extended / xhigh / max | standard |
| `gpt-5.5` | `gpt-5.5-wm` | min / standard / extended / xhigh | standard |

目录证据为 `chatgpt-image-generation.har #198` 和 `work-gpt55-chat-all-levels.har #164` 的 `GET /backend-api/tpp/models/`。普通 `/backend-api/models` 对同名 Work slug 的档位描述较少，不能覆盖 Work 专用目录。

27 个固定档位请求均在原始会话 GET 找到同轮、同模型、同档位的最终消息，状态 `finished_successfully`、`end_turn=true`。其中固定 Sol/min 的最终正文为空；其余 26 条有预期答案。额外推荐 Sol 请求也有终态，不计入 27 档矩阵。

| HAR | 正式 POST 索引，按上述档位顺序 | 主要结果 GET 索引 |
| --- | --- | --- |
| `work-astra-chat-all-levels.har` | 66, 103, 127, 164, 188, 218 | 690（min）、580（其余） |
| `work-sol-chat-all-levels.har` | 185, 210, 234, 255, 277, 300 | 658；min 见 `work-conversation-history.har #38` |
| `work-terra-chat-all-levels.har` | 7, 42, 70, 90, 111, 134 | 484；min 见 `work-conversation-history.har #14` |
| `work-luna-chat-all-levels.har` | 9, 37, 67, 93, 117 | 470 |
| `work-gpt55-chat-all-levels.har` | 8, 39, 60, 89 | 451 |

prepare 和 submit 都发送 `thinking_effort`、`conversation_origin: "tpp"`、`service_tier: "standard"`；聊天的 `system_hints` 为空。Astra prepare `#217` 与 submit `#218` 验证了 ultra 请求。实际 submit 的 `force_parallel_switch` 为 `auto`，没有旧 `paragen_thinking_level`。

代码中的 `none/minimal/low → min`、`medium → standard`、`high → extended`、`xhigh → xhigh`。缺省按该模型目录默认档，关闭提示优化时使用 min。Web 专属 max/ultra 记入目录，尚未扩展站内统一 reasoning 输入或选择器，不能把它们直接当作 API reasoning 枚举。

## Images 首页

| 页面版本 | 即时：请求 slug（无 effort） | 中 / 高 / 极高：请求 slug + effort | Pro：请求 slug + effort |
| --- | --- | --- | --- |
| 最新 | `gpt-5-6` | `gpt-5-6-thinking` + standard / extended / max | `gpt-6-pro` + standard |
| 5.6 | `gpt-5-6` | `gpt-5-6-thinking` + standard / extended / max | `gpt-5-6-pro` + standard |
| 5.5 | `gpt-5-5-instant` | `gpt-5-5-thinking` + standard / extended / max | `gpt-5-5-pro` + standard |

15 组首页请求均使用 `system_hints: ["picture_v2"]`，并能从原始 GET 关联到本轮成功的图像工具消息和图像资源指针。另有一条续写探针使用空 system_hints，也出图，但不计入首页矩阵。这里只独立核验 HAR；报告中的 PNG 文件哈希结论没有当作本次重新检查图片文件的结果。

| 组别 | 正式 POST 原始位置，按即时、中、高、极高、Pro 顺序 |
| --- | --- |
| 最新 | `images-latest-all-levels.har #79/#677/#1227/#1762`；`chatgpt-image-generation.har #4` |
| 5.6 | `images-gpt56-home-1-instant.har #64`、`2-medium.har #76`、`3-high.har #75`、`4-extreme.har #98`、`5-pro.har #70`（后四项同前缀 `images-gpt56-home-`） |
| 5.5 | `images-gpt55-home-1-instant.har #103`、`2-medium.har #69`、`3-high.har #106`、`4-extreme.har #78`、`5-pro.har #70`（后四项同前缀 `images-gpt55-home-`） |

5.6 即时的目录 slug 为 `gpt-5-6-instant`，实际请求是 `gpt-5-6`；模型表保留两者。Pro 预设目录未写 effort，但实际请求为 standard。最新 Pro 的捕获与其他组并非同一提示词，不能由这份资料推断质量优劣，也不能把 `gpt-6-pro` 当作 Astra 的别名。

现有 Images 路径将站内 5.5、Sol 分别映射至上述 5.5、5.6：none/minimal 或关闭提示优化选即时；medium/high/xhigh 对应 standard/extended/max；low 与缺省使用已验证的最低思考预设 standard。其他型号不擅自映射成 Pro 或 Work 图片路径。

## 会话读取与版本边界

- 新查询为 `GET /backend-api/conversations/{id}?include_has_versions=true&num_turns=10`，返回 `messages[]`、`current_node`、`page_info`。仅在新端点不存在时兼容旧 `/backend-api/conversation/{id}` 与 mapping；限流、鉴权、服务故障不追加旧端点请求。
- 新消息按用户消息的 `working_turn_id` / `turn_exchange_id` 与父链关联，隔离前后轮次。抓包没有翻页请求，未猜测 cursor 参数；本次查询只读取最新十轮。
- Work 的 analysis 文本不是最终答复；空的最终答复仍应结束轮询，不能沿用此前文本。
- HAR 没有证明能选择 `gpt-image-2.5`、Sunburst 或 Flare。`picture_v2` 仅说明调用图片工具；部分工具 metadata 的通用模型 slug 也不能证明图片引擎版本。保持 Web 2.5 显式版本保护与混合组转 Responses 的行为。
- Work 目录声明图片工具可用，不代表本资料实测了 Work 五模型的图片工具矩阵。

## Astra + Sunburst 的 API 配置

用户给出的配置片段已经符合现有管线的模型分工：顶层 `model: "gpt-6-astra"` 是文本模型，`tools[].model: "gpt-image-2.5-sunburst"` 是图片模型。完整 Responses 调用仍需提供 input。原始请求规范化与站内生成/编辑均保持这两个值，显式 Sunburst 不被后端默认 Flare 覆盖；新增精确配对回归。

普通套餐仍只能选择 GPT-5.5；旗舰权限仍控制 Astra 与 5.6 三款。Web slug 只作内部转换，不加入公开可绕过权限的模型 ID 列表。图片默认别名仍映射 Sunburst。以上为代码与抓包验证，未部署、未使用真实账号重新出图。

## 本次验证

- `pnpm turbo test -- --fileParallelism=false`：Shared 552、Web 706，共 1,258 项通过。串行文件调度沿用已记录的测试稳定性经验，未跳过用例。
- `pnpm turbo typecheck`：四个包通过。
- 七个改动代码文件的 Biome lint 无 error；`git diff --check`、AGENTS/CLAUDE 镜像检查通过。
- 全仓 lint 仍是原有七个错误，涉及两个 loading 文件、JSON-LD、PSD orchestrator 和 internal-job-scheduler；已核对这些文件相对本次起始 HEAD 没有改动。
- 模型请求体、新旧会话查询、跨轮隔离、空终稿和 Astra/Sunburst 配对由模拟网络与纯函数测试覆盖。没有进行线上账号回放或部署。
