package main

// 保持 JSON/base64 协议，用分段写入减少大响应的完整副本；请求预留保持到发送结束。
import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
)

// encodeResponseBody 直接编码到可转为 string 的 builder，避免 []byte 再拷贝整份 string。
func encodeResponseBody(body []byte) string {
	var out strings.Builder
	out.Grow(base64.StdEncoding.EncodedLen(len(body)))
	encoder := base64.NewEncoder(base64.StdEncoding, &out)
	_, _ = encoder.Write(body) // strings.Builder 的 Write 永不返回错误。
	_ = encoder.Close()
	return out.String()
}

// writeResponse 只对小型 status/headers 做 JSON 编码；base64 字母表不需要 JSON 转义。
// 任何写入错误均停止后续发送，handler 的 defer 随即释放响应预算。
func writeResponse(w http.ResponseWriter, result *responsePayload) {
	prefix, err := json.Marshal(struct {
		Status  int                 `json:"status"`
		Headers map[string][]string `json:"headers"`
	}{result.Status, result.Headers})
	if err != nil {
		writeError(w, 502, "proxy response encoding failed")
		return
	}
	parts := []string{string(prefix[:len(prefix)-1]), `,"bodyBase64":"`, result.BodyBase64, "\"}\n"}
	var length int64
	for _, part := range parts {
		length += int64(len(part))
	}
	w.Header().Set("Content-Type", "application/json")
	// prefix 已经由 json.Marshal 完成 UTF-8 替换与 JSON 转义，len 计的是实际字节数。
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusOK)
	for _, part := range parts {
		// ResponseWriter 不一定实现 StringWriter，限制隐式 []byte 转换的临时副本。
		for len(part) > 0 {
			n := min(len(part), 32*1024)
			if _, err := io.WriteString(w, part[:n]); err != nil {
				log.Printf("write proxy response failed")
				return
			}
			part = part[n:]
		}
	}
}
