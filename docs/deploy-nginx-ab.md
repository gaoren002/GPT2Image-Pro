# Nginx 蓝绿部署 Runbook

本文档记录本站当前线上部署方式,只适用于这套 **systemd release + standalone 自服务静态 + 3308/3307 蓝绿** 环境。普通部署不需要照此手动处理,按 README 生产部署即可。

> 静态资源【放在各自版本的 standalone 内自服务】(每版独立),不再走 `/var/www` Nginx 静态
> alias,也不再单独同步静态目录。带前缀的静态请求由 Nginx 代理到 pool,由当前版本的 app
> 从自己的 standalone 提供。

## 当前拓扑

- Nginx upstream:`gpt2image_pool` = `127.0.0.1:3308`(主)+ `127.0.0.1:3307`(备,`backup`)
- systemd 单元:`gpt2image-3308-nopending`(主)、`gpt2image-3307-agentparse`(备)
- 超分单元:`gpt2image-super-resolution-worker`(本机 `127.0.0.1:3310`，两个 Web 实例共享；
  单并发、ONNX 24 线程、`CPUQuota=2400%`，并以 `Nice=10` 让位于页面进程)
- 每单元 drop-in:`/etc/systemd/system/<unit>.service.d/20-agenttools.conf`(改 `WorkingDirectory`)
- 静态服务:Nginx `location ~ ^/(?<aprefix>gpt2-assets-[^/]+)/_next/static/(?<apath>.*)$`
  → `proxy_pass http://$gc_static_upstream/_next/static/$apath`;`map $aprefix $gc_static_upstream`
  默认 `gpt2image_pool`。即带前缀静态 → 代理到 pool → 当前版 app 从其 standalone 自服务。
- release 根目录:`/home/user1/gpt2image-releases/`
- 运行时 env:`/home/user1/gpt2image-shared/.env.local`(两单元 drop-in 的 `EnvironmentFile`
  指向此处,**与代码 release 解耦**,清理旧 release 不会误删 env;2026-06-30 从旧的
  `gpt2image-v0.5.6-.../apps/web/.env.local` 存根迁出)。注意这与构建用的仓库内
  `apps/web/.env.local` 是两个文件:仓库内那个只供 `next build` 读 `NEXT_PUBLIC_*`(如
  资产前缀),服务端运行时密钥/配置(DB、各 sidecar URL/SECRET 等)在此运行时 env。
- 单元以 **root** 运行(无 `User=`),故其写出的 `.next/cache` 归 root,清理旧 release 需 `sudo`。
- Node:`/home/user1/.nvm/versions/node/v24.15.0/bin`

## 部署原则

- 每次前端构建必须更换 `NEXT_PUBLIC_ASSET_PREFIX`,不复用旧前缀;写在 `apps/web/.env.local`
  (Next 构建实际读取的文件)。**构建前不要 `source` 该文件**,否则 shell 里残留的旧前缀会
  覆盖文件值、烤进一个过时前缀。
- 静态资源放进【各自 release 的 standalone】:构建后把 `apps/web/.next/static` 同步进
  `apps/web/.next/standalone/apps/web/.next/static`;`public/` 已由构建/tracing 带入 standalone。
  **不需要、也不要**再同步到 `/var/www` 或任何 Nginx alias 目录。
- 若本次含数据库 schema 变更:必须先执行并验证迁移,再切任何实例;不让新代码打到旧 schema、
  不让公网请求命中半更新实例。
- 蓝绿切换靠 Nginx failover,**部署不动 Nginx**:先切备(3307)、验证健康,再切主(3308);
  3308 drain 期间公网自动 failover 到 3307(已是新版)。
- release 不能复制 `storage`(会把用户生成图拷进 release,膨胀到几十 GB)。
- release 不能排除 `apps/web/.next/standalone/node_modules`,否则 standalone 启动报
  `Cannot find module 'next'`(全局 `--exclude=node_modules` 后必须单独补全 standalone)。
- systemd 有 drop-in 覆盖,必须改 drop-in,不要只看主 unit。
- 在途旧会话权衡:两端都切到新版后,仍持旧 HTML(旧前缀)的在途用户,其带 build-id 的
  chunk 会被代理到新版 app 而 404,刷新即恢复。这是"两端同切 + 每版自服务"的固有瞬态;
  唯一前缀保证新访客始终拿新前缀→新版 app,不受影响。

## 上线前检查:是否需要迁移

```bash
git diff --name-only HEAD~1..HEAD | rg 'packages/database|drizzle|schema|migrations'
```

有 schema/migration 变更则先迁移:

```bash
PATH=/home/user1/.nvm/versions/node/v24.15.0/bin:$PATH pnpm --filter @repo/database db:migrate
```

迁移后做一次只读校验(确认关键表字段存在),失败则停止部署、不要构建切服务。

## 标准部署流程

均在仓库根 `/home/user1/GPT2Image-Pro` 执行。

### 1. 确认工作区与提交

```bash
git status --short
git log --oneline -1
```

有代码改动先测试并提交。

### 2. 更新资产前缀(唯一值)

把 `apps/web/.env.local` 的 `NEXT_PUBLIC_ASSET_PREFIX` 改为唯一值并验证(只看该行,勿打印整文件):

```bash
sed -i 's|^NEXT_PUBLIC_ASSET_PREFIX=.*|NEXT_PUBLIC_ASSET_PREFIX="/gpt2-assets-vYYYYMMDD-brief-<commit>-HHMMSS"|' apps/web/.env.local
grep -n '^NEXT_PUBLIC_ASSET_PREFIX' apps/web/.env.local
```

### 3. 构建(勿 source .env.local)

```bash
rm -f apps/web/.next/lock
PATH=/home/user1/.nvm/versions/node/v24.15.0/bin:$PATH pnpm --filter @repo/web build
```

构建完成(出现路由表 + standalone/required-server-files 落地)后验证前缀已烤入:

```bash
grep -aoE '"assetPrefix": "[^"]*"' apps/web/.next/required-server-files.json
```

### 4. 静态同步进 standalone(自服务关键)

```bash
mkdir -p apps/web/.next/standalone/apps/web/.next/static
rsync -a --delete apps/web/.next/static/ apps/web/.next/standalone/apps/web/.next/static/
```

### 5. 创建 release

```bash
release=/home/user1/gpt2image-releases/gpt2image-brief-<commit>-YYYYMMDD-HHMMSS
mkdir -p "$release"
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.turbo' \
  --exclude='storage' --exclude='apps/web/.next/cache' \
  /home/user1/GPT2Image-Pro/ "$release"
# 全局排除 node_modules 会波及 standalone,必须补全
rsync -a --delete \
  /home/user1/GPT2Image-Pro/apps/web/.next/standalone/ \
  "$release/apps/web/.next/standalone/"
```

验证(几百 MB 量级;next 包、server.js、烤入前缀、standalone static、public、.so 在位):

```bash
du -sh "$release"
ls "$release/apps/web/.next/standalone/node_modules/.pnpm/" | rg '^next@' | head -1
test -e "$release/apps/web/.next/standalone/apps/web/server.js" && echo server.js-ok
test -d "$release/apps/web/.next/standalone/apps/web/public" && echo public-ok
test -e "$release/apps/web/.next/standalone/node_modules/onnxruntime-node" && echo worker-onnx-ok
test -e "$release/apps/web/.next/standalone/node_modules/sharp" && echo worker-sharp-ok
grep -aoE '"assetPrefix": "[^"]*"' "$release/apps/web/.next/standalone/apps/web/.next/required-server-files.json"
```

### 6. 改 Web 与超分 Worker 的 WorkingDirectory

两个单元都要改(先备份当前态供回滚),然后 `daemon-reload`:

```bash
NEWWD="$release/apps/web/.next/standalone/apps/web"
for u in gpt2image-3308-nopending gpt2image-3307-agentparse; do
  conf="/etc/systemd/system/$u.service.d/20-agenttools.conf"
  sudo cp "$conf" "$conf.bak-brief"
  sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$NEWWD|" "$conf"
  grep '^WorkingDirectory=' "$conf"
done
sudo systemctl daemon-reload
```

首次部署 Worker 时，以仓库模板创建单元；后续版本只更新它的 drop-in：

```bash
# 首次部署参考 deploy/systemd/gpt2image-super-resolution-worker.service.example 创建主 unit。
sudo mkdir -p /etc/systemd/system/gpt2image-super-resolution-worker.service.d
sudo tee /etc/systemd/system/gpt2image-super-resolution-worker.service.d/20-release.conf >/dev/null <<EOF
[Service]
WorkingDirectory=$NEWWD
EnvironmentFile=
EnvironmentFile=/home/user1/gpt2image-shared/.env.local
ExecStart=
ExecStart=/home/user1/.nvm/versions/node/v24.15.0/bin/node worker/super-resolution-worker.mjs
EOF
sudo systemctl daemon-reload
```

后续发布与两个 Web drop-in 同时替换 Worker 目录：

```bash
wconf=/etc/systemd/system/gpt2image-super-resolution-worker.service.d/20-release.conf
sudo cp "$wconf" "$wconf.bak-brief"
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$NEWWD|" "$wconf"
sudo systemctl daemon-reload
```

### 7. 先切超分 Worker，再切备(3307)

Worker 协议保持向后兼容，先切它不会影响仍运行旧代码的 Web：

```bash
sudo systemctl restart gpt2image-super-resolution-worker
systemctl is-active gpt2image-super-resolution-worker
curl -fsS http://127.0.0.1:3310/healthz
```

然后切备：

```bash
old=$(systemctl show gpt2image-3307-agentparse -p MainPID --value)
sudo systemctl restart gpt2image-3307-agentparse
# 轮询直到 MainPID 变更 + active + /zh=200(必须看 MainPID 变更,而非仅 active+200,
# 否则会把正在 drain 的旧进程误判为已就绪)
sleep 4; systemctl show gpt2image-3307-agentparse -p MainPID -p ActiveState
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3307/zh
curl -s http://127.0.0.1:3307/zh | grep -o 'gpt2-assets-[^"<> ]*' | head -1   # 应为新前缀
```

公网此时仍在 3308(旧版),不受影响。

### 8. 再切主(3308),验证

```bash
old=$(systemctl show gpt2image-3308-nopending -p MainPID --value)
sudo systemctl restart gpt2image-3308-nopending   # drain 可达 TimeoutStopSec(~90s),期间 failover 到 3307
# 同样轮询 MainPID 变更 + active + /zh=200 + 新前缀
curl -s http://127.0.0.1:3308/zh | grep -o 'gpt2-assets-[^"<> ]*' | head -1
```

### 9. 端到端验证(经 Nginx)

```bash
dom=<public-domain>; res="--resolve $dom:443:127.0.0.1"
curl -s -k -o /dev/null -w 'page %{http_code}\n' $res "https://$dom/zh"
# 带前缀静态自服务应 200
chunk=$(find apps/web/.next/standalone/apps/web/.next/static/chunks -name '*.js' | head -1 | sed 's|.*/static/||')
curl -s -k -o /dev/null -w 'static %{http_code}\n' $res "https://$dom/<asset-prefix>/_next/static/$chunk"
# 两单元无启动/崩溃错误
for u in gpt2image-3308-nopending gpt2image-3307-agentparse; do
  sudo journalctl -u $u --since '2 min ago' --no-pager | rg -i 'cannot find module|EADDRINUSE|uncaughtException|SyntaxError' || echo "$u clean"
done
```

## 回滚

把两个 drop-in 改回上一个 release 并重启(上一版 release 目录保留即可秒回滚):

```bash
prev=/home/user1/gpt2image-releases/<上一版目录>
for u in gpt2image-3308-nopending gpt2image-3307-agentparse; do
  conf="/etc/systemd/system/$u.service.d/20-agenttools.conf"
  sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$prev/apps/web/.next/standalone/apps/web|" "$conf"
done
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$prev/apps/web/.next/standalone/apps/web|" \
  /etc/systemd/system/gpt2image-super-resolution-worker.service.d/20-release.conf
sudo systemctl daemon-reload
sudo systemctl restart gpt2image-super-resolution-worker
sudo systemctl restart gpt2image-3307-agentparse
sudo systemctl restart gpt2image-3308-nopending
```

回滚后页面重新引用旧前缀;旧版 app 起来即从其 standalone 自服务旧静态,无需额外处理。

## 事故记录:2026-05-31 `Failed query`

部署窗口内出现 71 次外接 API 失败(`/v1/images/edits` 59、`/v1/images/generations` 11、
`/v1/chat/completions` 1),错误形态 `Failed query: select ... from "image_backend_api" ...`,
同窗口存在重启/SIGKILL。结论:请求命中半更新/重启中的实例,或代码与 DB schema 短暂不一致。
故必须先迁移并验证 DB,再先备后主切实例。

## 常见故障

### 页面还是旧前缀

```bash
curl -s http://127.0.0.1:3308/zh | rg -o '/gpt2-assets-[^"<> ]+' | head
systemctl cat gpt2image-3308-nopending.service   # 核对 drop-in WorkingDirectory
```

### `Cannot find module 'next'`

release 的 standalone `node_modules` 缺失,重新补全后重启:

```bash
rsync -a --delete \
  /home/user1/GPT2Image-Pro/apps/web/.next/standalone/ \
  "$release/apps/web/.next/standalone/"
sudo systemctl restart gpt2image-3308-nopending.service
```

### ChunkLoadError / 样式丢失

确认静态在【standalone】内(不是 /var/www),并抽查:

```bash
find "$release/apps/web/.next/standalone/apps/web/.next/static" -type f | head
curl -k -I "https://<public-domain>/<asset-prefix>/_next/static/chunks/<chunk>.js"
```

### release 目录异常巨大

通常误复制了 `storage`。不要上线,删除/隔离后按标准命令重建。
