# 客户端断开与中止文案（2026-10-26，fc7cf7bb）

## 现象与结论

状态页的历史错误里出现 `The operation was aborted due to timeout`（归"平台"）。排查 10-25 至 10-26 的三条记录，全部是客户端自己断开了连接，并非任何超时：

- 两条是同一个 Go 客户端（`Go-http-client/2.0`）发的 `/v1/images/edits`（7 张参考图、high 画质），在约 118 到 122 秒时断开，符合 2 分钟客户端超时。
- 一条是 `curl` 发的流式 `/v1/chat/completions`，5.3 秒时断开。
- 我们自己的生成截止是 20 分钟（`IMAGE_GENERATION_PENDING_TIMEOUT_MS`），不可能在几秒或 2 分钟触发。

## 判别方法（排查同类问题可复用）

- 外部 API 的同步请求超过 2 秒后，服务端先发 200 响应头，之后每 10 秒写一段 2049 字节的空白保活，任务结束时才写最终 JSON（`createJsonKeepAliveResponse`）。
- Nginx 访问日志里这类请求状态是 200，响应体字节数恰好是 2049 的整数倍，说明最终 JSON 没有发出去，客户端在拿到结果前已断开。多出几百字节才是客户端在线收到了最终错误 JSON。
- 访问日志里的 User-Agent 和耗时能帮助判断客户端类型与它的超时设置。

## 机制

- 10-25 起（46c03ae9）外部 API 把 `request.signal` 传给生成，客户端断开会中止上游调用；此前断开后任务照常跑完并入库。
- Next 在连接先于响应结束关闭时，用名为 `ResponseAborted` 的 Error 中止 `request.signal`。`AbortSignal.any` 合成的生成信号取先中止的那个的理由；20 分钟截止信号的理由是 `TimeoutError`。
- 改动前，`retryPoolBackendResult` 对任何外层中止都写成 `The operation was aborted due to timeout`，真实原因丢失，状态页归平台，外部 API 回 502。

## 现在的行为

- `abort-reason.ts`：理由名为 `ResponseAborted` 时使用 `CLIENT_CLOSED_REQUEST_ERROR`；截止超时、无理由或未知理由仍用历史文案 `GENERATION_ABORTED_ERROR`。只有能证明是客户端断开时才改文案。
- `sla-classification.ts`：客户端取消文案与排队阶段取消文案（`Image generation queue request cancelled.`）归 `user_request`，不再计入平台失败。历史行不回填，仍按原文案归平台。
- 外部 API：两种取消文案都映射 499 `image_generation_cancelled`。
- 后端池：客户端取消文案算用户侧错误，不冷却后端、不换号、不算未分类错误。
- 新文案刻意不含 "aborted"：基础设施故障和审核服务故障的规则按子串匹配，含该字样会被抢先归为平台错误。

## 未做（另一类错误：`Storage error: Input buffer has corrupt header:`）

这类错误来自 10-25 新增的 `validateImage`（`generated-image.ts`，用 sharp 读图片头）。上游以 `b64_json` 返回的图片魔数合法但头部损坏，保存失败，用户积分全额退回。已知缺口：

- 校验在后端重试循环之外，坏图直接让请求失败，不会换后端；该后端还被记为成功，不会降权。
- 失败时没有任何诊断信息（图片长度、首尾字节、来源）。
- 只校验头部：用 sharp 0.35.5 实测，PNG 截掉一半仍能通过 `metadata()`，中途截断的图依然会被存下。
- 报错末尾详情为空不能说明是 PNG 坏了：PNG 头部残缺时详情确实为空，但并发时 sharp 的错误缓冲会被互相清掉（实测 120 个 WebP 坏图里 56 个丢了详情）。
- 量级很小：10-25 至 10-26 的 gpt-image-2.5 约 4600 个请求里只有 1 次。
