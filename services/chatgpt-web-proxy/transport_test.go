package main

// 通过本机 CONNECT 隧道访问本机 TLS 服务，实际运行 fhttp/tls-client 传输与取消。
import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tls_client "github.com/bogdanfinn/tls-client"
)

// localTLSClient 仅测试时信任本机自签证书；全部目标经 CONNECT 固定送到本机，无外网。
func localTLSClient(t *testing.T, s *server, handler http.HandlerFunc) {
	t.Helper()
	localTLSClientProtocol(t, s, handler, false)
}

// localTLSClientProtocol 可启用真实 HTTP/2，覆盖 ChatGPT 常用的协商协议。
func localTLSClientProtocol(t *testing.T, s *server, handler http.HandlerFunc, http2 bool) {
	t.Helper()
	upstream := httptest.NewUnstartedServer(handler)
	upstream.EnableHTTP2 = http2
	upstream.StartTLS()
	t.Cleanup(upstream.Close)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT required", 405)
			return
		}
		back, err := net.Dial("tcp", upstream.Listener.Addr().String())
		if err != nil {
			http.Error(w, "dial failed", 502)
			return
		}
		front, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			back.Close()
			return
		}
		defer front.Close()
		defer back.Close()
		_, _ = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buf.Flush()
		go func() { _, _ = io.Copy(back, buf); back.Close() }()
		_, _ = io.Copy(front, back)
	}))
	t.Cleanup(proxy.Close)
	s.profileName = defaultProfile
	options, err := s.clientOptions()
	if err != nil {
		t.Fatal(err)
	}
	options = append(options, tls_client.WithInsecureSkipVerify(), tls_client.WithProxyDialerFactory(proxyDialerFactory(proxy.URL)))
	c, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.CloseIdleConnections)
	s.clients = map[string]*sessionClient{"default": {client: c, lastUsed: time.Now()}}
}

// proxyRequest 构造真实业务 envelope，密钥仅为固定测试值。
func proxyRequest(ctx context.Context) *http.Request {
	buf, _ := json.Marshal(requestPayload{TargetURL: "https://chatgpt.com/test", Headers: map[string]string{}})
	r := httptest.NewRequest(http.MethodPost, "/request", strings.NewReader(string(buf))).WithContext(ctx)
	r.Header.Set("X-Proxy-Secret", testSecret)
	return r
}

// TestCallerCancellationStopsTLSUpstream 同时检查 handler 返回与上游断连，覆盖读取响应正文阶段。
func TestCallerCancellationStopsTLSUpstream(t *testing.T) {
	started, stopped, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	s := &server{secret: testSecret, timeoutSecs: 3, maxBodyBytes: 1024}
	localTLSClient(t, s, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
			close(stopped)
		case <-release:
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.handleRequest(httptest.NewRecorder(), proxyRequest(ctx)) }()
	defer func() { close(release); <-done }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("TLS upstream did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("caller canceled but handler is still reading upstream")
	}
	select {
	case <-stopped:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("upstream connection did not stop after caller canceled")
	}
}

// TestCallerHTTPDisconnectStopsTLSUpstream 从真实入站 HTTP 断连验证 context 贯穿到 TLS 上游。
func TestCallerHTTPDisconnectStopsTLSUpstream(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024}
	localTLSClientProtocol(t, s, func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Errorf("expected real HTTP/2, got %s", r.Proto)
		}
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}, true)
	front := httptest.NewServer(s.httpServer("").Handler)
	defer front.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in := proxyRequest(ctx)
	r, _ := http.NewRequestWithContext(ctx, http.MethodPost, front.URL+"/request", in.Body)
	r.Header = in.Header
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, err := http.DefaultClient.Do(r)
		if err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("caller did not cancel")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("HTTP disconnect did not stop TLS upstream")
	}
}

// TestTLSRedirectReturnedWithoutFollowing 使用生产选项及真实 TLS 验证跨域/非443/HTTP 跳转均直接返回。
func TestTLSRedirectReturnedWithoutFollowing(t *testing.T) {
	for _, location := range []string{"https://evil.test/", "https://chatgpt.com:8443/", "http://127.0.0.1:1/", "https://chatgpt.com/next"} {
		t.Run(location, func(t *testing.T) {
			s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024}
			localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", location)
				w.WriteHeader(302)
			})
			w := httptest.NewRecorder()
			s.handleRequest(w, proxyRequest(context.Background()))
			var result responsePayload
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || result.Status != 302 || result.Headers["Location"][0] != location {
				t.Fatalf("redirect followed: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
