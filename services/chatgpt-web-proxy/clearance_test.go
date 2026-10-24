package main

// FlareSolverr 的真实 HTTP 读写、取消与单飞预算；所有服务均在本机测试监听器。
import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestClearanceWaitHonorsCancellation 验证排在刷新 gate 后面的调用可以独立取消。
func TestClearanceWaitHonorsCancellation(t *testing.T) {
	clrRefreshGate <- struct{}{}
	defer func() { <-clrRefreshGate }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { (&server{}).refreshClearance(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("clearance waiter ignored cancellation")
	}
}

// TestClearanceResponseBoundedAndFailureBackoff 防止浏览器异常大返回和失败挑战波持续排队解题。
func TestClearanceResponseBoundedAndFailureBackoff(t *testing.T) {
	resetClearance()
	defer resetClearance()
	var calls atomic.Int32
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, strings.Repeat("x", clearanceMaxBodyBytes+1))
	}))
	defer h.Close()
	s := &server{flareSolverrURL: h.URL, clearanceTimeout: 1}
	for i := 0; i < 3; i++ {
		if ua, _ := s.refreshClearance(context.Background()); ua != "" {
			t.Fatal("accepted oversized solver response")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("failure backoff missing: %d browser calls", calls.Load())
	}
}

// TestChallengeCancellationStopsSolver 经真实 TLS 挑战进入 solver，再取消 caller，验证无额外重试。
func TestChallengeCancellationStopsSolver(t *testing.T) {
	resetClearance()
	defer resetClearance()
	started, stopped := make(chan struct{}), make(chan struct{})
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer h.Close()
	var attempts atomic.Int32
	s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024, clearanceEnabled: true, flareSolverrURL: h.URL, clearanceTimeout: 1}
	localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		w.WriteHeader(403)
		_, _ = io.WriteString(w, "just a moment")
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.handleRequest(httptest.NewRecorder(), proxyRequest(ctx)) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("solver did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler ignored canceled solver")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("solver request did not stop")
	}
	if attempts.Load() != 1 || s.activeRequests != 0 {
		t.Fatal("cancellation retried or leaked reservation")
	}
}

// TestClearanceSuccessRetryWithoutHeaders 检查成功解题只重试一次、缓存复用，并兼容未传 headers。
func TestClearanceSuccessRetryWithoutHeaders(t *testing.T) {
	resetClearance()
	defer resetClearance()
	var solves, attempts atomic.Int32
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		solves.Add(1)
		_, _ = io.WriteString(w, `{"status":"ok","solution":{"userAgent":"Chrome/146.0.0.0","cookies":[{"name":"cf_clearance","value":"local-test-cookie"}]}}`)
	}))
	defer h.Close()
	s := &server{timeoutSecs: 2, maxBodyBytes: 1024, clearanceEnabled: true, flareSolverrURL: h.URL, clearanceTimeout: 1, clearanceRefresh: 60}
	localTLSClient(t, s, func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		if !strings.Contains(r.Header.Get("Cookie"), "cf_clearance=local-test-cookie") {
			w.WriteHeader(403)
			_, _ = io.WriteString(w, "just a moment")
			return
		}
		_, _ = io.WriteString(w, "ok")
	})
	for i := 0; i < 2; i++ {
		result, err := s.forward(context.Background(), requestPayload{TargetURL: "https://chatgpt.com/test"})
		if err != nil || result.Status != 200 {
			t.Fatalf("clearance retry failed: %v", err)
		}
	}
	if solves.Load() != 1 || attempts.Load() != 3 {
		t.Fatalf("unexpected solver/retry counts: %d/%d", solves.Load(), attempts.Load())
	}
}
