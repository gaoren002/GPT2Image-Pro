package main

// 会话 client 的连接与缓存上限；锁仍沿用 server.mu，池切换回调必须继续在池锁外运行。
import (
	"fmt"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// clientOptions 供业务会话统一构建真实 TLS client；任何响应跳转都由调用方显式处理。
func (s *server) clientOptions() ([]tls_client.HttpClientOption, error) {
	profile, ok := profiles.MappedTLSClients[s.profileName]
	if !ok {
		return nil, fmt.Errorf("unknown tls-client profile: %s", s.profileName)
	}
	idle := 90 * time.Second
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(s.timeoutSecs), tls_client.WithClientProfile(profile),
		tls_client.WithCookieJar(tls_client.NewCookieJar()), tls_client.WithDisableHttp3(),
		tls_client.WithCatchPanics(), tls_client.WithNotFollowRedirects(),
		tls_client.WithProxyDialerFactory(proxyDialerFactory(s.pool.ActiveURL())),
		tls_client.WithTransportOptions(&tls_client.TransportOptions{
			IdleConnTimeout: &idle, MaxIdleConns: 2, MaxIdleConnsPerHost: 2,
			MaxConnsPerHost: 2, MaxResponseHeaderBytes: 32 * 1024,
		}),
	}
	return options, nil
}

// controlledClient 避免 tls-client 在普通初始化锁上阻塞同会话的取消请求。
// gate 只覆盖 Do 的同步阶段；响应正文仍按各自 context 读取，不串行整个响应生命周期。
type controlledClient struct {
	tls_client.HttpClient
	gate         chan struct{}
	mu           sync.Mutex
	closePending bool
}

// controlClient 为缓存里的真实 client 加一次 gate；不启动任何后台请求或清理 goroutine。
func controlClient(client tls_client.HttpClient) tls_client.HttpClient {
	if _, ok := client.(*controlledClient); ok {
		return client
	}
	return &controlledClient{HttpClient: client, gate: make(chan struct{}, 1)}
}

// Do 取消等待会直接返回，拥有 gate 的调用仍同步运行到真实传输退出。
func (c *controlledClient) Do(req *fhttp.Request) (*fhttp.Response, error) {
	select {
	case c.gate <- struct{}{}:
	case <-req.Context().Done():
		return nil, req.Context().Err()
	}
	defer c.finish()
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	return c.HttpClient.Do(req)
}

// CloseIdleConnections 在初始化正忙时仅标记清理，原 Do 的 defer 会在同一 goroutine 完成清理。
// 不在切换回调里等待依赖初始化锁，也不以后台遗弃任务换取表面上的立即取消。
func (c *controlledClient) CloseIdleConnections() {
	c.mu.Lock()
	c.closePending = true
	select {
	case c.gate <- struct{}{}:
		c.mu.Unlock()
		c.finish()
	default:
		c.mu.Unlock()
	}
}

// finish 在拥有 gate 时调用；归还 gate 与读取待清理标志在同一锁内，避免迟到标记丢失。
// 状态锁不跨越底层 client 清理；若清理期间再次置位，同一 goroutine 再处理一轮。
func (c *controlledClient) finish() {
	for {
		c.mu.Lock()
		if !c.closePending {
			<-c.gate
			c.mu.Unlock()
			return
		}
		c.closePending = false
		c.mu.Unlock()
		c.HttpClient.CloseIdleConnections()
	}
}

// normalizeSessionKey 为未传键的旧调用保留同一默认会话。
func normalizeSessionKey(key string) string {
	if key = strings.TrimSpace(key); key == "" {
		return "default"
	}
	return key
}

// releaseClient 在最后一个请求结束时更新时间；已被出口切换移除的 client 只关闭空闲连接。
func (s *server) releaseClient(sessionKey string, client tls_client.HttpClient) {
	s.mu.Lock()
	entry := s.clients[normalizeSessionKey(sessionKey)]
	if entry == nil || entry.client != client {
		s.mu.Unlock()
		client.CloseIdleConnections()
		return
	}
	entry.inflight--
	entry.lastUsed = time.Now()
	s.mu.Unlock()
}
