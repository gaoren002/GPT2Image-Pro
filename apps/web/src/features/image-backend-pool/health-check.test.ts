/**
 * 图像后端测活纯逻辑单测（DB-free）。
 *
 * 覆盖 interpretImageHealthResult（generateImage 结果 → 测活结果）与
 * classifyImageHealthError（错误文本 → 状态）的归类，不触发真实 generateImage
 * （其为函数内动态导入，模块求值无副作用）。
 */
import { describe, expect, it } from "vitest";

import {
  classifyImageHealthError,
  interpretImageHealthResult,
} from "./health-check";

describe("测活鉴权判定", () => {
  it.each([
    "HTTP 500: server_error request_id=req_3c4019e2",
    "HTTP 502: Bad Gateway Ray ID 8f40393ab2c1d4e5",
    "HTTP 503: authentication failed because authentication backend is overloaded",
    "HTTP 503: forbidden by temporary gateway policy",
  ])("5xx 正文不会变成 auth_failed：%s", (error) => {
    expect(classifyImageHealthError(error)).toBe("error");
  });
});

describe("interpretImageHealthResult", () => {
  it("does not expose upstream response text or credentials", () => {
    const result = interpretImageHealthResult(
      { error: "HTTP 502: private-metadata secret-test-key" },
      1
    );
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("private-metadata");
    expect(result.message).not.toContain("secret-test-key");
  });
  it("有 imageBase64 判为 ok", () => {
    const r = interpretImageHealthResult({ imageBase64: "abc" }, 120);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.imageReturned).toBe(true);
    expect(r.latencyMs).toBe(120);
  });

  it("有 imageUrl 或 imageOutputs 判为 ok", () => {
    expect(
      interpretImageHealthResult({ imageUrl: "https://x/a.png" }, 1).status
    ).toBe("ok");
    expect(interpretImageHealthResult({ imageOutputs: [{}] }, 1).status).toBe(
      "ok"
    );
  });

  it("无图但带 no image output 错误 → no_image", () => {
    const r = interpretImageHealthResult(
      {
        error:
          "Upstream returned no image output: 抱歉，当前环境未提供可调用的 image_generation 图像生成工具。",
      },
      80
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_image");
  });

  it("鉴权错误 → auth_failed", () => {
    expect(
      interpretImageHealthResult({ error: "HTTP 401: unauthorized" }, 5).status
    ).toBe("auth_failed");
  });

  it("超时/网络错误 → unreachable", () => {
    expect(
      interpretImageHealthResult({ error: "fetch failed" }, 5).status
    ).toBe("unreachable");
  });

  it("其他错误 → error", () => {
    expect(
      interpretImageHealthResult(
        { error: "Upstream Responses API returned HTTP 500" },
        5
      ).status
    ).toBe("error");
  });

  it("既无图也无错误 → no_image", () => {
    const r = interpretImageHealthResult({}, 5);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_image");
    expect(r.imageReturned).toBe(false);
  });
});

describe("classifyImageHealthError", () => {
  it("401/403/unauthorized → auth_failed", () => {
    expect(classifyImageHealthError("HTTP 401 unauthorized")).toBe(
      "auth_failed"
    );
    expect(classifyImageHealthError("403 Forbidden")).toBe("auth_failed");
    expect(classifyImageHealthError("invalid api key")).toBe("auth_failed");
  });

  it("无图像产出/缺工具 → no_image", () => {
    expect(
      classifyImageHealthError(
        "Upstream returned no image output: 已生成图片。"
      )
    ).toBe("no_image");
    expect(classifyImageHealthError("API returned no image data")).toBe(
      "no_image"
    );
    expect(
      classifyImageHealthError("未提供 image_generation 图像生成工具")
    ).toBe("no_image");
  });

  it("超时/连接/网络 → unreachable", () => {
    expect(classifyImageHealthError("Request timed out after 60000ms")).toBe(
      "unreachable"
    );
    expect(classifyImageHealthError("This operation was aborted")).toBe(
      "unreachable"
    );
    expect(classifyImageHealthError("fetch failed")).toBe("unreachable");
    expect(classifyImageHealthError("ECONNREFUSED")).toBe("unreachable");
    expect(classifyImageHealthError("terminated")).toBe("unreachable");
  });

  it("其他 → error", () => {
    expect(
      classifyImageHealthError("Upstream Responses API returned HTTP 502")
    ).toBe("error");
  });
});
