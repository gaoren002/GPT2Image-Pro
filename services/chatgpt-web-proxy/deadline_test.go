package main

// socket deadline 可先于 context timer 可见；模拟这一真实窗口，确保错误分类不依赖调度顺序。
import (
	"context"
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

type pendingTimerContext struct {
	context.Context
	at time.Time
}

func (c pendingTimerContext) Deadline() (time.Time, bool) { return c.at, true }

func TestDeadlineClassificationBeforeContextTimer(t *testing.T) {
	socketTimeout := &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded}
	for _, tc := range []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"elapsed socket deadline", pendingTimerContext{context.Background(), time.Now().Add(-time.Millisecond)}, socketTimeout, true},
		{"wrapped context deadline", context.Background(), errors.Join(errors.New("transport"), context.DeadlineExceeded), true},
		{"early upstream timeout", pendingTimerContext{context.Background(), time.Now().Add(time.Hour)}, socketTimeout, false},
		{"ordinary transport failure", context.Background(), errors.New("connection reset"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := requestDeadlineExceeded(tc.ctx, tc.err); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
