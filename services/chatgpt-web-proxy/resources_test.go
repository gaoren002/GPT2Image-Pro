package main

// 资源预算与真实监听器回归，不使用生产配置、凭据或网络。
import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestRequestCapacityRejectsBeforeBody 保证响应预算与并发两种约束独立生效、错误路径释放。
func TestRequestCapacityRejectsBeforeBody(t *testing.T) {
	for _, byBudget := range []bool{false, true} {
		t.Run(fmt.Sprint(byBudget), func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			s := &server{secret: testSecret, timeoutSecs: 3, maxBodyBytes: 1024, maxConcurrent: 1, maxInflightBodyBytes: 4096}
			if byBudget {
				s.maxConcurrent, s.maxInflightBodyBytes = 2, 1024
			}
			localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) {
				close(started)
				<-release
				_, _ = io.WriteString(w, "ok")
			})
			done := make(chan struct{})
			go func() { defer close(done); s.handleRequest(httptest.NewRecorder(), proxyRequest(context.Background())) }()
			defer func() { close(release); <-done }()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("upstream not started")
			}
			w := httptest.NewRecorder()
			s.handleRequest(w, proxyRequest(context.Background()))
			if w.Code != 429 || w.Header().Get("Retry-After") != "1" {
				t.Fatalf("capacity not enforced: %d", w.Code)
			}
			w = httptest.NewRecorder()
			s.handleHealth(w, httptest.NewRequest("GET", "/healthz", nil))
			if w.Code != 200 {
				t.Fatalf("health blocked at capacity: %d", w.Code)
			}
		})
	}
	s := &server{secret: testSecret, maxBodyBytes: 1024}
	r := httptest.NewRequest("POST", "/request", strings.NewReader("{"))
	r.Header.Set("X-Proxy-Secret", testSecret)
	s.handleRequest(httptest.NewRecorder(), r)
	if s.activeRequests != 0 || s.inflightBodyBytes != 0 {
		t.Fatal("parse error leaked reservation")
	}
}

// TestTLSResponseBodyLimit 检查真实 TLS 的定长及分块响应在边界/越界时的行为。
func TestTLSResponseBodyLimit(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		for _, size := range []int{1024, 1025} {
			t.Run(fmt.Sprintf("chunked=%v/size=%d", chunked, size), func(t *testing.T) {
				s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024}
				localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) {
					if chunked {
						w.(http.Flusher).Flush()
					} else {
						w.Header().Set("Content-Length", fmt.Sprint(size))
					}
					_, _ = io.WriteString(w, strings.Repeat("x", size))
				})
				w := httptest.NewRecorder()
				s.handleRequest(w, proxyRequest(context.Background()))
				want := 200
				if size > 1024 {
					want = 502
				}
				if w.Code != want {
					t.Fatalf("got %d want %d: %s", w.Code, want, w.Body.String())
				}
				if size == 1024 {
					var result responsePayload
					if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
						t.Fatal(err)
					}
					body, err := base64.StdEncoding.DecodeString(result.BodyBase64)
					if err != nil || len(body) != size {
						t.Fatal("response body changed")
					}
				}
				if s.activeRequests != 0 || s.inflightBodyBytes != 0 {
					t.Fatal("response leaked reservation")
				}
			})
		}
	}
}

// TestProxyDeadlineStopsTLSBeforeHeaders 覆盖上游迟迟不返回头的总时限及连接取消。
func TestProxyDeadlineStopsTLSBeforeHeaders(t *testing.T) {
	stopped := make(chan struct{})
	s := &server{secret: testSecret, timeoutSecs: 1, maxBodyBytes: 1024}
	localTLSClient(t, s, func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done(); close(stopped) })
	w := httptest.NewRecorder()
	s.handleRequest(w, proxyRequest(context.Background()))
	if w.Code != 504 {
		t.Fatalf("got %d want deadline 504", w.Code)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("deadline left upstream running")
	}
	if s.activeRequests != 0 {
		t.Fatal("deadline leaked reservation")
	}
}

// TestSessionCacheDoesNotEvictBusyClients 验证缓存有界，使用中的会话保持，空闲会话可淘汰。
func TestSessionCacheDoesNotEvictBusyClients(t *testing.T) {
	s := &server{profileName: defaultProfile, timeoutSecs: 1, maxSessions: 1}
	defer s.resetSessionClients()
	c, err := s.getClient("one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.getClient("two"); err == nil {
		t.Fatal("evicted active session")
	}
	s.releaseClient("one", c)
	if _, err := s.getClient("two"); err != nil {
		t.Fatal(err)
	}
	if len(s.clients) != 1 || s.clients["one"] != nil {
		t.Fatal("idle session was not evicted")
	}
}

// TestSessionCreationAndPoolSwitchConcurrent 保持 PX01 锁顺序保证，同时运行真实 client 创建和切换。
func TestSessionCreationAndPoolSwitchConcurrent(t *testing.T) {
	p := newUpstreamPool([]string{"socks5://a:1080", "socks5://b:1080"}, 1, time.Minute, defaultProbeURL)
	s := &server{profileName: defaultProfile, timeoutSecs: 1, pool: p}
	p.probe = func(raw string) error {
		if raw == p.ActiveURL() {
			return errors.New("local-test-failure")
		}
		return nil
	}
	p.onSwitch = func(_, _ string) { s.resetSessionClients() }
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			p.checkOnce()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			c, err := s.getClient("session")
			if err == nil {
				s.releaseClient("session", c)
			}
		}
	}()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		s.resetSessionClients()
	case <-time.After(3 * time.Second):
		t.Fatal("pool/session lock inversion")
	}
}

// TestHTTPServerTimeouts 用缩短的相同配置验证真实 TCP 慢头、慢正文与 idle 连接都会结束。
func TestHTTPServerTimeouts(t *testing.T) {
	s := &server{secret: testSecret, timeoutSecs: 2}
	h := s.httpServer("127.0.0.1:0")
	if h.ReadHeaderTimeout != 5*time.Second || h.ReadTimeout != 30*time.Second || h.IdleTimeout != 60*time.Second || h.WriteTimeout != 42*time.Second || h.MaxHeaderBytes != 32*1024 {
		t.Fatal("HTTP deadline configuration regressed")
	}
	h.ReadHeaderTimeout, h.ReadTimeout, h.IdleTimeout = 100*time.Millisecond, 200*time.Millisecond, 100*time.Millisecond
	listener, err := net.Listen("tcp", h.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = h.Serve(listener) }()
	defer h.Close()
	for _, mode := range []string{"header", "body", "idle"} {
		t.Run(mode, func(t *testing.T) {
			c, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(time.Second))
			switch mode {
			case "header":
				_, _ = io.WriteString(c, "POST /request HTTP/1.1\r\nHost: localhost\r\nX-Slow: ")
			case "body":
				_, _ = fmt.Fprintf(c, "POST /request HTTP/1.1\r\nHost: localhost\r\nX-Proxy-Secret: %s\r\nContent-Length: 100\r\n\r\n{", testSecret)
			case "idle":
				_, _ = io.WriteString(c, "GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
				resp, err := http.ReadResponse(bufio.NewReader(c), nil)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
			_, err = io.ReadAll(c)
			if e, ok := err.(net.Error); ok && e.Timeout() {
				t.Fatal("connection survived configured timeout")
			}
		})
	}
}

// TestConfigureLimitsRejectsUnsafeValues 覆盖溢出、拼错、过大配置与不可能满足的预算。
func TestConfigureLimitsRejectsUnsafeValues(t *testing.T) {
	for _, c := range []struct{ key, value string }{
		{"CHATGPT_WEB_PROXY_MAX_BODY_MB", "9999999999999999999"}, {"CHATGPT_WEB_PROXY_MAX_BODY_MB", "65"},
		{"CHATGPT_WEB_PROXY_MAX_CONCURRENT", "0"}, {"CHATGPT_WEB_PROXY_TIMEOUT_SECONDS", "typo"},
		{"CHATGPT_WEB_PROXY_MAX_SESSIONS", "257"}, {"CHATGPT_WEB_PROXY_MAX_INFLIGHT_BODY_MB", "1"},
	} {
		t.Run(c.key+c.value, func(t *testing.T) {
			t.Setenv(c.key, c.value)
			if (&server{}).configureLimits() == nil {
				t.Fatal("accepted invalid resource configuration")
			}
		})
	}
}

// pausedWriter 模拟下游缓慢读取；发送完成前预算不能返还给后续请求。
type pausedWriter struct {
	headers          http.Header
	started, release chan struct{}
	once             sync.Once
}

func (w *pausedWriter) Header() http.Header { return w.headers }
func (w *pausedWriter) WriteHeader(_ int)   {}
func (w *pausedWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.release
	return len(p), nil
}

// TestReservationHeldUntilResponseWrite 覆盖 forward 完成后仍占内存的下游发送阶段。
func TestReservationHeldUntilResponseWrite(t *testing.T) {
	s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024, maxConcurrent: 1}
	localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	w := &pausedWriter{headers: http.Header{}, started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { defer close(done); s.handleRequest(w, proxyRequest(context.Background())) }()
	defer func() { close(w.release); <-done }()
	select {
	case <-w.started:
	case <-time.After(time.Second):
		t.Fatal("response did not reach downstream")
	}
	rejected := httptest.NewRecorder()
	s.handleRequest(rejected, proxyRequest(context.Background()))
	if rejected.Code != 429 {
		t.Fatal("response budget released before downstream write completed")
	}
}
