# 首尔服务器精简部署

这套部署面向 2 核、4 GB 内存的首尔服务器。运行 PostgreSQL、一次性数据库
迁移和 Web 服务，不启动可选的 ChatGPT Web 代理。

## 构建镜像

从 GitHub Actions 手动运行 `docker-release.yml` 时必须填写：

- `next_public_app_url`：最终公网地址，例如 `https://image.example.com`。
- `generations_bucket_name`：生成图私有桶。
- `avatars_bucket_name`：头像桶。

这些值会写入浏览器端构建产物，只修改服务器环境变量不会完全生效。
标签推送仍使用本地开发默认值，生产部署应按站点重新手动构建。

## 最小环境变量

服务器环境文件至少包含：

```dotenv
GPT2IMAGE_IMAGE_TAG=sha-<commit>
WEB_PORT=3310
POSTGRES_DB=gpt2image
POSTGRES_USER=gpt2image
POSTGRES_PASSWORD=...

BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://image.example.com
BETTER_AUTH_TRUSTED_ORIGINS=https://image.example.com
NEXT_PUBLIC_APP_URL=https://image.example.com

STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_BUCKET_NAME=gpt2image-seoul-uploads
NEXT_PUBLIC_GENERATIONS_BUCKET_NAME=gpt2image-seoul-generations
NEXT_PUBLIC_AVATARS_BUCKET_NAME=gpt2image-seoul-avatars

SELF_USE_MODE_ENABLED=true
REGISTRATION_FIXED_VERIFICATION_CODE=
PAYMENT_PROVIDER=none
NEXT_PUBLIC_PAYMENT_PROVIDER=none
CONTENT_MODERATION_ENABLED=false
IMAGE_GENERATION_GLOBAL_CONCURRENCY=2
```

需要小范围开放注册且暂不配置邮件服务时，将
`SELF_USE_MODE_ENABLED` 设为 `false`，并把
`REGISTRATION_FIXED_VERIFICATION_CODE` 设为至少 8 位的随机值。注册页会显示邀请码输入框，
服务端继续校验邮箱域名、重复账号和封禁状态，但不会发送邮件。固定邀请码可重复使用，
应只提供给受邀用户并定期轮换；未验证邮箱所有权时，密码找回邮件也不可依赖。

环境文件必须只保存在服务器，并设置为 `0600`。三个 R2 桶应相互隔离：
头像桶会按公开内容处理，不能与需要签名访问的生成图共用。

## async 结果预算与内存边界

以下仅控制进程内 async 结果准入和留存，不改变图像 queue 的输入预算或执行并发：

```dotenv
ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES=536870912
ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER=268435456
ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY=268435456
```

这也是未配置时的新默认值，分别为全局 512 MiB、用户/Key 256 MiB。
旧环境文件若显式填写了 64/32/32 MiB，仍会覆盖新默认；升级时需核对实际传入 Web
进程的这三个值。`docker-compose.seoul.yml` 已通过 `env_file` 传入环境文件，
仅更新 `.env.example` 不会更新服务器配置。本次未修改生产环境或 Compose 资源限额。

普通图像完成任务只保留 generation/storage 引用，按最多 64 张成品的完整提示词预留约 12.1 MiB/生成，poll/callback
时才读取原图并编码；不会积存 30 分钟 b64。relayOnly 不保存内容到数据库或对象存储，
单图原始字节上界 32 MiB，每次生成最多 4 张候选。预留公式为
`n × (4 × ceil(32 MiB / 3) × 4 + 4 × (32000 × 6 + 4 KiB) + 129 KiB)`，另计任务元数据和 4 KiB 余量。每张提示词按 JSON 最坏转义字节计，内部重复副本不进入交付预算。
`n` 是 handler 拆出的生成次数，每次虽请求一张，上游 Web 等路径仍可能返回多候选；
4 是每次生成的保守候选上界，不能直接用请求 `n` 替代，因此总预留会随 `n` 相乘。

`n=1` 约需 171 MiB，默认可接一笔合法 relay async；同用户/Key 第二笔在飞时返回 429。
全局默认最多容纳两笔不同用户的此类在飞预留，已有留存还会占用容量。完成后按实际
任务 JSON 字节计账，小结果返还预留差额，但结果继续保留到完成后 TTL，不因投递成功删除。
relay async 的合法整数 `n>4` 在准入和付费前返回 413；`n=2..4` 仍需全量预留，
默认会因单笔自身超过用户/Key 256 MiB 而返回 413，并明确提示 `Reduce n`。
单笔完整预留自身超过任一 global/user/key 总预算时，等待不能改变结果，不能提示永远重试；
只有单笔本可放下、合计当前占用导致的暂时不足才返回 429。自定义更大预算需要独立评估。
任务数量默认仍为全局 256、每用户 16、每 Key 8，数量满时也会 429，独立于结果字节。

Seoul Compose 给 Web 的 `mem_limit` 为 1536 MiB，缩略图 tmpfs 上限 256 MiB 也可能
占用容器内存。512 MiB 是逻辑结果预算，不能理解为额外可用内存或安全并发承诺：
V8/Next 基线、队列输入、图片 Buffer、上游解析、JSON/HTTP 编码副本仍共同消耗资源。
上游 JSON/SSE 累计读取和并发 poll/callback 的瞬时编码预算尚未闭合，端到端 hard cap
仍为 partial。上线前需要在这套容器限额内测峰值 RSS、在飞 relay 与同时轮询/回调；
不能依据本地单测声称 Seoul 已完成容量验收，也不能自动放大 queue 预算。
若需下调结果预算但仍提供 relay async，三个预算均须能容纳至少一笔约 171 MiB 的完整预留。
relay 结果纯内存，重启不可恢复；保持现有完成 TTL，不增加内容持久化来绕过该边界。

## 启动与验证

```bash
docker compose -f docker-compose.seoul.yml pull
docker compose -f docker-compose.seoul.yml up -d
docker compose -f docker-compose.seoul.yml ps
docker compose -f docker-compose.seoul.yml logs migrate
```

Web 默认只绑定 `127.0.0.1:3310`，应通过 Cloudflare Tunnel 对外提供 HTTPS。
确认迁移退出码为 `0`、Web 健康后，再把公网流量切到新端口。
