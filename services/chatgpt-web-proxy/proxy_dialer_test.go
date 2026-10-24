package main

// 出口握手的真实 TCP/TLS 测试；假出口只在本机收发协议字节，目标域名不做外部连接。
import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// readSOCKSRequest 只在测试出口解析最小握手，校验方法/凭据；返回后由用例决定停住或成功。
func readSOCKSRequest(conn net.Conn, scheme string) error {
	r := bufio.NewReader(conn)
	if strings.HasPrefix(scheme, "socks5") {
		var hello [2]byte
		if _, err := io.ReadFull(r, hello[:]); err != nil {
			return err
		}
		methods := make([]byte, int(hello[1]))
		if _, err := io.ReadFull(r, methods); err != nil {
			return err
		}
		if hello[0] != 5 {
			return fmt.Errorf("unexpected SOCKS version")
		}
		if _, err := conn.Write([]byte{5, 2}); err != nil {
			return err
		}
		var auth [2]byte
		if _, err := io.ReadFull(r, auth[:]); err != nil {
			return err
		}
		user := make([]byte, int(auth[1]))
		if _, err := io.ReadFull(r, user); err != nil {
			return err
		}
		length, err := r.ReadByte()
		if err != nil {
			return err
		}
		password := make([]byte, int(length))
		if _, err := io.ReadFull(r, password); err != nil {
			return err
		}
		if string(user) != "test-user" || string(password) != "test-pass" {
			return fmt.Errorf("SOCKS5 credentials changed")
		}
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return err
		}
		var command [4]byte
		if _, err := io.ReadFull(r, command[:]); err != nil {
			return err
		}
		length = 4
		switch command[3] {
		case 3:
			length, err = r.ReadByte()
			if err != nil {
				return err
			}
		case 4:
			length = 16
		}
		_, err = io.CopyN(io.Discard, r, int64(length)+2)
		return err
	}
	var request [8]byte
	if _, err := io.ReadFull(r, request[:]); err != nil {
		return err
	}
	user, err := r.ReadString(0)
	if err != nil {
		return err
	}
	if request[0] != 4 || request[1] != 1 || user != "test-user\x00" {
		return fmt.Errorf("invalid SOCKS4 handshake")
	}
	if scheme == "socks4a" {
		host, err := r.ReadString(0)
		if err != nil {
			return err
		}
		if host != "target.example\x00" {
			return fmt.Errorf("SOCKS4a did not preserve remote DNS")
		}
	}
	return nil
}

// TestAllProxyProtocolsStopActualHandshake 除 James 的 SOCKS5/HTTP 外覆盖 socks5h、4/a、HTTPS TLS 阶段。
func TestAllProxyProtocolsStopActualHandshake(t *testing.T) {
	for _, scheme := range []string{"socks5", "socks5h", "socks4", "socks4a", "http", "https"} {
		for _, deadline := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/deadline=%v", scheme, deadline), func(t *testing.T) {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				arrived, stopped := make(chan error, 1), make(chan struct{})
				accepted := make(chan net.Conn, 1)
				go func() {
					defer close(stopped)
					c, err := listener.Accept()
					if err != nil {
						arrived <- err
						return
					}
					accepted <- c
					defer c.Close()
					if scheme == "https" {
						var prefix [5]byte
						_, err = io.ReadFull(c, prefix[:])
					} else if scheme == "http" {
						_, err = http.ReadRequest(bufio.NewReader(c))
					} else {
						err = readSOCKSRequest(c, scheme)
					}
					arrived <- err
					if err == nil {
						_, _ = io.Copy(io.Discard, c)
					}
				}()
				d, err := newContextProxyDialer(scheme+"://test-user:test-pass@"+listener.Addr().String(), time.Second, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				if deadline {
					ctx, cancel = context.WithTimeout(context.Background(), 250*time.Millisecond)
				}
				defer cancel()
				done := make(chan error, 1)
				target := "127.0.0.1:443"
				if scheme == "socks4a" {
					target = "target.example:443"
				}
				go func() {
					c, err := d.DialContext(ctx, "tcp", target)
					if c != nil {
						c.Close()
					}
					done <- err
				}()
				c := <-accepted
				defer c.Close()
				select {
				case err := <-arrived:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Second):
					t.Fatal("proxy not reached")
				}
				if !deadline {
					cancel()
				}
				select {
				case err := <-done:
					if err == nil {
						t.Fatal("stalled handshake unexpectedly succeeded")
					}
					if deadline {
						var timeout net.Error
						if !errors.Is(err, context.DeadlineExceeded) && !(errors.As(err, &timeout) && timeout.Timeout()) {
							t.Fatalf("handshake returned a non-timeout failure: %v", err)
						}
						// socket 与 context 使用独立 timer；等待 context 终止，但不放宽关闭/时限断言。
						select {
						case <-ctx.Done():
						case <-time.After(250 * time.Millisecond):
							t.Fatal("context deadline did not become visible")
						}
						if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
							t.Fatalf("unexpected context reason: %v", ctx.Err())
						}
					} else if !errors.Is(err, context.Canceled) {
						t.Fatalf("explicit cancellation lost its cause: %v", err)
					}
				case <-time.After(600 * time.Millisecond):
					t.Fatal("handshake did not stop")
				}
				select {
				case <-stopped:
				case <-time.After(500 * time.Millisecond):
					t.Fatal("peer connection remained open")
				}
			})
		}
	}
}

// TestProxyProtocolsConnectAndClearDeadline 校验协议成功/认证/预读字节，确保握手后不遗留过期 deadline。
func TestProxyProtocolsConnectAndClearDeadline(t *testing.T) {
	certificateSource := httptest.NewTLSServer(http.NotFoundHandler())
	defer certificateSource.Close()
	roots := x509.NewCertPool()
	roots.AddCert(certificateSource.Certificate())
	for _, scheme := range []string{"socks5", "socks5h", "socks4", "socks4a", "http", "https"} {
		t.Run(scheme, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			if scheme == "https" {
				listener = tls.NewListener(listener, &tls.Config{Certificates: certificateSource.TLS.Certificates, MinVersion: tls.VersionTLS12})
			}
			defer listener.Close()
			done := make(chan error, 1)
			go func() {
				c, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(2 * time.Second))
				switch scheme {
				case "http", "https":
					var r *http.Request
					r, err = http.ReadRequest(bufio.NewReader(c))
					if err == nil && (r.Method != "CONNECT" || r.Header.Get("Proxy-Authorization") != "Basic dGVzdC11c2VyOnRlc3QtcGFzcw==") {
						err = fmt.Errorf("invalid CONNECT credentials")
					}
					if err == nil {
						_, err = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\npre")
					}
				default:
					err = readSOCKSRequest(c, scheme)
					if err == nil {
						reply := []byte{0, 90, 0, 0, 0, 0, 0, 0}
						if strings.HasPrefix(scheme, "socks5") {
							reply = []byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}
						}
						_, err = c.Write(append(reply, []byte("pre")...))
					}
				}
				if err == nil {
					_, err = io.Copy(c, c)
				}
				done <- err
			}()
			d, err := newContextProxyDialer(scheme+"://test-user:test-pass@"+listener.Addr().String(), 100*time.Millisecond, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if scheme == "https" {
				d.proxyTLSConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12}
			}
			target := "127.0.0.1:443"
			if scheme == "socks4a" {
				target = "target.example:443"
			}
			c, err := d.DialContext(context.Background(), "tcp", target)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			var prefix [3]byte
			if _, err := io.ReadFull(c, prefix[:]); err != nil || string(prefix[:]) != "pre" {
				t.Fatalf("lost prefetched data: %v", err)
			}
			time.Sleep(120 * time.Millisecond)
			if _, err := c.Write([]byte("ping")); err != nil {
				t.Fatalf("handshake deadline retained: %v", err)
			}
			var echo [4]byte
			if _, err := io.ReadFull(c, echo[:]); err != nil || !bytes.Equal(echo[:], []byte("ping")) {
				t.Fatalf("echo failed: %v", err)
			}
			c.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("proxy did not finish")
			}
		})
	}
}
