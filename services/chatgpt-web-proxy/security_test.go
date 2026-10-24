package main

// 代理安全回归：验证鉴权、URL 边界与真实 tls-client 配置，不访问外网。
import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testSecret = "local-test-only-68a7e529f3c04d12b9e6"

// TestRequestRequiresUsableSecret 用非法 JSON 避免触发网络；只有鉴权通过才应解析正文。
func TestRequestRequiresUsableSecret(t *testing.T) {
	for _, secret := range []string{"", "replace-with-sidecar-secret", "replace-with-a-long-sidecar-secret-please", strings.Repeat("a", 32)} {
		t.Run(secret, func(t *testing.T) {
			s := &server{secret: secret}
			r := httptest.NewRequest(http.MethodPost, "/request", strings.NewReader("{"))
			r.Header.Set("X-Proxy-Secret", secret)
			w := httptest.NewRecorder()
			s.handleRequest(w, r)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("unusable server secret: got %d, want 503", w.Code)
			}
		})
	}
	for _, supplied := range []string{"", "wrong", testSecret, testSecret + "x"} {
		s := &server{secret: testSecret}
		r := httptest.NewRequest(http.MethodPost, "/request", strings.NewReader("{"))
		r.Header.Set("X-Proxy-Secret", supplied)
		w := httptest.NewRecorder()
		s.handleRequest(w, r)
		want := http.StatusUnauthorized
		if supplied == testSecret {
			want = http.StatusBadRequest
		}
		if w.Code != want {
			t.Errorf("supplied secret case: got %d want %d", w.Code, want)
		}
	}
}

// TestAllowlistedURLBoundary 保留历史派生 Adobe 地址，拒绝端口、userinfo 和域名混淆。
func TestAllowlistedURLBoundary(t *testing.T) {
	allowed := []string{
		"https://chatgpt.com/backend-api/me", "https://chatgpt.com:443/",
		"https://firefly-3p.ff.adobe.io/v2/storage/image",
		"https://adobeid-na1.services.adobe.com/ims/check/v6/token",
		"https://ims-na1.adobelogin.com/ims/profile/v1",
		"https://firefly-epo1234-prod.adobe.io/v2/jobs/1",
		"https://bks-epo1234.adobe.io/v2/jobs/result/1?host=firefly-epo1234-prod.adobe.io/",
	}
	for _, raw := range allowed {
		if _, err := buildAllowlistedURL(raw); err != nil {
			t.Errorf("reject supported URL %s: %v", raw, err)
		}
	}
	denied := []string{
		"http://chatgpt.com/", "https://chatgpt.com:8443/", "https://firefly.adobe.io:22/",
		"https://ims-na1.adobelogin.com:80/", "https://chatgpt.com:/", "https://chatgpt.com:0443/",
		"https://user:pass@chatgpt.com/", "https://chatgpt.com/#fragment",
		"https://unrelated.adobe.com/", "https://unrelated.adobelogin.com/",
		"https://chatgpt.com.evil.test/", "https://eviladobe.io/", "https://127.0.0.1/",
		"https://chatgpt.com./", "https://firefly.adobe.io.evil.test/",
	}
	for _, raw := range denied {
		if _, err := buildAllowlistedURL(raw); err == nil {
			t.Errorf("accepted unsafe URL %s", raw)
		}
	}
}

// TestSessionClientDisablesRedirects 检查真实依赖返回的 client，避免只测 URL 解析而遗漏跳转。
func TestSessionClientDisablesRedirects(t *testing.T) {
	s := &server{profileName: defaultProfile, timeoutSecs: 2, clients: map[string]*sessionClient{}}
	c, err := s.getClient("redirect-test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseIdleConnections()
	if c.GetFollowRedirect() {
		t.Fatal("business tls-client follows redirects outside allowlist")
	}
}

// TestHealthWithoutSecretKeepsMaskedStatus 保留 Docker 无密钥 readiness 与 PX04 的脱敏边界。
func TestHealthWithoutSecretKeepsMaskedStatus(t *testing.T) {
	s := &server{secret: testSecret, pool: newTestPool([]string{"socks5://warp:p%zzassword@127.0.0.1:1080"})}
	w := httptest.NewRecorder()
	s.handleHealth(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "p%zzassword") || !strings.Contains(w.Body.String(), "***") {
		t.Fatalf("readiness/mask regression: %d %s", w.Code, w.Body.String())
	}
}
