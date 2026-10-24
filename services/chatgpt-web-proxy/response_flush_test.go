package main

// 真实 HTTP 输出缓冲的完成/失败边界，以及 JSON 转义后 Content-Length 的字节准确性。
import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// TestResponseContentLengthCountsEscapedUTF8 不按 rune 数或转义前文本估算 JSON envelope 长度。
func TestResponseContentLengthCountsEscapedUTF8(t *testing.T) {
	result := &responsePayload{Status: 200, Headers: map[string][]string{"X-Test": {"中文<>&\"\\\u2028\u2029", string([]byte{0xff})}}, BodyBase64: encodeResponseBody([]byte("sample"))}
	w := httptest.NewRecorder()
	writeResponse(w, result)
	expected, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	expected = append(expected, '\n')
	if string(expected) != w.Body.String() {
		t.Fatalf("serialized JSON differs: %s", w.Body.String())
	}
	if w.Header().Get("Content-Length") != strconv.Itoa(len(expected)) {
		t.Fatalf("length=%s actual=%d", w.Header().Get("Content-Length"), len(expected))
	}
}

// TestPermitThroughFlushOutcomes 同时覆盖成功响应与已准入错误响应的慢读、断连及写超时。
func TestPermitThroughFlushOutcomes(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		for _, outcome := range []string{"read", "disconnect", "write-timeout"} {
			t.Run(fmt.Sprintf("invalid=%v/%s", invalid, outcome), func(t *testing.T) {
				s := &server{secret: testSecret, timeoutSecs: 2, maxBodyBytes: 1024, maxConcurrent: 1}
				if !invalid {
					localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) {
						w.Header().Set("X-Test", "中文<>&\"\\")
						_, _ = io.WriteString(w, "ok")
					})
				}
				front, back := net.Pipe()
				defer front.Close()
				observed := &reviewObservedConn{Conn: back, writing: make(chan struct{})}
				listener := &reviewOneListener{conn: observed, closed: make(chan struct{})}
				h := s.httpServer("")
				h.WriteTimeout = 200 * time.Millisecond
				closed := make(chan struct{})
				h.ConnState = func(_ net.Conn, state http.ConnState) {
					if state == http.StateClosed {
						close(closed)
					}
				}
				go func() { _ = h.Serve(listener) }()
				defer h.Close()
				body := `{"targetUrl":"https://chatgpt.com/test"}`
				if invalid {
					body = "{"
				}
				_, err := fmt.Fprintf(front, "POST /request HTTP/1.1\r\nHost: localhost\r\nX-Proxy-Secret: %s\r\nContent-Length: %d\r\n\r\n%s", testSecret, len(body), body)
				if err != nil {
					t.Fatal(err)
				}
				select {
				case <-observed.writing:
				case <-time.After(time.Second):
					t.Fatal("network write not reached")
				}
				if n, b := reviewCounters(s); n != 1 || b != 1024 {
					t.Fatalf("permit released before flush: %d/%d", n, b)
				}
				switch outcome {
				case "read":
					response, err := http.ReadResponse(bufio.NewReader(front), nil)
					if err != nil {
						t.Fatal(err)
					}
					got, err := io.ReadAll(response.Body)
					response.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					if response.ContentLength != int64(len(got)) || len(response.TransferEncoding) != 0 || !json.Valid(got) {
						t.Fatal("incorrect JSON framing/length")
					}
					if invalid && response.StatusCode != 400 {
						t.Fatalf("invalid envelope status=%d", response.StatusCode)
					}
					front.Close()
				case "disconnect":
					front.Close()
				}
				select {
				case <-closed:
				case <-time.After(time.Second):
					t.Fatal("connection did not complete or time out")
				}
				if n, b := reviewCounters(s); n != 0 || b != 0 {
					t.Fatalf("flush cleanup leaked %d/%d", n, b)
				}
			})
		}
	}
}

type failingFlushWriter struct {
	h       http.Header
	flushes int
}

func (w *failingFlushWriter) Header() http.Header         { return w.h }
func (w *failingFlushWriter) WriteHeader(_ int)           {}
func (w *failingFlushWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *failingFlushWriter) FlushError() error           { w.flushes++; return io.ErrClosedPipe }

// TestFlushErrorStillReleasesPermit 验证 ResponseController 的失败路径被实际调用并返还预留。
func TestFlushErrorStillReleasesPermit(t *testing.T) {
	s := &server{secret: testSecret, timeoutSecs: 1, maxBodyBytes: 1024}
	localTLSClient(t, s, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	w := &failingFlushWriter{h: http.Header{}}
	s.handleRequest(w, proxyRequest(context.Background()))
	if w.flushes != 1 {
		t.Fatalf("flush not observed: %d", w.flushes)
	}
	if n, b := reviewCounters(s); n != 0 || b != 0 {
		t.Fatalf("flush error leaked %d/%d", n, b)
	}
}
