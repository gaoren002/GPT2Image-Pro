package main

// 多上游出口池：健康探测与故障转移。
//
// 背景：ChatGPT Web 车道经 WARP 等出口代理访问 chatgpt.com 时，Cloudflare 可能
// 突然拉黑某个出口 IP（2026-09-18 EOF 风暴：单出口 378 单生成超时）。本模块把
// 「单上游 URL」升级为「按优先级排序的上游池」：后台以真实 TLS 指纹周期探测
// 当前生效上游，连续 N 次失败后自动切到下一个健康上游，并回调 onSwitch 让
// 宿主 server 丢弃绑定旧出口的会话（session client 与 cf_clearance 都绑出口 IP）。
//
// 配置（环境变量，见 main.go）：
//   CHATGPT_WEB_UPSTREAM_POOL                     逗号分隔的上游 socks5 URL，按优先级
//   CHATGPT_WEB_UPSTREAM_PROXY_URL                旧单上游变量，等价于单项池（向后兼容）
//   CHATGPT_WEB_UPSTREAM_PROBE_URL                探测目标，默认 https://chatgpt.com/
//   CHATGPT_WEB_UPSTREAM_PROBE_INTERVAL_SECONDS   探测间隔，默认 60
//   CHATGPT_WEB_UPSTREAM_PROBE_FAILURES           切换阈值，默认 3
//
// 池为空时行为与旧版完全一致（不经代理直连）。

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const (
	defaultProbeURL        = "https://chatgpt.com/"
	defaultProbeInterval   = 60 * time.Second
	defaultProbeFailures   = 3
	minProbeInterval       = 10 * time.Second
	defaultProbeTimeoutSec = 15
)

type upstreamEntry struct {
	URL       string
	failures  int
	healthy   bool
	lastError string
	lastCheck time.Time
}

type upstreamPool struct {
	mu        sync.Mutex
	entries   []*upstreamEntry
	active    int
	failLimit int
	interval  time.Duration
	probeURL  string

	// probe 可注入以便测试；nil 时用真实 TLS 指纹探测。
	probe func(proxyURL string) error
	// onSwitch 在切换生效后回调（old/new 均为 URL，单项池或无池不会触发）。
	onSwitch func(oldURL, newURL string)
}

// parseUpstreamList 解析逗号分隔的上游列表：去空白、去非法项、去重，保持顺序。
func parseUpstreamList(raw string) []string {
	out := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func newUpstreamPool(urls []string, failLimit int, interval time.Duration, probeURL string) *upstreamPool {
	if failLimit <= 0 {
		failLimit = defaultProbeFailures
	}
	if interval < minProbeInterval {
		interval = defaultProbeInterval
	}
	probeURL = strings.TrimSpace(probeURL)
	if probeURL == "" {
		probeURL = defaultProbeURL
	}
	entries := make([]*upstreamEntry, 0, len(urls))
	for _, u := range urls {
		entries = append(entries, &upstreamEntry{URL: u, healthy: true})
	}
	return &upstreamPool{
		entries:   entries,
		active:    0,
		failLimit: failLimit,
		interval:  interval,
		probeURL:  probeURL,
	}
}

// ActiveURL 返回当前生效上游；空池返回 ""（直连）。
func (p *upstreamPool) ActiveURL() string {
	if p == nil {
		return ""
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) == 0 {
		return ""
	}
	return p.entries[p.active].URL
}

// Status 返回池内各上游状态（/healthz 用）；空池返回 nil，凭据已脱敏。
func (p *upstreamPool) Status() []map[string]any {
	if p == nil || len(p.entries) == 0 {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	activeURL := ""
	if len(p.entries) > 0 {
		activeURL = p.entries[p.active].URL
	}
	out := make([]map[string]any, 0, len(p.entries))
	for _, e := range p.entries {
		out = append(out, map[string]any{
			"url":       maskProxyCredential(e.URL),
			"active":    e.URL == activeURL,
			"healthy":   e.healthy,
			"failures":  e.failures,
			"lastError": e.lastError,
			"lastCheck": e.lastCheck.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// maskProxyCredential 脱敏上游 URL 中的口令，用于 /healthz 状态与日志。
// 解析失败时不回显原文：/healthz 不鉴权，而非法转义（如口令含 % 字面量）恰恰
// 会让 url.Parse 失败，原样返回等于把明文口令直接输出。
func maskProxyCredential(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		// 无法结构化解析：按 userinfo 分隔符做字符串级兜底，仍不输出口令。
		if at := strings.LastIndex(raw, "@"); at >= 0 {
			scheme := ""
			rest := raw[:at]
			if sep := strings.Index(rest, "://"); sep >= 0 {
				scheme = rest[:sep+3]
				rest = rest[sep+3:]
			}
			user := rest
			if colon := strings.Index(rest, ":"); colon >= 0 {
				user = rest[:colon]
			}
			return scheme + user + ":***@" + raw[at+1:]
		}
		return raw
	}
	if u.User == nil {
		return raw
	}
	// 手工拼串而非 u.String()：后者会把 *** 百分号编码成 %2A%2A%2A。
	masked := u.Scheme + "://" + u.User.Username() + ":***@" + u.Host + u.Path
	if u.RawQuery != "" {
		masked += "?" + u.RawQuery
	}
	return masked
}

func (p *upstreamPool) probeUpstream(proxyURL string) error {
	if p.probe != nil {
		return p.probe(proxyURL)
	}
	return probeViaProfile(defaultProfile, proxyURL, p.probeURL, defaultProbeTimeoutSec)
}

// probeResult 单个上游的探测结果，idx 为其在 entries 中的下标。
type probeResult struct {
	idx int
	err error
}

// checkOnce 执行一轮探测：逐个探测池内全部上游（active 与备胎，保持 /healthz
// 状态新鲜、切换时无需现探），active 连续 failLimit 次失败且存在健康备胎时切换。
// 返回是否发生了切换（供测试断言）。
// WHY onSwitch 必须在释放 p.mu 之后调用：回调会去拿 server.mu（重建会话 client），
// 而 getClient 持有 server.mu 时会调用 ActiveURL() 拿 p.mu。两条路径加锁顺序相反，
// 交错即永久死锁，/request 与 /healthz 全部挂起且不会自愈（出口被封时切换与新建
// 会话同时发生，正是最可能的时机）。
func (p *upstreamPool) checkOnce() bool {
	if p == nil || len(p.entries) == 0 {
		return false
	}

	// 锁外逐个探测（探测含网络 IO，不能持锁）。
	p.mu.Lock()
	indexes := make([]int, 0, len(p.entries))
	for i := range p.entries {
		indexes = append(indexes, i)
	}
	p.mu.Unlock()
	results := make([]probeResult, 0, len(indexes))
	for _, i := range indexes {
		results = append(results, probeResult{idx: i, err: p.probeUpstream(p.entries[i].URL)})
	}

	// 切换信息在锁内记录、锁外回调，避免与 server.mu 形成反向加锁顺序。
	var switchedFrom, switchedTo string
	switched := func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.applyProbeResults(results, &switchedFrom, &switchedTo)
	}()
	if switched && p.onSwitch != nil {
		p.onSwitch(switchedFrom, switchedTo)
	}
	return switched
}

// applyProbeResults 在持有 p.mu 的前提下写回探测结果并按阈值切换 active。
// 发生切换时把旧/新上游写入 switchedFrom/switchedTo，由调用方在锁外触发 onSwitch。
func (p *upstreamPool) applyProbeResults(
	results []probeResult,
	switchedFrom *string,
	switchedTo *string,
) bool {
	now := time.Now()
	for _, r := range results {
		e := p.entries[r.idx]
		e.lastCheck = now
		if r.err == nil {
			if !e.healthy || e.failures > 0 {
				log.Printf("[upstream-pool] %s recovered", maskProxyCredential(e.URL))
			}
			e.healthy = true
			e.failures = 0
			e.lastError = ""
			continue
		}
		e.healthy = false
		e.failures++
		e.lastError = r.err.Error()
		if e.URL == p.entries[p.active].URL {
			log.Printf("[upstream-pool] %s probe failed (%d/%d): %v",
				maskProxyCredential(e.URL), e.failures, p.failLimit, r.err)
		}
	}

	active := p.entries[p.active]
	if active.failures < p.failLimit || len(p.entries) < 2 {
		return false
	}
	// 阈值已到：按优先级找第一个健康备胎（本轮已探测过，直接取结果）。
	next := -1
	for i, e := range p.entries {
		if i != p.active && e.healthy {
			next = i
			break
		}
	}
	if next < 0 {
		log.Printf("[upstream-pool] all upstreams unhealthy, holding on %s",
			maskProxyCredential(active.URL))
		return false
	}
	oldURL := active.URL
	target := p.entries[next]
	p.active = next
	log.Printf("[upstream-pool] SWITCH %s -> %s",
		maskProxyCredential(oldURL), maskProxyCredential(target.URL))
	*switchedFrom = oldURL
	*switchedTo = target.URL
	return true
}

// Run 启动后台探测循环，直到 ctx 结束。池为空时不做任何事。
func (p *upstreamPool) Run(ctx context.Context) {
	if p == nil || len(p.entries) < 1 {
		return
	}
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.checkOnce()
		}
	}
}

// probeViaProfile 用与业务请求一致的 TLS 指经指定代理探测目标 URL：
// 拿到任意 HTTP 状态码（含 403 挑战页）即视为连通；传输层错误（EOF/RST/超时）
// 视为中毒。比外部 curl 探测更贴近真实业务路径。
func probeViaProfile(profileName, proxyURL, probeURL string, timeoutSecs int) error {
	profile, ok := profiles.MappedTLSClients[profileName]
	if !ok {
		return fmt.Errorf("unknown tls-client profile: %s", profileName)
	}
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(timeoutSecs),
		tls_client.WithClientProfile(profile),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithDisableHttp3(),
		tls_client.WithProxyDialerFactory(proxyDialerFactory(proxyURL)),
	}
	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()

	req, err := fhttp.NewRequest(fhttp.MethodGet, probeURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// 只关心底层的连通性：任意状态码（200/403/302…）都证明出口可用。
	_, _ = resp.Body.Read(make([]byte, 1))
	return nil
}
