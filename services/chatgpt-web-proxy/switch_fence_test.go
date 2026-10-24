package main

// 出口切换不等待正在握手的真实 client，也不把旧 solver 结果返回给待注入方。
import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestResetClientsDoesNotWaitForHandshake 覆盖 review 中提到的 CloseIdleConnections 放大阻塞路径。
func TestResetClientsDoesNotWaitForHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ready := make(chan net.Conn, 1)
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		c, err := listener.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, err = http.ReadRequest(bufio.NewReader(c)); err != nil {
			return
		}
		_, _ = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
		var prefix [5]byte
		if _, err = io.ReadFull(c, prefix[:]); err != nil {
			return
		}
		ready <- c
		_, _ = io.Copy(io.Discard, c)
	}()
	s := &server{secret: testSecret, profileName: defaultProfile, timeoutSecs: 2, maxBodyBytes: 1024, pool: newTestPool([]string{"http://" + listener.Addr().String()})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.handleRequest(httptest.NewRecorder(), proxyRequest(ctx)) }()
	var conn net.Conn
	select {
	case conn = <-ready:
	case <-time.After(time.Second):
		t.Fatal("TLS initialization not reached")
	}
	defer conn.Close()
	resetDone := make(chan struct{})
	go func() { s.resetSessionClients(); close(resetDone) }()
	select {
	case <-resetDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("reset blocked on client initialization")
	}
	health := httptest.NewRecorder()
	s.handleHealth(health, httptest.NewRequest("GET", "/healthz", nil))
	if health.Code != 200 {
		t.Fatal("health unavailable during reset")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("retired client did not stop")
	}
	select {
	case <-peerDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("retired handshake left connection open")
	}
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("retired client leaked %d/%d", n, b)
	}
}

// TestStaleSolverResultIsNotReturned 检查 generation fence 不仅阻止缓存写入，也阻止返回旧 cookie。
func TestStaleSolverResultIsNotReturned(t *testing.T) {
	resetClearance()
	defer resetClearance()
	started, release := make(chan struct{}), make(chan struct{})
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-release
		_, _ = io.WriteString(w, `{"status":"ok","solution":{"userAgent":"OLD","cookies":[{"name":"cf_clearance","value":"old-local-only"}]}}`)
	}))
	defer h.Close()
	s := &server{flareSolverrURL: h.URL, clearanceTimeout: 1, clearanceRefresh: 60}
	type result struct {
		ua      string
		cookies int
	}
	returned := make(chan result, 1)
	go func() { ua, cookies := s.refreshClearance(context.Background()); returned <- result{ua, len(cookies)} }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("solver did not start")
	}
	resetClearance()
	close(release)
	select {
	case r := <-returned:
		if r.ua != "" || r.cookies != 0 {
			t.Fatal("stale solver returned injectable cookies")
		}
	case <-time.After(time.Second):
		t.Fatal("solver did not finish")
	}
}
