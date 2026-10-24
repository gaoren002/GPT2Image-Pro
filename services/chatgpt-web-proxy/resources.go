package main

// HTTP 入口及转发资源预算：在读 JSON 前预留，响应编码/发送结束后释放，拒绝无界排队。
import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	maxRequestBytes          = 8 * 1024 * 1024
	defaultMaxConcurrent     = 2
	defaultInflightBodyBytes = 64 * 1024 * 1024
	defaultMaxSessions       = 64
	clearanceMaxBodyBytes    = 1024 * 1024
	readHeaderTimeout        = 5 * time.Second
	readBodyTimeout          = 30 * time.Second
	idleTimeout              = 60 * time.Second
)

// boundedEnvInt 对资源配置 fail closed，避免溢出、负数或拼写错误悄悄退回无限预算。
func boundedEnvInt(key string, fallback, min, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be in [%d,%d]", key, min, max)
	}
	return n, nil
}

// configureLimits 仅加载非机密资源配置；单响应最多 64MiB，总原始响应预留最多 256MiB。
func (s *server) configureLimits() error {
	configs := []struct {
		key                string
		dst                *int
		fallback, min, max int
	}{
		{"CHATGPT_WEB_PROXY_TIMEOUT_SECONDS", &s.timeoutSecs, defaultTimeoutSecs, 1, 600},
		{"CHATGPT_WEB_PROXY_MAX_CONCURRENT", &s.maxConcurrent, defaultMaxConcurrent, 1, 8},
		{"CHATGPT_WEB_PROXY_MAX_SESSIONS", &s.maxSessions, defaultMaxSessions, 1, 256},
		{"CHATGPT_WEB_CLEARANCE_TIMEOUT_SECONDS", &s.clearanceTimeout, 60, 1, 120},
		{"CHATGPT_WEB_CLEARANCE_REFRESH_SECONDS", &s.clearanceRefresh, 3600, 1, 86400},
	}
	for _, c := range configs {
		n, err := boundedEnvInt(c.key, c.fallback, c.min, c.max)
		if err != nil {
			return err
		}
		*c.dst = n
	}
	bodyMB, err := boundedEnvInt("CHATGPT_WEB_PROXY_MAX_BODY_MB", defaultMaxBodyMB, 1, 64)
	if err != nil {
		return err
	}
	inflightMB, err := boundedEnvInt("CHATGPT_WEB_PROXY_MAX_INFLIGHT_BODY_MB", 64, 1, 256)
	if err != nil {
		return err
	}
	if inflightMB < bodyMB {
		return fmt.Errorf("inflight body budget must cover one maximum response")
	}
	s.maxBodyBytes, s.maxInflightBodyBytes = int64(bodyMB)*1024*1024, int64(inflightMB)*1024*1024
	return nil
}

// httpServer 使用独立 header/body/idle 截止时间；write 覆盖一次转发与有界响应发送。
func (s *server) httpServer(bind string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/request", s.handleRequest)
	return &http.Server{Addr: bind, Handler: mux, ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout: readBodyTimeout, IdleTimeout: idleTimeout,
		WriteTimeout:   time.Duration(s.timeoutSecs)*time.Second + readBodyTimeout + 10*time.Second,
		MaxHeaderBytes: 32 * 1024}
}

// acquireRequest 预留每请求最大响应；配合并发上限同时限制 JSON、base64 与编码瞬时副本。
func (s *server) acquireRequest() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	concurrent, budget := s.maxConcurrent, s.maxInflightBodyBytes
	if concurrent == 0 {
		concurrent = defaultMaxConcurrent
	}
	if budget == 0 {
		budget = defaultInflightBodyBytes
	}
	if s.activeRequests >= concurrent || s.maxBodyBytes > budget-s.inflightBodyBytes {
		return false
	}
	s.activeRequests++
	s.inflightBodyBytes += s.maxBodyBytes
	return true
}

// releaseRequest 与 acquireRequest 成对使用，覆盖全部错误与取消路径。
func (s *server) releaseRequest() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeRequests--
	s.inflightBodyBytes -= s.maxBodyBytes
}

// requestDeadlineExceeded 同时检查截止时刻和错误链：socket 定时器可能先于 ctx.Err 可见。
// 普通上游提前超时仍是 502；只有本请求预算耗尽或明确 context deadline 才归为 504。
func requestDeadlineExceeded(ctx context.Context, err error) bool {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	deadline, ok := ctx.Deadline()
	return ok && !time.Now().Before(deadline)
}
