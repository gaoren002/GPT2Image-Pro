package main

// 独立复核用例，仅在证据目录的冻结副本运行；网络限定本机。
import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func reviewCounters(s *server) (int, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeRequests, s.inflightBodyBytes
}

// 使用真实生产 clientOptions/getClient，代理只接收握手后停住，不接触供应商。
func TestIndependentProxyHandshakeCancellation(t *testing.T) {
	for _, scheme := range []string{"socks5", "http"} {
		for _, mode := range []string{"cancel", "deadline"} {
			t.Run(scheme+"/"+mode, func(t *testing.T) {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				arrived := make(chan net.Conn, 1)
				go func() {
					c, err := listener.Accept()
					if err != nil {
						return
					}
					if scheme == "http" {
						_, err = http.ReadRequest(bufio.NewReader(c))
					} else {
						var greeting [3]byte
						_, err = io.ReadFull(c, greeting[:])
					}
					if err != nil {
						c.Close()
						return
					}
					arrived <- c
				}()
				timeout := 3
				if mode == "deadline" {
					timeout = 1
				}
				s := &server{secret: testSecret, profileName: defaultProfile,
					timeoutSecs: timeout, maxBodyBytes: 1024, maxConcurrent: 1,
					pool: newUpstreamPool([]string{scheme + "://" + listener.Addr().String()}, 1, time.Minute, defaultProbeURL)}
				defer s.resetSessionClients()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan struct{})
				w := httptest.NewRecorder()
				start := time.Now()
				go func() { defer close(done); s.handleRequest(w, proxyRequest(ctx)) }()
				var stalled net.Conn
				select {
				case stalled = <-arrived:
				case <-time.After(2 * time.Second):
					t.Fatal("local proxy handshake not reached")
				}
				if mode == "cancel" {
					cancel()
				}
				observe := 250 * time.Millisecond
				if mode == "deadline" {
					observe = 1500 * time.Millisecond
				}
				select {
				case <-done:
					t.Logf("handler stopped after %v, status=%d", time.Since(start), w.Code)
				case <-time.After(observe):
					n, b := reviewCounters(s)
					t.Errorf("handler survived %s during %s handshake: elapsed=%v active=%d bytes=%d", mode, scheme, time.Since(start), n, b)
				}
				stalled.Close() // 显式关闭本机代理连接，防止复现失败留下后台任务。
				select {
				case <-done:
				case <-time.After(4 * time.Second):
					t.Fatal("handler did not stop after local connection close")
				}
				if n, b := reviewCounters(s); n != 0 || b != 0 {
					t.Fatalf("cleanup leaked %d/%d", n, b)
				}
			})
		}
	}
}

type reviewOneListener struct {
	conn   net.Conn
	once   sync.Once
	closed chan struct{}
}

func (l *reviewOneListener) Accept() (net.Conn, error) {
	var c net.Conn
	l.once.Do(func() { c = l.conn })
	if c != nil {
		return c, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *reviewOneListener) Close() error {
	select {
	case <-l.closed:
	default:
		close(l.closed)
	}
	return nil
}
func (l *reviewOneListener) Addr() net.Addr { return l.conn.LocalAddr() }

type reviewObservedConn struct {
	net.Conn
	writing chan struct{}
	once    sync.Once
}

func (c *reviewObservedConn) Write(b []byte) (int, error) {
	c.once.Do(func() { close(c.writing) })
	return c.Conn.Write(b)
}

// 真实 net/http 输出缓冲 + net.Pipe 慢读者；检查最后 Flush 阻塞时 permit 仍归属请求。
func TestIndependentPermitThroughHTTPFlush(t *testing.T) {
	s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024, maxConcurrent: 1}
	localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	front, back := net.Pipe()
	defer front.Close()
	conn := &reviewObservedConn{Conn: back, writing: make(chan struct{})}
	listener := &reviewOneListener{conn: conn, closed: make(chan struct{})}
	h := s.httpServer("")
	closed := make(chan struct{})
	h.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			close(closed)
		}
	}
	go func() { _ = h.Serve(listener) }()
	defer h.Close()
	body := `{"targetUrl":"https://chatgpt.com/test"}`
	_, err := fmt.Fprintf(front, "POST /request HTTP/1.1\r\nHost: localhost\r\nX-Proxy-Secret: %s\r\nContent-Length: %d\r\n\r\n%s", testSecret, len(body), body)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-conn.writing:
	case <-time.After(2 * time.Second):
		t.Fatal("response did not reach actual network write")
	}
	n, b := reviewCounters(s)
	t.Logf("client has read zero response bytes; net.Conn.Write blocked; active=%d bytes=%d", n, b)
	if n != 1 || b != 1024 {
		t.Errorf("permit released before final HTTP flush: %d/%d", n, b)
	}
	if s.acquireRequest() {
		s.releaseRequest()
		t.Error("new request accepted while previous response flush is blocked")
	}
	front.Close()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("slow-client disconnect did not finish connection")
	}
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("disconnect cleanup leaked %d/%d", n, b)
	}
}

// 编排切换发生在 solver 已取到旧出口、尚未返回时，覆盖正/负缓存的迟到写入。
func TestIndependentClearanceSwitchGeneration(t *testing.T) {
	for _, success := range []bool{true, false} {
		t.Run(fmt.Sprint(success), func(t *testing.T) {
			resetClearance()
			defer resetClearance()
			started, release := make(chan struct{}), make(chan struct{})
			var count atomic.Int32
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				call := count.Add(1)
				var payload struct {
					Proxy struct {
						URL string `json:"url"`
					} `json:"proxy"`
				}
				_ = json.NewDecoder(r.Body).Decode(&payload)
				if call == 1 {
					if payload.Proxy.URL != "socks5://old:1080" {
						t.Errorf("first solve proxy=%s", payload.Proxy.URL)
					}
					close(started)
					<-release
					if !success {
						w.WriteHeader(500)
						return
					}
					_, _ = io.WriteString(w, `{"status":"ok","solution":{"userAgent":"Chrome/146.0.0.0 OLD","cookies":[{"name":"cf_clearance","value":"old-exit-cookie"}]}}`)
					return
				}
				_, _ = io.WriteString(w, `{"status":"ok","solution":{"userAgent":"Chrome/146.0.0.0 NEW","cookies":[{"name":"cf_clearance","value":"new-exit-cookie"}]}}`)
			}))
			defer h.Close()
			p := newUpstreamPool([]string{"socks5://old:1080", "socks5://new:1080"}, 1, time.Minute, defaultProbeURL)
			s := &server{pool: p, flareSolverrURL: h.URL, clearanceTimeout: 1, clearanceRefresh: 3600}
			p.probe = func(raw string) error {
				if strings.Contains(raw, "old") {
					return fmt.Errorf("local failure")
				}
				return nil
			}
			p.onSwitch = func(_, _ string) { s.resetSessionClients(); resetClearance() }
			done := make(chan struct{})
			go func() { defer close(done); s.refreshClearance(context.Background()) }()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("solver did not start")
			}
			if !p.checkOnce() {
				t.Error("expected pool switch")
			}
			close(release)
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("solver did not finish")
			}
			ua, _ := getActiveClearance()
			clrMu.Lock()
			negative := time.Now().Before(clrRetryAfter)
			clrMu.Unlock()
			t.Logf("after switch and late solver: ua=%q negative=%v calls=%d", ua, negative, count.Load())
			if ua != "" || negative {
				t.Error("old generation repopulated cache after switch reset")
			}
			ua, _ = s.refreshClearance(context.Background())
			if !strings.Contains(ua, "NEW") || count.Load() != 2 {
				t.Errorf("new exit did not refresh: ua=%q calls=%d", ua, count.Load())
			}
		})
	}
}

// 跨 HTTP/1.1 与 HTTP/2 检查实际发出的 authority、敏感头过滤和业务凭据兼容。
func TestIndependentHeadersOnWire(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(fmt.Sprint(h2), func(t *testing.T) {
			observed := make(chan *http.Request, 1)
			s := &server{timeoutSecs: 2, maxBodyBytes: 1024}
			localTLSClientProtocol(t, s, func(w http.ResponseWriter, r *http.Request) {
				observed <- r.Clone(context.Background())
				_, _ = io.WriteString(w, "ok")
			}, h2)
			result, err := s.forward(context.Background(), requestPayload{
				TargetURL:   "https://chatgpt.com:443/test",
				Headers:     map[string]string{" Host ": "evil.test:123", " x-pRoXy-SeCrEt ": "local-test-filter", " PROXY-AUTHORIZATION ": "Basic local-test-filter", "Authorization": "Bearer local-test-business", "Cookie": "business=test"},
				HeaderOrder: []string{"host", "x-proxy-secret", "proxy-authorization", "authorization", "cookie"},
			})
			if err != nil || result.Status != 200 {
				t.Fatalf("forward failed: %v", err)
			}
			r := <-observed
			if r.Host != "chatgpt.com:443" {
				t.Fatalf("wire authority changed: %q", r.Host)
			}
			if r.Header.Get("X-Proxy-Secret") != "" || r.Header.Get("Proxy-Authorization") != "" {
				t.Fatal("sidecar/proxy credential escaped")
			}
			if r.Header.Get("Authorization") != "Bearer local-test-business" || r.Header.Get("Cookie") != "business=test" {
				t.Fatal("business credentials lost")
			}
			if h2 && r.ProtoMajor != 2 {
				t.Fatalf("HTTP/2 not exercised: %s", r.Proto)
			}
		})
	}
}

// solver 等待、刷新和 retry 必须用同一个一秒总时限，而非每次重新起计。
func TestIndependentRetrySharesDeadline(t *testing.T) {
	resetClearance()
	defer resetClearance()
	var attempts atomic.Int32
	stopped := make(chan struct{})
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-time.After(350 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, `{"status":"ok","solution":{"userAgent":"Chrome/146.0.0.0","cookies":[{"name":"cf_clearance","value":"local-only"}]}}`)
	}))
	defer h.Close()
	s := &server{secret: testSecret, timeoutSecs: 1, maxBodyBytes: 1024, maxConcurrent: 1,
		clearanceEnabled: true, flareSolverrURL: h.URL, clearanceTimeout: 1, clearanceRefresh: 60}
	localTLSClient(t, s, func(w http.ResponseWriter, r *http.Request) {
		attempt := attempts.Add(1)
		if attempt == 1 {
			select {
			case <-time.After(350 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
			w.WriteHeader(403)
			_, _ = io.WriteString(w, "just a moment")
			return
		}
		<-r.Context().Done()
		close(stopped)
	})
	w := httptest.NewRecorder()
	start := time.Now()
	s.handleRequest(w, proxyRequest(context.Background()))
	elapsed := time.Since(start)
	if w.Code != 504 || elapsed > 1400*time.Millisecond || attempts.Load() != 2 {
		t.Fatalf("deadline reset: elapsed=%v status=%d attempts=%d", elapsed, w.Code, attempts.Load())
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("retry did not cancel upstream")
	}
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("deadline leaked %d/%d", n, b)
	}
	t.Logf("first request + solver + retry stopped at %v", elapsed)
}

type reviewReadCounter struct{ reads atomic.Int32 }

func (b *reviewReadCounter) Read(_ []byte) (int, error) { b.reads.Add(1); return 0, io.EOF }
func (b *reviewReadCounter) Close() error               { return nil }

func TestIndependentAdmissionBeforeBodyRead(t *testing.T) {
	s := &server{secret: testSecret, maxConcurrent: 1, maxBodyBytes: 1024}
	if !s.acquireRequest() {
		t.Fatal("first reservation failed")
	}
	defer s.releaseRequest()
	body := &reviewReadCounter{}
	r := httptest.NewRequest("POST", "/request", nil)
	r.Body = body
	r.Header.Set("X-Proxy-Secret", testSecret)
	w := httptest.NewRecorder()
	s.handleRequest(w, r)
	if w.Code != 429 || body.reads.Load() != 0 {
		t.Fatalf("read before admission: status=%d reads=%d", w.Code, body.reads.Load())
	}
}

type reviewErrorWriter struct{ h http.Header }

func (w *reviewErrorWriter) Header() http.Header         { return w.h }
func (w *reviewErrorWriter) WriteHeader(_ int)           {}
func (w *reviewErrorWriter) Write(_ []byte) (int, error) { return 0, io.ErrClosedPipe }

func TestIndependentDownstreamErrorReleasesPermit(t *testing.T) {
	s := &server{secret: testSecret, timeoutSecs: 1, maxBodyBytes: 1024, maxConcurrent: 1}
	localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	s.handleRequest(&reviewErrorWriter{h: http.Header{}}, proxyRequest(context.Background()))
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("write error leaked %d/%d", n, b)
	}
}

// 多个并发失败请求只能触发一次 solver，剩余命中负缓存；状态锁不跨网络调用。
func TestIndependentSolverConcurrentFailure(t *testing.T) {
	resetClearance()
	defer resetClearance()
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		w.WriteHeader(500)
	}))
	defer h.Close()
	s := &server{flareSolverrURL: h.URL, clearanceTimeout: 1}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.refreshClearance(context.Background()) }()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("solver did not start")
	}
	readDone := make(chan struct{})
	go func() { getActiveClearance(); close(readDone) }()
	select {
	case <-readDone:
	case <-time.After(100 * time.Millisecond):
		t.Error("state lock held across solver network call")
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("negative cache failed under concurrent requests: %d", calls.Load())
	}
}

// 第一请求停在可取消的 TLS 握手，第二请求仍会卡在真实 tls-client 的共享初始化互斥锁。
func TestIndependentSharedSessionCancellation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ready := make(chan net.Conn, 1)
	go func() {
		c, err := listener.Accept()
		if err != nil {
			return
		}
		_, err = http.ReadRequest(bufio.NewReader(c))
		if err != nil {
			c.Close()
			return
		}
		_, _ = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
		var tlsPrefix [5]byte
		if _, err = io.ReadFull(c, tlsPrefix[:]); err != nil {
			c.Close()
			return
		}
		ready <- c // 停在目标 TLS ServerHello 之前；本机不提供 TLS 响应。
	}()
	s := &server{secret: testSecret, profileName: defaultProfile, timeoutSecs: 3,
		maxBodyBytes: 1024, maxConcurrent: 2,
		pool: newUpstreamPool([]string{"http://" + listener.Addr().String()}, 1, time.Minute, defaultProbeURL)}
	defer s.resetSessionClients()
	firstDone, secondDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(firstDone)
		s.handleRequest(httptest.NewRecorder(), proxyRequest(context.Background()))
	}()
	var stalled net.Conn
	select {
	case stalled = <-ready:
	case <-time.After(time.Second):
		t.Fatal("first TLS handshake not reached")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { defer close(secondDone); s.handleRequest(httptest.NewRecorder(), proxyRequest(ctx)) }()
	end := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		n := s.clients["default"].inflight
		s.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(end) {
			stalled.Close()
			t.Fatal("second request did not acquire same session")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-secondDone:
	case <-time.After(250 * time.Millisecond):
		n, b := reviewCounters(s)
		t.Errorf("canceled request blocked behind other session handshake: active=%d bytes=%d", n, b)
	}
	stalled.Close()
	listener.Close()
	for _, done := range []chan struct{}{firstDone, secondDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("cleanup did not unblock client")
		}
	}
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("cleanup leaked %d/%d", n, b)
	}
}
