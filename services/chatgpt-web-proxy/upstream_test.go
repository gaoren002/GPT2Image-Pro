package main

// 上游池：解析清洗、故障转移状态机、恢复与回调。

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseUpstreamList(t *testing.T) {
	got := parseUpstreamList(" socks5://a:1080 ,socks5://b:1080,,socks5://a:1080, ")
	want := []string{"socks5://a:1080", "socks5://b:1080"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseUpstreamList=%v want %v", got, want)
	}
	if got := parseUpstreamList(",,,"); len(got) != 0 {
		t.Errorf("全空输入应返回空, got %v", got)
	}
}

func newTestPool(urls []string) *upstreamPool {
	return newUpstreamPool(urls, 2, time.Minute, "https://probe.example/")
}

func TestPoolActiveURLEmpty(t *testing.T) {
	p := newTestPool(nil)
	if p.ActiveURL() != "" {
		t.Errorf("空池 ActiveURL 应为空串")
	}
	if p.checkOnce() {
		t.Errorf("空池 checkOnce 不应切换")
	}
	if p.Status() != nil {
		t.Errorf("空池 Status 应为 nil")
	}
}

func TestPoolFailoverSwitchAndCallback(t *testing.T) {
	p := newTestPool([]string{"socks5://a:1080", "socks5://b:1080"})
	switched := ""
	p.probe = func(proxyURL string) error {
		if proxyURL == "socks5://a:1080" {
			return errors.New("unexpected EOF")
		}
		return nil
	}
	p.onSwitch = func(oldURL, newURL string) { switched = oldURL + "->" + newURL }

	if p.checkOnce() {
		t.Fatal("第 1 次失败未到阈值不应切换")
	}
	if !p.checkOnce() {
		t.Fatal("第 2 次失败达到阈值应切换")
	}
	if p.ActiveURL() != "socks5://b:1080" {
		t.Fatalf("切换后 active=%s", p.ActiveURL())
	}
	if switched != "socks5://a:1080->socks5://b:1080" {
		t.Fatalf("onSwitch 回调错: %q", switched)
	}

	// 切到 b 后：b 持续健康不再切换；a 仍按探测桩持续失败（备胎失败会计数但不切回）
	if p.checkOnce() {
		t.Fatal("b 健康, 不应再切换")
	}
	status := p.Status()
	if status[0]["failures"].(int) < 1 || status[0]["healthy"].(bool) {
		t.Fatalf("备胎 a 持续故障应保持失败计数: %v", status[0])
	}
	if !status[1]["active"].(bool) || status[1]["failures"] != 0 {
		t.Fatalf("active b 状态异常: %v", status[1])
	}
}

func TestPoolAllUnhealthyHolds(t *testing.T) {
	p := newTestPool([]string{"socks5://a:1080", "socks5://b:1080"})
	p.probe = func(string) error { return errors.New("boom") }
	p.checkOnce()
	if p.checkOnce() {
		t.Fatal("全部不健康时不应切换")
	}
	if p.ActiveURL() != "socks5://a:1080" {
		t.Fatalf("应保持在原上游, got %s", p.ActiveURL())
	}
}

func TestPoolSingleEntryNoSwitch(t *testing.T) {
	p := newTestPool([]string{"socks5://a:1080"})
	p.probe = func(string) error { return errors.New("down") }
	for i := 0; i < 5; i++ {
		if p.checkOnce() {
			t.Fatal("单项池无处可切")
		}
	}
	if p.ActiveURL() != "socks5://a:1080" {
		t.Fatalf("单项池 active 不应变")
	}
}

func TestPoolRecoveryClearsFailures(t *testing.T) {
	p := newTestPool([]string{"socks5://a:1080", "socks5://b:1080"})
	broken := true
	p.probe = func(proxyURL string) error {
		if proxyURL == "socks5://a:1080" && broken {
			return errors.New("reset by peer")
		}
		return nil
	}
	p.checkOnce()
	if !p.checkOnce() {
		t.Fatal("阈值到达应切换到 b")
	}
	broken = false
	for i := 0; i < 3; i++ {
		if p.checkOnce() {
			t.Fatal("b 健康, 不应切换")
		}
	}
	// a 恢复后保持健康状态可见,但 active 仍为 b(只在 b 故障时才会切回)
	if p.ActiveURL() != "socks5://b:1080" {
		t.Fatalf("active 应保持 b")
	}
	status := p.Status()
	if !status[0]["healthy"].(bool) || status[0]["failures"] != 0 {
		t.Fatalf("a 恢复后状态应清零: %v", status[0])
	}
}

// onSwitch 必须在释放 p.mu 之后调用：真实回调会去拿 server.mu 重建会话 client，
// 而 getClient 持 server.mu 时会调用 ActiveURL() 拿 p.mu。若回调在锁内触发，两条
// 路径加锁顺序相反，交错即永久死锁（/request 与 /healthz 全部挂起，不会自愈）。
// 这里在回调内部回调 ActiveURL：sync.Mutex 不可重入，锁内触发会卡死而非返回。
func TestPoolSwitchCallbackRunsWithoutPoolLock(t *testing.T) {
	p := newUpstreamPool(
		[]string{"socks5://a:1080", "socks5://b:1080"},
		1,
		time.Minute,
		"https://probe.example/",
	)
	p.probe = func(proxyURL string) error {
		if proxyURL == "socks5://a:1080" {
			return errors.New("unexpected EOF")
		}
		return nil
	}
	activeInCallback := make(chan string, 1)
	p.onSwitch = func(_ string, _ string) {
		activeInCallback <- p.ActiveURL()
	}

	switched := make(chan bool, 1)
	go func() { switched <- p.checkOnce() }()

	select {
	case active := <-activeInCallback:
		if active != "socks5://b:1080" {
			t.Fatalf("回调内读到的 active=%s, 应为切换后的备胎", active)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("onSwitch 在持有池锁时触发: 回调内 ActiveURL 死锁")
	}

	select {
	case ok := <-switched:
		if !ok {
			t.Fatal("达到阈值应发生切换")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("checkOnce 未返回")
	}
}

func TestMaskProxyCredential(t *testing.T) {
	got := maskProxyCredential("socks5://warp:secret@1.2.3.4:1080")
	if got != "socks5://warp:***@1.2.3.4:1080" {
		t.Errorf("凭据未脱敏: %s", got)
	}
	if got := maskProxyCredential("socks5://1.2.3.4:1080"); got != "socks5://1.2.3.4:1080" {
		t.Errorf("无凭据不应改写: %s", got)
	}

	// /healthz 不鉴权，解析失败时不得回显明文口令：口令含 % 字面量恰好会让
	// url.Parse 失败（非法转义），原样返回等于把口令输出到未鉴权接口。
	unparsable := "socks5://warp:p%zzassword@1.2.3.4:1080"
	got = maskProxyCredential(unparsable)
	if strings.Contains(got, "p%zzassword") {
		t.Errorf("解析失败时泄露明文口令: %s", got)
	}
	if got != "socks5://warp:***@1.2.3.4:1080" {
		t.Errorf("解析失败兜底脱敏结果错: %s", got)
	}
	// 无 userinfo 的非法 URL 不含口令，保持原样便于排查。
	if got := maskProxyCredential("socks5://1.2.3.4:10%80"); got != "socks5://1.2.3.4:10%80" {
		t.Errorf("无凭据的非法 URL 不应改写: %s", got)
	}
}
