package main

// 供启动与 /request 共用的密钥、目标 URL 边界；不读取或记录实际密钥。
import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/url"
	"strings"
)

// validateSecret 拒绝空值、示例占位与明显重复值；熵仍由部署方生成随机密钥保证。
func validateSecret(secret string) error {
	if len(secret) < 32 || len(secret) > 1024 || strings.TrimSpace(secret) != secret {
		return errors.New("CHATGPT_WEB_PROXY_SECRET must be a non-placeholder secret of 32-1024 bytes")
	}
	lower := strings.ToLower(secret)
	for _, marker := range []string{"replace", "change", "placeholder", "example", "your-secret", "your_secret", "<", ">"} {
		if strings.Contains(lower, marker) {
			return errors.New("CHATGPT_WEB_PROXY_SECRET must not be a placeholder")
		}
	}
	if strings.Trim(secret, secret[:1]) == "" {
		return errors.New("CHATGPT_WEB_PROXY_SECRET must not be a repeated character")
	}
	return nil
}

// matchesSecret 对固定长度摘要作恒定时间比较，避免直接比较字符串的前缀时序差异。
func matchesSecret(expected, supplied string) bool {
	a, b := sha256.Sum256([]byte(expected)), sha256.Sum256([]byte(supplied))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// buildAllowlistedURL 仅允许无 userinfo/fragment 的 HTTPS 443 目标；不跟随重定向。
func buildAllowlistedURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", errors.New("invalid targetUrl")
	}
	if parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil || parsed.Fragment != "" {
		return "", errors.New("targetUrl must be https without userinfo or fragment")
	}
	host := strings.ToLower(parsed.Hostname())
	// 比较完整 authority，同时拒绝空端口、补零端口、IPv6、尾点和混淆形式。
	if parsed.Host != host && parsed.Host != host+":443" {
		return "", errors.New("targetUrl must use the canonical host and port 443")
	}
	if !isAllowlistedHost(host) {
		return "", errors.New("targetUrl host is not allowlisted")
	}
	return parsed.String(), nil
}

// isAllowlistedHost 的精确项来自仓库 Adobe 调用点；adobe.io 的动态任务链接保留兼容。
// 响应生成的轮询地址没有完整域名枚举证据，因此仅保留此后缀，仍强制 443 且禁跳转。
func isAllowlistedHost(host string) bool {
	switch host {
	case "chatgpt.com", "adobeid-na1.services.adobe.com", "ims-na1.adobelogin.com":
		return true
	}
	if !strings.HasSuffix(host, ".adobe.io") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return false
			}
		}
	}
	return len(host) <= 253
}
