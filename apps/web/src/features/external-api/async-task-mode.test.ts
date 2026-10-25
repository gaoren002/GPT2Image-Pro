/** 异步任务模式（兼容速度马）：模式判定与响应映射的纯函数。 */
import { describe, expect, it } from "vitest";

import {
  parseAsyncParameter,
  resolveAsyncRequestMode,
  toAsyncTaskSubmission,
  toGenerationTaskModeResponse,
  toTaskModeResponse,
} from "./async-task-mode";

describe("parseAsyncParameter", () => {
  it.each([
    [true, "async"],
    ["true", "async"],
    ["1", "async"],
    [" TRUE ", "async"],
    ["task", "task"],
    ["Task", "task"],
    [false, undefined],
    ["false", undefined],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
    [1, undefined],
  ])("%j → %s", (value, expected) => {
    expect(parseAsyncParameter(value)).toBe(expected);
  });
});

describe("resolveAsyncRequestMode", () => {
  it("默认同步", () => {
    expect(
      resolveAsyncRequestMode({ keyTaskMode: false, values: [undefined, null] })
    ).toEqual({ taskMode: false, useAsync: false });
  });

  it("async=true 只开普通异步", () => {
    expect(
      resolveAsyncRequestMode({ keyTaskMode: false, values: [true, null] })
    ).toEqual({ taskMode: false, useAsync: true });
  });

  it("请求参数 task 或 URL 参数 task 开启任务模式", () => {
    expect(
      resolveAsyncRequestMode({ keyTaskMode: false, values: ["task", null] })
    ).toEqual({ taskMode: true, useAsync: true });
    expect(
      resolveAsyncRequestMode({
        keyTaskMode: false,
        values: [undefined, "task"],
      })
    ).toEqual({ taskMode: true, useAsync: true });
  });

  it("Key 开启时不带参数也走任务模式，显式 false 不能关闭", () => {
    expect(
      resolveAsyncRequestMode({ keyTaskMode: true, values: [undefined, null] })
    ).toEqual({ taskMode: true, useAsync: true });
    expect(
      resolveAsyncRequestMode({ keyTaskMode: true, values: [false, "false"] })
    ).toEqual({ taskMode: true, useAsync: true });
  });
});

describe("toAsyncTaskSubmission", () => {
  it("与速度马的受理响应一致", () => {
    expect(toAsyncTaskSubmission("gen-1")).toEqual({
      requestId: "gen-1",
      status: "processing",
    });
  });
});

describe("toTaskModeResponse", () => {
  it("处理中：进度 0、无图、无错误", () => {
    expect(toTaskModeResponse("t1", { status: "processing" })).toEqual({
      id: "t1",
      status: "processing",
      progress: 0,
      error: "",
      data: [],
    });
  });

  it("完成：图片地址放在 data[].url", () => {
    expect(
      toTaskModeResponse("t1", {
        status: "completed",
        data: [
          { url: "https://example.test/a.png", revised_prompt: "x" },
          { url: "https://example.test/b.png" },
        ],
      })
    ).toEqual({
      id: "t1",
      status: "succeeded",
      progress: 100,
      error: "",
      data: [
        { type: "image", url: "https://example.test/a.png" },
        { type: "image", url: "https://example.test/b.png" },
      ],
    });
  });

  it("纯中转只有 b64 时转成 data URI", () => {
    expect(
      toTaskModeResponse("t1", {
        status: "completed",
        data: [{ b64_json: "aW1hZ2U=" }],
      }).data
    ).toEqual([{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }]);
  });

  it("批量部分失败：已交付的图照常返回，失败原因放在 error", () => {
    expect(
      toTaskModeResponse("t1", {
        status: "failed",
        data: [{ url: "https://example.test/a.png" }],
        error: { message: "Upstream request failed" },
      })
    ).toEqual({
      id: "t1",
      status: "succeeded",
      progress: 100,
      error: "Upstream request failed",
      data: [{ type: "image", url: "https://example.test/a.png" }],
    });
  });

  it("全部失败：failed，原因单行化并截断", () => {
    const response = toTaskModeResponse("t1", {
      status: "failed",
      error: { message: `积分不足\n需要 4 ${"x".repeat(2000)}` },
    });
    expect(response.status).toBe("failed");
    expect(response.progress).toBe(0);
    expect(response.data).toEqual([]);
    expect(response.error.startsWith("积分不足 需要 4 ")).toBe(true);
    expect(response.error).toHaveLength(1000);
  });

  it("没有任何原因的失败给出兜底文案", () => {
    expect(toTaskModeResponse("t1", { status: "failed" }).error).toBe(
      "Image generation failed."
    );
  });
});

describe("toGenerationTaskModeResponse", () => {
  it("pending 映射为 processing", () => {
    expect(
      toGenerationTaskModeResponse(
        { id: "g1", status: "pending", error: null },
        null
      )
    ).toMatchObject({ id: "g1", status: "processing", progress: 0, data: [] });
  });

  it("completed 带图片地址", () => {
    expect(
      toGenerationTaskModeResponse(
        { id: "g1", status: "completed", error: null },
        "https://example.test/a.png?sig=1"
      )
    ).toEqual({
      id: "g1",
      status: "succeeded",
      progress: 100,
      error: "",
      data: [{ type: "image", url: "https://example.test/a.png?sig=1" }],
    });
  });

  it("completed 但图片已按保留策略删除：仍是 succeeded，error 说明原因", () => {
    expect(
      toGenerationTaskModeResponse(
        { id: "g1", status: "completed", error: null },
        null
      )
    ).toMatchObject({
      status: "succeeded",
      data: [],
      error: "Image is no longer available.",
    });
  });

  it("failed 带原因", () => {
    expect(
      toGenerationTaskModeResponse(
        { id: "g1", status: "failed", error: "provider request invalid" },
        null
      )
    ).toEqual({
      id: "g1",
      status: "failed",
      progress: 0,
      error: "provider request invalid",
      data: [],
    });
  });
});
