package main

// 为 tls-client 接入可取消、有截止时间的出口握手，避免其旧 SOCKS/CONNECT dialer 丢失 ctx。
// 这里只处理服务器配置的出口；不会新增由调用方指定任意公网 HTTP 目标的转发入口。
import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"golang.org/x/net/proxy"
)

type contextProxyDialer struct {
	endpoint       *url.URL
	dialer         net.Dialer
	timeout        time.Duration
	headers        http.Header
	socks5         proxy.ContextDialer
	proxyTLSConfig *tls.Config
}

// proxyDialerFactory 捕获已配置出口；tls-client 不允许同时设置 WithProxyUrl 与 factory。
func proxyDialerFactory(raw string) tls_client.ProxyDialerFactory {
	return func(_ string, timeout time.Duration, localAddr *net.TCPAddr, headers fhttp.Header, _ tls_client.Logger) (proxy.ContextDialer, error) {
		return newContextProxyDialer(raw, timeout, localAddr, http.Header(headers))
	}
}

// newContextProxyDialer 支持现有 http/https/socks5/h/socks4/a，非法配置不回显含凭据的 URL。
func newContextProxyDialer(raw string, timeout time.Duration, localAddr *net.TCPAddr, headers http.Header) (*contextProxyDialer, error) {
	if timeout <= 0 {
		timeout = time.Duration(defaultTimeoutSecs) * time.Second
	}
	d := &contextProxyDialer{dialer: net.Dialer{Timeout: timeout, LocalAddr: localAddr}, timeout: timeout, headers: headers.Clone()}
	if raw == "" {
		return d, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid upstream proxy URL")
	}
	var port string
	switch u.Scheme {
	case "http":
		port = "80"
	case "https":
		port = "443"
	case "socks5", "socks5h", "socks4", "socks4a":
		port = "1080"
	default:
		return nil, errors.New("unsupported upstream proxy scheme")
	}
	if u.Port() != "" {
		port = u.Port()
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return nil, errors.New("invalid upstream proxy port")
	}
	u.Host = net.JoinHostPort(u.Hostname(), port)
	d.endpoint = u
	if u.Scheme == "socks5" || u.Scheme == "socks5h" {
		var auth *proxy.Auth
		if u.User != nil {
			password, _ := u.User.Password()
			auth = &proxy.Auth{User: u.User.Username(), Password: password}
		}
		dialer, err := proxy.SOCKS5("tcp", u.Host, auth, &d.dialer)
		if err != nil {
			return nil, errors.New("invalid SOCKS5 proxy configuration")
		}
		var ok bool
		d.socks5, ok = dialer.(proxy.ContextDialer)
		if !ok {
			return nil, errors.New("SOCKS5 dialer does not support context")
		}
	}
	return d, nil
}

// DialContext 同步完成握手；取消会关闭真实原始连接，并等待关闭回调结束再返回。
// 连接交给上层后清除握手 deadline，由 TLS/HTTP 请求自身的 context 接管。
func (d *contextProxyDialer) DialContext(parent context.Context, network, address string) (result net.Conn, err error) {
	ctx, cancel := context.WithTimeout(parent, d.timeout)
	defer cancel()
	// SOCKS 库会用 socket deadline 唤醒取消，返回的可能是 I/O timeout；保留 caller 的真实原因。
	defer func() {
		if cause := ctx.Err(); cause != nil {
			err = cause
		} else if err != nil && requestDeadlineExceeded(ctx, err) {
			err = context.DeadlineExceeded
		}
		if err != nil && result != nil {
			_ = result.Close()
			result = nil
		}
	}()
	if d.endpoint == nil {
		return d.dialer.DialContext(ctx, network, address)
	}
	if d.socks5 != nil {
		return d.socks5.DialContext(ctx, network, address)
	}
	base, err := d.dialer.DialContext(ctx, "tcp", d.endpoint.Host)
	if err != nil {
		return nil, err
	}
	closed := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = base.Close(); close(closed) })
	defer func() {
		if !stop() {
			<-closed
		}
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		if err == nil {
			err = base.SetDeadline(time.Time{})
		}
		if err != nil {
			_ = base.Close()
			result = nil
		}
	}()
	deadline, _ := ctx.Deadline()
	if err := base.SetDeadline(deadline); err != nil {
		return nil, err
	}
	var conn net.Conn = base
	if d.endpoint.Scheme == "socks4" || d.endpoint.Scheme == "socks4a" {
		if err := d.socks4Handshake(ctx, conn, address); err != nil {
			return nil, err
		}
		return conn, nil
	}
	if d.endpoint.Scheme == "https" {
		config := &tls.Config{ServerName: d.endpoint.Hostname(), NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12}
		if d.proxyTLSConfig != nil {
			config = d.proxyTLSConfig.Clone()
		}
		secured := tls.Client(base, config)
		if err := secured.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = secured
	}
	req := &http.Request{Method: http.MethodConnect, URL: &url.URL{Host: address}, Host: address, Header: d.headers.Clone()}
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	if d.endpoint.User != nil {
		password, _ := d.endpoint.User.Password()
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(d.endpoint.User.Username()+":"+password)))
	}
	if err := req.Write(conn); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(io.LimitReader(conn, 32*1024+1))
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("upstream CONNECT rejected")
	}
	return &bufferedProxyConn{Conn: conn, reader: reader}, nil
}

type bufferedProxyConn struct {
	net.Conn
	reader *bufio.Reader
}

// Read 保留 CONNECT 响应后预读的数据；读完预读区后不再受握手头部大小限制。
func (c *bufferedProxyConn) Read(p []byte) (int, error) {
	if c.reader.Buffered() > 0 {
		return c.reader.Read(p)
	}
	return c.Conn.Read(p)
}

// socks4Handshake 在同一 context/deadline 内完成 DNS、写请求与读确认，4a 保留远端 DNS。
func (d *contextProxyDialer) socks4Handshake(ctx context.Context, conn net.Conn, address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("invalid SOCKS4 target")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("invalid SOCKS4 target port")
	}
	user := ""
	if d.endpoint.User != nil {
		user = d.endpoint.User.Username()
	}
	if strings.ContainsRune(user, 0) || strings.ContainsRune(host, 0) || len(user) > 255 || len(host) > 255 {
		return errors.New("invalid SOCKS4 target or user")
	}
	ip := net.ParseIP(host).To4()
	remoteDNS := d.endpoint.Scheme == "socks4a" && ip == nil
	if remoteDNS {
		ip = net.IPv4(0, 0, 0, 1).To4()
	}
	if ip == nil {
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
		if err != nil || len(ips) == 0 {
			return errors.New("SOCKS4 IPv4 resolution failed")
		}
		ip = ips[0].To4()
		if ip == nil {
			return errors.New("SOCKS4 requires IPv4")
		}
	}
	request := append([]byte{4, 1, byte(n >> 8), byte(n)}, ip...)
	request = append(request, user...)
	request = append(request, 0)
	if remoteDNS {
		request = append(request, host...)
		request = append(request, 0)
	}
	if _, err := conn.Write(request); err != nil {
		return err
	}
	var reply [8]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return err
	}
	if reply[0] != 0 || reply[1] != 90 {
		return errors.New("upstream SOCKS4 rejected")
	}
	return nil
}
