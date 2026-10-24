package main

// ChatGPT Web TLS 指纹转发入口，复用有界会话 client 并支持可取消的 clearance 后备。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	stdhttp "net/http"
)

const (
	defaultBind        = ":3021"
	defaultProfile     = "chrome_146"
	defaultTimeoutSecs = 300
	defaultIdleTTL     = 30 * time.Minute
	defaultMaxBodyMB   = 32
	chatGPTOrigin      = "https://chatgpt.com"
)

type requestPayload struct {
	SessionKey string `json:"sessionKey"`
	Method     string `json:"method"`
	URLPath    string `json:"urlPath"`
	TargetPath string `json:"targetPath"`
	// TargetURL 为可选的绝对 URL（https）。设置后走主机白名单转发（用于 Adobe Firefly
	// 等多主机直连）；未设置时回落到 URLPath + chatgpt.com（保持原 ChatGPT Web 行为）。
	TargetURL   string            `json:"targetUrl"`
	Headers     map[string]string `json:"headers"`
	HeaderOrder []string          `json:"headerOrder"`
	BodyBase64  string            `json:"bodyBase64"`
}

type responsePayload struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64"`
}

type sessionClient struct {
	client   tls_client.HttpClient
	lastUsed time.Time
	inflight int
}

type server struct {
	secret               string
	profileName          string
	timeoutSecs          int
	maxBodyBytes         int64
	maxConcurrent        int
	maxInflightBodyBytes int64
	maxSessions          int
	activeRequests       int
	inflightBodyBytes    int64

	// 上游出口池（多上游 + 健康探测 + 故障转移）。空池 = 直连（与旧版单上游
	// 未配置时行为一致）。见 upstream.go。
	pool *upstreamPool
	// 显式配置的 clearance 代理覆盖；为空时跟随 pool 当前生效上游。
	clearanceProxyOverride string

	// cf_clearance 后备(仿 chatgpt2api):命中 Cloudflare 挑战时经 FlareSolverr(走同一 WARP 出口)
	// 解挑战、拿 cf_clearance+UA,注入会话 cookie jar 并覆盖 UA/Sec-Ch-Ua 后重试。默认启用、惰性。
	clearanceEnabled bool
	flareSolverrURL  string
	clearanceTimeout int
	clearanceRefresh int

	mu      sync.Mutex
	clients map[string]*sessionClient
}

func main() {
	secret := strings.TrimSpace(os.Getenv("CHATGPT_WEB_PROXY_SECRET"))
	if err := validateSecret(secret); err != nil {
		log.Fatal(err)
	}
	// 上游池：优先读逗号分隔的 POOL；未配置时回落到旧单上游变量（等价单项池），
	// 两者都为空则直连。标准部署经 docker-compose/.env 注入，见 .env.docker.example。
	upstreamURLs := parseUpstreamList(os.Getenv("CHATGPT_WEB_UPSTREAM_POOL"))
	if len(upstreamURLs) == 0 {
		if single := strings.TrimSpace(os.Getenv("CHATGPT_WEB_UPSTREAM_PROXY_URL")); single != "" {
			upstreamURLs = []string{single}
		}
	}
	pool := newUpstreamPool(
		upstreamURLs,
		envInt("CHATGPT_WEB_UPSTREAM_PROBE_FAILURES", defaultProbeFailures),
		time.Duration(envInt("CHATGPT_WEB_UPSTREAM_PROBE_INTERVAL_SECONDS", int(defaultProbeInterval/time.Second)))*time.Second,
		envString("CHATGPT_WEB_UPSTREAM_PROBE_URL", defaultProbeURL),
	)

	s := &server{
		secret:                 secret,
		profileName:            envString("CHATGPT_WEB_PROXY_PROFILE", defaultProfile),
		pool:                   pool,
		clearanceProxyOverride: strings.TrimSpace(os.Getenv("CHATGPT_WEB_CLEARANCE_PROXY_URL")),
		// 默认启用(设 CHATGPT_WEB_CLEARANCE_MODE=off 关);出口默认跟随上游池、FlareSolverr 同网络。
		clearanceEnabled: !strings.EqualFold(envString("CHATGPT_WEB_CLEARANCE_MODE", "flaresolverr"), "off"),
		flareSolverrURL:  envString("FLARESOLVERR_URL", "http://flaresolverr:8191"),
		clients:          map[string]*sessionClient{},
	}
	if err := s.configureLimits(); err != nil {
		log.Fatal(err)
	}
	// 切换上游后：会话 client 与 cf_clearance 都绑定旧出口 IP，必须整体作废重建。
	pool.onSwitch = func(oldURL, newURL string) {
		resetClearance()
		s.resetSessionClients()
	}

	go s.cleanupLoop()
	go pool.Run(context.Background())

	bind := envString("CHATGPT_WEB_PROXY_BIND", defaultBind)
	log.Printf("chatgpt-web-proxy listening on %s profile=%s upstreams=%d active=%s",
		bind, s.profileName, len(upstreamURLs), maskProxyCredential(pool.ActiveURL()))
	if err := s.httpServer(bind).ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func envString(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func (s *server) handleHealth(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
	if validateSecret(s.secret) != nil {
		writeError(w, stdhttp.StatusServiceUnavailable, "proxy is not configured")
		return
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{
		"status":    "ok",
		"upstreams": s.pool.Status(),
	})
}

func (s *server) handleRequest(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != stdhttp.MethodPost {
		writeError(w, stdhttp.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if validateSecret(s.secret) != nil {
		writeError(w, stdhttp.StatusServiceUnavailable, "proxy is not configured")
		return
	}
	if !matchesSecret(s.secret, r.Header.Get("X-Proxy-Secret")) {
		writeError(w, stdhttp.StatusUnauthorized, "unauthorized")
		return
	}

	if !s.acquireRequest() {
		w.Header().Set("Retry-After", "1")
		writeError(w, stdhttp.StatusTooManyRequests, "proxy capacity exhausted")
		return
	}
	defer func() {
		// net/http 在 handler 返回后才做最后 flush，必须在归还预算之前同步清空。
		if err := stdhttp.NewResponseController(w).Flush(); err != nil && r.Context().Err() == nil {
			log.Printf("flush proxy response failed")
		}
		s.releaseRequest()
	}()
	defer r.Body.Close()
	var payload requestPayload
	decoder := json.NewDecoder(stdhttp.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err := decoder.Decode(&payload); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid request payload")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, stdhttp.StatusBadRequest, "invalid request payload")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.timeoutSecs)*time.Second)
	defer cancel()
	result, err := s.forward(ctx, payload)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if requestDeadlineExceeded(ctx, err) {
			writeError(w, stdhttp.StatusGatewayTimeout, "proxy request timed out")
		} else {
			writeError(w, stdhttp.StatusBadGateway, "proxy upstream request failed")
		}
		return
	}
	writeResponse(w, result)
}

func (s *server) forward(ctx context.Context, payload requestPayload) (*responsePayload, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(payload.SessionKey) > 256 {
		return nil, errors.New("sessionKey is too long")
	}
	if payload.Headers == nil {
		payload.Headers = map[string]string{}
	}
	var targetURL string
	var err error
	if strings.TrimSpace(payload.TargetURL) != "" {
		targetURL, err = buildAllowlistedURL(payload.TargetURL)
	} else {
		targetURL, err = buildTargetURL(payload.URLPath)
	}
	if err != nil {
		return nil, err
	}

	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method == "" {
		method = fhttp.MethodGet
	}

	body, err := decodeBody(payload.BodyBase64)
	if err != nil {
		return nil, err
	}

	client, err := s.getClient(payload.SessionKey)
	if err != nil {
		return nil, err
	}

	defer s.releaseClient(payload.SessionKey, client)
	// 单次构建+发送:每次按当前 payload.Headers/Order 重建请求(重试时头已被 clearance 覆盖）。
	send := func() (int, fhttp.Header, []byte, error) {
		var reader io.Reader
		if len(body) > 0 {
			reader = bytes.NewReader(body)
		}
		req, reqErr := fhttp.NewRequestWithContext(ctx, method, targetURL, reader)
		if reqErr != nil {
			return 0, nil, nil, reqErr
		}
		applyHeaders(req, payload.Headers, payload.HeaderOrder)
		resp, doErr := client.Do(req)
		if doErr != nil {
			return 0, nil, nil, doErr
		}
		defer resp.Body.Close()
		rb, readErr := readLimited(resp.Body, s.maxBodyBytes)
		if readErr != nil {
			return 0, nil, nil, readErr
		}
		return resp.StatusCode, resp.Header, rb, nil
	}

	// cf_clearance 后备仅对 chatgpt.com 请求生效。已有活跃 clearance 则先注入(cookie 进 jar + 覆盖 UA)。
	target, _ := url.Parse(targetURL)
	isChatGPT := target.Hostname() == "chatgpt.com"
	if s.clearanceEnabled && isChatGPT {
		if ua, cookies := getActiveClearance(); ua != "" {
			applyClearanceHeaders(payload.Headers, ua)
			s.injectCookies(client, cookies)
		}
	}

	status, respHeaders, respBody, err := send()
	if err != nil {
		return nil, err
	}

	// 命中 Cloudflare 挑战 → 经 FlareSolverr(同一 WARP 出口)刷 clearance → 注入 → 重试一次。
	if s.clearanceEnabled && isChatGPT && isCloudflareChallenge(status, respBody) {
		if ua, cookies := s.refreshClearance(ctx); ua != "" {
			applyClearanceHeaders(payload.Headers, ua)
			s.injectCookies(client, cookies)
			status, respHeaders, respBody, err = send()
			if err != nil {
				return nil, err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	return &responsePayload{
		Status:     status,
		Headers:    mapHeaders(respHeaders),
		BodyBase64: encodeResponseBody(respBody),
	}, nil
}

// ===== cf_clearance 后备(仿 basketikun/chatgpt2api:WARP + FlareSolverr 刷 cf_clearance) =====
//
// cf_clearance 绑「出口 IP + UA」不绑 ChatGPT 账号,而全池共用同一 WARP 上游 → 一份 clearance 全池通用,
// 故用全局单例缓存 + 单飞(可取消 gate 串行 + 双检):一次挑战波只真解一次,不至于把 FlareSolverr
// 的无头 Chrome 打爆。默认启用但完全惰性:无挑战时不触发、不注入,对现网零影响。

var (
	clrMu          sync.Mutex
	clrUA          string
	clrCookies     []*fhttp.Cookie
	clrExpires     time.Time
	clrRefreshGate = make(chan struct{}, 1)
	clrRetryAfter  time.Time
	clrGeneration  uint64
)

var chromeMajorRe = regexp.MustCompile(`Chrome/(\d+)`)

var clearanceCookieNames = map[string]bool{
	"cf_clearance": true, "__cf_bm": true, "_cfuvid": true, "__cflb": true,
}

type flareResp struct {
	Status   string `json:"status"`
	Message  string `json:"message"`
	Solution struct {
		UserAgent string `json:"userAgent"`
		Cookies   []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"cookies"`
	} `json:"solution"`
}

// getActiveClearance 返回未过期的全局 clearance(UA + cookies);无/过期返回空。
func getActiveClearance() (string, []*fhttp.Cookie) {
	clrMu.Lock()
	defer clrMu.Unlock()
	if clrUA == "" || time.Now().After(clrExpires) {
		return "", nil
	}
	return clrUA, clrCookies
}

// isCloudflareChallenge 判定响应是否 Cloudflare 挑战/拦截页(仅 403/503 + 特征串)。
func isCloudflareChallenge(status int, body []byte) bool {
	if status != 403 && status != 503 {
		return false
	}
	b := strings.ToLower(string(body))
	return strings.Contains(b, "just a moment") ||
		strings.Contains(b, "attention required") ||
		strings.Contains(b, "cf-chl-") ||
		strings.Contains(b, "__cf_chl_") ||
		strings.Contains(b, "cf-browser-verification") ||
		strings.Contains(b, "challenge-platform")
}

func platformFromUA(ua string) string {
	switch {
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Macintosh"), strings.Contains(ua, "Mac OS X"):
		return "macOS"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	default:
		return "Windows"
	}
}

// applyClearanceHeaders 覆盖 UA 与 Sec-Ch-Ua*(cf_clearance 绑 UA,必须一致,否则 UA↔Sec-Ch-Ua 打架)。
func applyClearanceHeaders(headers map[string]string, ua string) {
	if headers == nil {
		return
	}
	headers["User-Agent"] = ua
	if m := chromeMajorRe.FindStringSubmatch(ua); m != nil {
		v := m[1]
		headers["Sec-Ch-Ua"] = fmt.Sprintf(`"Chromium";v="%s", "Google Chrome";v="%s", "Not?A_Brand";v="24"`, v, v)
		headers["Sec-Ch-Ua-Full-Version-List"] = fmt.Sprintf(`"Chromium";v="%s.0.0.0", "Google Chrome";v="%s.0.0.0", "Not?A_Brand";v="24.0.0.0"`, v, v)
		headers["Sec-Ch-Ua-Full-Version"] = fmt.Sprintf(`"%s.0.0.0"`, v)
	}
	headers["Sec-Ch-Ua-Platform"] = fmt.Sprintf(`"%s"`, platformFromUA(ua))
}

// injectCookies 把 cf_clearance 等写入会话 tls-client 的 cookie jar(chatgpt.com 域),自动随后续请求发送。
func (s *server) injectCookies(client tls_client.HttpClient, cookies []*fhttp.Cookie) {
	if len(cookies) == 0 {
		return
	}
	u, err := url.Parse(chatGPTOrigin)
	if err != nil {
		return
	}
	client.SetCookies(u, cookies)
}

// refreshClearance 以请求 context 控制单飞等待、FlareSolverr 网络与响应读取。
// 失败短暂负缓存，避免一波挑战逐个执行浏览器请求；响应最多 1MiB，禁止重定向。
func (s *server) refreshClearance(ctx context.Context) (string, []*fhttp.Cookie) {
	select {
	case clrRefreshGate <- struct{}{}:
		defer func() { <-clrRefreshGate }()
	case <-ctx.Done():
		return "", nil
	}
	if ctx.Err() != nil {
		return "", nil
	}
	clrMu.Lock()
	generation := clrGeneration
	if clrUA != "" && time.Now().Before(clrExpires) {
		ua, cookies := clrUA, clrCookies
		clrMu.Unlock()
		return ua, cookies
	}
	backoff := time.Now().Before(clrRetryAfter)
	clrMu.Unlock()
	if backoff {
		return "", nil
	}
	success := false
	defer func() {
		if !success && ctx.Err() == nil {
			clrMu.Lock()
			if generation == clrGeneration {
				clrRetryAfter = time.Now().Add(5 * time.Second)
			}
			clrMu.Unlock()
		}
	}()
	reqBody := map[string]any{"cmd": "request.get", "url": chatGPTOrigin + "/", "maxTimeout": s.clearanceTimeout * 1000}
	clearanceProxy := s.clearanceProxyOverride
	if clearanceProxy == "" {
		clearanceProxy = s.pool.ActiveURL()
	}
	if clearanceProxy != "" {
		reqBody["proxy"] = map[string]string{"url": clearanceProxy}
	}
	buf, _ := json.Marshal(reqBody)
	req, err := stdhttp.NewRequestWithContext(ctx, stdhttp.MethodPost,
		strings.TrimRight(s.flareSolverrURL, "/")+"/v1", bytes.NewReader(buf))
	if err != nil {
		log.Printf("cf_clearance refresh: invalid solver URL")
		return "", nil
	}
	req.Header.Set("Content-Type", "application/json")
	httpClient := &stdhttp.Client{Timeout: time.Duration(s.clearanceTimeout+20) * time.Second,
		CheckRedirect: func(_ *stdhttp.Request, _ []*stdhttp.Request) error { return stdhttp.ErrUseLastResponse }}
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("cf_clearance refresh transport failed")
		return "", nil
	}
	defer resp.Body.Close()
	raw, err := readLimited(resp.Body, clearanceMaxBodyBytes)
	var fr flareResp
	if err != nil || resp.StatusCode != stdhttp.StatusOK || json.Unmarshal(raw, &fr) != nil || fr.Status != "ok" {
		log.Printf("cf_clearance refresh: invalid or oversized response")
		return "", nil
	}
	var cookies []*fhttp.Cookie
	hasClearance := false
	for _, c := range fr.Solution.Cookies {
		if clearanceCookieNames[c.Name] && c.Value != "" {
			cookies = append(cookies, &fhttp.Cookie{Name: c.Name, Value: c.Value, Domain: "chatgpt.com", Path: "/"})
			if c.Name == "cf_clearance" {
				hasClearance = true
			}
		}
	}
	ua := strings.TrimSpace(fr.Solution.UserAgent)
	if !hasClearance || ua == "" {
		log.Printf("cf_clearance refresh: missing cf_clearance/ua")
		return "", nil
	}
	clrMu.Lock()
	defer clrMu.Unlock()
	// generation 在读取出口之前截取；切换后迟到的正缓存、负缓存与待注入结果一并丢弃。
	if generation != clrGeneration || ctx.Err() != nil {
		return "", nil
	}
	clrUA, clrCookies = ua, cookies
	clrExpires = time.Now().Add(time.Duration(s.clearanceRefresh) * time.Second)
	clrRetryAfter = time.Time{}
	success = true
	return ua, cookies
}

func buildTargetURL(urlPath string) (string, error) {
	if !strings.HasPrefix(urlPath, "/") || strings.HasPrefix(urlPath, "//") {
		return "", errors.New("urlPath must be an absolute path")
	}
	parsed, err := url.Parse(chatGPTOrigin + urlPath)
	if err != nil {
		return "", fmt.Errorf("invalid urlPath: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host != "chatgpt.com" || parsed.Fragment != "" {
		return "", errors.New("only https://chatgpt.com requests are allowed")
	}
	return parsed.String(), nil
}

func decodeBody(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	body, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, errors.New("bodyBase64 is invalid")
	}
	return body, nil
}

func applyHeaders(req *fhttp.Request, headers map[string]string, order []string) {
	req.Header = fhttp.Header{}
	for key, value := range headers {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" || shouldSkipHeader(trimmedKey) {
			continue
		}
		req.Header.Set(trimmedKey, value)
	}
	if len(order) > 0 {
		headerOrder := make([]string, 0, len(order))
		for _, key := range order {
			trimmedKey := strings.TrimSpace(key)
			if trimmedKey == "" || shouldSkipHeader(trimmedKey) {
				continue
			}
			headerOrder = append(headerOrder, strings.ToLower(trimmedKey))
		}
		if len(headerOrder) > 0 {
			req.Header[fhttp.HeaderOrderKey] = headerOrder
		}
	}
}

func shouldSkipHeader(key string) bool {
	switch strings.ToLower(key) {
	case "host", "content-length", "connection", "x-proxy-secret", "proxy-authorization":
		return true
	default:
		return false
	}
}

func (s *server) getClient(sessionKey string) (tls_client.HttpClient, error) {
	key := normalizeSessionKey(sessionKey)

	s.mu.Lock()
	var evicted tls_client.HttpClient
	defer func() {
		s.mu.Unlock()
		if evicted != nil {
			evicted.CloseIdleConnections()
		}
	}()

	if existing := s.clients[key]; existing != nil {
		existing.client = controlClient(existing.client)
		existing.lastUsed = time.Now()
		existing.inflight++
		return existing.client, nil
	}

	if s.clients == nil {
		s.clients = map[string]*sessionClient{}
	}
	limit := s.maxSessions
	if limit == 0 {
		limit = defaultMaxSessions
	}
	if len(s.clients) >= limit {
		oldestKey := ""
		var oldest time.Time
		for key, entry := range s.clients {
			if entry.inflight == 0 && (oldest.IsZero() || entry.lastUsed.Before(oldest)) {
				oldestKey, oldest = key, entry.lastUsed
			}
		}
		if oldest.IsZero() {
			return nil, errors.New("proxy session capacity exhausted")
		}
		evicted = s.clients[oldestKey].client
		delete(s.clients, oldestKey)
	}
	options, err := s.clientOptions()
	if err != nil {
		return nil, err
	}

	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, err
	}

	client = controlClient(client)
	s.clients[key] = &sessionClient{client: client, lastUsed: time.Now(), inflight: 1}
	return client, nil
}

func (s *server) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		var expired []tls_client.HttpClient
		s.mu.Lock()
		for key, item := range s.clients {
			if item.inflight == 0 && time.Since(item.lastUsed) > defaultIdleTTL {
				expired = append(expired, item.client)
				delete(s.clients, key)
			}
		}
		s.mu.Unlock()
		for _, client := range expired {
			client.CloseIdleConnections()
		}
	}
}

// resetSessionClients 作废全部会话 client（上游切换后调用）：tls-client 绑定
// 建连时的代理出口，旧 client 会继续走已中毒的旧出口。下次请求按需重建。
func (s *server) resetSessionClients() {
	s.mu.Lock()
	var stale []tls_client.HttpClient
	for key, item := range s.clients {
		stale = append(stale, item.client)
		delete(s.clients, key)
	}
	s.mu.Unlock()
	for _, client := range stale {
		client.CloseIdleConnections()
	}
}

// resetClearance 作废全局 cf_clearance（上游切换后调用）：cf_clearance 绑定
// 出口 IP + UA，换出口后旧值必然失效，留着只会注入无效 cookie。
func resetClearance() {
	clrMu.Lock()
	defer clrMu.Unlock()
	clrGeneration++
	clrUA = ""
	clrCookies = nil
	clrExpires = time.Time{}
	clrRetryAfter = time.Time{}
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("upstream response body is too large")
	}
	return data, nil
}

func mapHeaders(headers fhttp.Header) map[string][]string {
	result := make(map[string][]string, len(headers))
	for key, values := range headers {
		if strings.EqualFold(key, fhttp.HeaderOrderKey) {
			continue
		}
		copied := make([]string, len(values))
		copy(copied, values)
		result[key] = copied
	}
	return result
}

func writeJSON(w stdhttp.ResponseWriter, status int, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = []byte(`{"error":"response encoding failed"}`)
		status = 500
	}
	raw = append(raw, '\n')
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		log.Printf("write json failed: %v", err)
	}
}

func writeError(w stdhttp.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
