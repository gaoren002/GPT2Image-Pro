import { describe, expect, it, vi } from "vitest";

// 让分类函数 DB-free:运行时设置一律返回默认值(避免 classifyFailure 经
// isUnrecoverableBackendError 去查 system_setting 表)。只调纯函数的用例不受影响。
vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: () => {},
  getRuntimeSettingJson: async (_key: string, def?: unknown) => def ?? null,
  getRuntimeSettingNumber: async (_key: string, def?: number) => def ?? 0,
  getRuntimeSettingString: async (_key: string, def?: string) => def ?? "",
}));

async function loadClassifier() {
  process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
  const service = await import("./service");
  return service.isImageBackendSwitchableError;
}

async function loadService() {
  process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
  return import("./service");
}

describe("image backend error classification", () => {
  it("treats transient connection termination as switchable", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(isImageBackendSwitchableError("terminated")).toBe(true);
    expect(
      isImageBackendSwitchableError("TypeError: terminated at Fetch.onAborted")
    ).toBe(true);
    expect(isImageBackendSwitchableError("socket hang up")).toBe(true);
    expect(isImageBackendSwitchableError("other side closed")).toBe(true);
  });

  it("does not switch accounts after the global request timeout aborts", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError("The operation was aborted due to timeout")
    ).toBe(false);
  });

  it("switches accounts for Web quota exhaustion text returned with HTTP 200", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(isImageBackendSwitchableError("The quota has been exceeded.")).toBe(
      true
    );
  });

  it("switches accounts when Responses finishes without a final image", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "Upstream returned no image output: 已生成图片。"
      )
    ).toBe(true);
  });

  it("switches accounts when Web returns the uploaded input as output", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "ChatGPT Web backend returned input image as output"
      )
    ).toBe(true);
  });

  it("switches accounts for Codex Responses 429 usage limits", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "Upstream Responses API returned HTTP 429: The usage limit has been reached | usage_limit_reached"
      )
    ).toBe(true);
    expect(
      isImageBackendSwitchableError(
        "Upstream Responses API returned HTTP 429: Rate limit exceeded"
      )
    ).toBe(true);
  });

  it("does not switch accounts for Codex Responses invalid input 400s", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "Upstream Responses API returned HTTP 400: The image data you provided does not represent a valid image. Please check your input and try again. | invalid_value | invalid_request_error"
      )
    ).toBe(false);
    expect(
      isImageBackendSwitchableError(
        "Upstream Responses API returned HTTP 400: Error while downloading file. Upstream status code: 502. | invalid_value | invalid_request_error"
      )
    ).toBe(false);
  });

  it("treats token-count download 429 as switchable, not a user error", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    // count_token 失败：上游为算 token 下载我方图片被限流(429)，属瞬时，应可切后端。
    expect(
      isImageBackendSwitchableError(
        "Upstream Responses API returned HTTP 500: error getting file type: failed to download file, status code: 429 (request id: x) | count_token_failed | new_api_error"
      )
    ).toBe(true);
    // 5xx/超时同理。
    expect(
      isImageBackendSwitchableError(
        "error getting file type: failed to download file, status code: 522 | count_token_failed"
      )
    ).toBe(true);
    // 但客户端原因(403/坏链)仍算用户错、不切换。
    expect(
      isImageBackendSwitchableError(
        "error getting file type: failed to download file, status code: 403 | count_token_failed"
      )
    ).toBe(false);
  });

  it("treats resolution/size and invalid-image errors as user errors (not switchable)", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    for (const err of [
      "Upstream Images API returned HTTP 400: Invalid mask image format - mask size does not match image size | invalid_mask_image_format",
      "Upstream Responses API returned HTTP 400: unsupported size 1234x5678",
      "Upstream Responses API returned HTTP 400: invalid resolution",
      "Upstream Images API returned HTTP 400: not a valid image",
      "Upstream Images API returned HTTP 400: unsupported image format",
      "Upstream Images API returned HTTP 400: Bad request to openai: Invalid image file or mode for image 1, please check your image file.",
    ]) {
      expect(isImageBackendSwitchableError(err)).toBe(false);
    }
  });

  it("marks image-generation-disabled backends (403 permission) switchable and as error", async () => {
    const svc = await loadService();
    const err =
      "Upstream Responses API returned HTTP 403: Image generation is not enabled for this group | permission_error";

    expect(svc.isImageGenDisabledBackendError(err)).toBe(true);
    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("error");
  });

  it("限流的亚秒级上游重置(15ms)被冷却地板抬到至少 ~60s,而非形同无冷却", async () => {
    const svc = await loadService();
    const err =
      "Rate limit reached for gpt-image-2-codex (for limit gpt-image) in organization org-X on input-images per min: Limit 4000, Used 4000, Requested 1. Please try again in 15ms. | rate_limit_exceeded | input-images";
    // 上游/中转把 "try again in 15ms" 传成 retryAfterSeconds=0.015;无地板时冷却≈15ms。
    const failure = await svc.classifyFailure(err, {
      retryAfterSeconds: 0.015,
    });
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
    const remainMs = (failure.cooldownUntil as Date).getTime() - Date.now();
    // 地板 60s,留抖动余量按 ≥55s 断言。
    expect(remainMs).toBeGreaterThanOrEqual(55_000);
  });

  it("switches accounts when the backend lacks an image_generation tool", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    // 上游模型没有图像工具、只回文字：应可切换到别的后端（而非当场失败）。
    expect(
      isImageBackendSwitchableError(
        "Upstream returned no image output: 抱歉，当前环境未提供可调用的 image_generation 图像生成工具，因此我无法直接返回生成后的图片。"
      )
    ).toBe(true);
    expect(
      isImageBackendSwitchableError(
        "Upstream returned no image output: Sorry, the image_generation tool is not available in this environment."
      )
    ).toBe(true);
  });

  it("classifies missing image tool only when capability is absent", async () => {
    const { isMissingImageToolBackendError } = await loadService();

    // 命中：缺图像工具/不可用。
    expect(
      isMissingImageToolBackendError(
        "抱歉，当前环境未提供可调用的 image_generation 图像生成工具。"
      )
    ).toBe(true);
    expect(
      isMissingImageToolBackendError(
        "the image_generation tool is not available"
      )
    ).toBe(true);
    // 不命中：真正的内容拒绝（无图像工具字样），保持用户拒绝语义、不切换。
    expect(
      isMissingImageToolBackendError(
        "抱歉，图像生成请求被系统拒绝了，当前无法返回生成图。"
      )
    ).toBe(false);
    expect(
      isMissingImageToolBackendError(
        "Upstream returned no image output: 已生成图片。"
      )
    ).toBe(false);
    expect(isMissingImageToolBackendError("I can't help with that.")).toBe(
      false
    );
  });

  it("does not switch accounts for user safety rejections", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "Your request was rejected by the safety system."
      )
    ).toBe(false);
    expect(
      isImageBackendSwitchableError(
        "I can't help create explicit sexual content."
      )
    ).toBe(false);
    expect(
      isImageBackendSwitchableError(
        "Sorry, I can’t create that exact cosplay photo from this reference. I can help with a safer version instead."
      )
    ).toBe(false);
    expect(
      isImageBackendSwitchableError(
        "抱歉，图像生成请求被系统拒绝了，当前无法返回生成图。"
      )
    ).toBe(false);
    expect(isImageBackendSwitchableError("image_generation_user_error")).toBe(
      false
    );
    // 上游 image_unsafe 标记=用户内容拒绝(审核):不可换号(换后端也救不了)。
    expect(
      isImageBackendSwitchableError(
        "Upstream Images API returned HTTP 400: image_unsafe | invalid_request_error"
      )
    ).toBe(false);
  });

  it("does not switch (no retry) for prompt/image input-limit user errors (incl. code-less)", async () => {
    const isImageBackendSwitchableError = await loadClassifier();
    // 用户输入超限:切后端也救不了 → 不可换号、不重试、直接报。含无错误码、仅文案的变体。
    for (const error of [
      "Upstream Images API returned HTTP 400: 提示词过长 (9147 字), 最长约 4000 字。 Prompt too long. | prompt_too_long | invalid_request_error",
      "Upstream Images API returned HTTP 400: Too many reference images (9 > 6 max). | too_many_images | invalid_request_error",
      "Chat input context must be no more than 30000 characters.",
      "参考图最多 6 张, 当前 9 张, 请减少。",
      "Upstream Images API returned HTTP 400: image dimensions exceed the supported limit of 33177600 pixels | image_too_large | invalid_request_error",
    ]) {
      expect(isImageBackendSwitchableError(error)).toBe(false);
    }
  });

  it("keeps rate-limit / concurrency errors switchable (must retry, not a user error)", async () => {
    const isImageBackendSwitchableError = await loadClassifier();
    // 限流是瞬时、可切换的:不能因 'exceeded' / 'too many' 字样误判成用户错而不重试。
    expect(
      isImageBackendSwitchableError(
        "Upstream Images API returned HTTP 429: Upstream rate limit exceeded, please retry later | rate_limit_error"
      )
    ).toBe(true);
    expect(
      isImageBackendSwitchableError(
        "Upstream Images API returned HTTP 429: Concurrency limit exceeded for account, please retry later | rate_limit_error"
      )
    ).toBe(true);
  });

  it("marks group-disabled backends (403 GROUP_DISABLED) switchable and as error", async () => {
    const svc = await loadService();
    // 2026-06-10 事故文案：中转把整组 API Key 停用，确定性坏配置。
    const err =
      "Upstream Images API returned HTTP 403: API Key 所属分组已停用 | GROUP_DISABLED";

    expect(svc.isGroupDisabledBackendError(err)).toBe(true);
    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("error");
  });

  it("treats unmatched novel errors as unclassified (eligible for limited switching)", async () => {
    const svc = await loadService();

    // 未命中任何白名单/用户错/本地超时的新形态错误：未分类，重试循环允许有限次切换。
    expect(
      svc.isUnclassifiedBackendError(
        "Upstream Images API returned HTTP 418: some brand new upstream failure"
      )
    ).toBe(true);
    // 已被白名单记录的可切换错误：不算未分类。
    expect(svc.isUnclassifiedBackendError("fetch failed")).toBe(false);
    expect(
      svc.isUnclassifiedBackendError(
        "Upstream Images API returned HTTP 403: API Key 所属分组已停用 | GROUP_DISABLED"
      )
    ).toBe(false);
    // 用户请求错误与本地超时 abort：不算未分类，维持当场失败语义。
    expect(
      svc.isUnclassifiedBackendError(
        "Your request was rejected by the safety system."
      )
    ).toBe(false);
    expect(
      svc.isUnclassifiedBackendError("The operation was aborted due to timeout")
    ).toBe(false);
  });

  it("把 ChatGPT 画图工具限流当作可切换错误(换号重试)", async () => {
    const isImageBackendSwitchableError = await loadClassifier();

    expect(
      isImageBackendSwitchableError(
        "ChatGPTAgentToolRateLimitException you were unable to invoke the image_gen.text2im tool right now"
      )
    ).toBe(true);
  });

  it("把 ChatGPT Web Temporal RPCError 当作临时平台错误(换号重试)", async () => {
    const svc = await loadService();
    const err =
      "RPCError Encountered exception: <class 'temporalio.service.RPCError'>.";

    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    expect(svc.isUnclassifiedBackendError(err)).toBe(false);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("active");
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
  });

  it("把 ChatGPT 画图工具限流归类为 limited + 短冷却(默认 3 分钟)", async () => {
    const svc = await loadService();

    const failure = await svc.classifyFailure(
      "ChatGPTAgentToolRateLimitException you were unable to invoke the image_gen.text2im tool right now. You've hit the Free plan limit for image generation."
    );
    expect(failure.status).toBe("limited");
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
    const remainMs = (failure.cooldownUntil as Date).getTime() - Date.now();
    // 默认 3 分钟工具桶(mock 下 getRuntimeSettingNumber 回退到传入的 keyFallback=3)。
    expect(remainMs).toBeGreaterThan(2 * 60_000);
    expect(remainMs).toBeLessThanOrEqual(3 * 60_000 + 5_000);
  });

  it("工具限流不被误判为用户错或缺图像工具(应当换号而非当场失败)", async () => {
    const svc = await loadService();
    const err =
      "ChatGPTAgentToolRateLimitException you were unable to invoke the image_gen.text2im tool right now";
    expect(svc.isMissingImageToolBackendError(err)).toBe(false);
  });

  it("从工具限流文案解析出真实重置时间(21h26m)作为冷却,而非回落 3 分钟", async () => {
    const svc = await loadService();
    // 上游 ChatGPTAgentToolRateLimitException 的完整文案,含 "resets in 21 hours and 26 minutes"。
    const err = `ChatGPTAgentToolRateLimitException Before doing anything else, explicitly explain to the user that you were unable to invoke the image_gen.text2im tool right now. Make sure to begin your response with "You've hit the Free plan limit for image generations requests. You can create more images when the limit resets in 21 hours and 26 minutes.". DO NOT UNDER ANY CIRCUMSTANCES retry using this tool until the next user message.`;
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("limited");
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
    const remainMin =
      ((failure.cooldownUntil as Date).getTime() - Date.now()) / 60_000;
    // 应解析出 21h26m ≈ 1286 分钟(parseDurationMs 把 hours 的 h、minutes 的 m 当单位),
    // 而不是 3 分钟兜底;留少量时钟漂移余量。
    expect(remainMin).toBeGreaterThan(21 * 60);
    expect(remainMin).toBeLessThan(22 * 60);
  });

  it("识别无异常名的英文 ChatGPT 生图额度终稿并按真实重置时间冷却", async () => {
    const svc = await loadService();
    const err =
      "You've hit the Free plan limit for image generation requests. You can create more images when the limit resets in 22 hours.";

    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("limited");
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
    const remainMin =
      ((failure.cooldownUntil as Date).getTime() - Date.now()) / 60_000;
    expect(remainMin).toBeGreaterThan(21 * 60 + 55);
    expect(remainMin).toBeLessThanOrEqual(22 * 60);
  });

  it("把中文 ChatGPT 生图额度上限归类为 limited,并按文案中的小时数冷却", async () => {
    const svc = await loadService();
    const err =
      "你已达到 Free 套餐的图像生成请求上限。上限将在 22小时 后重置。";

    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("limited");
    expect(failure.cooldownUntil).toBeInstanceOf(Date);
    const remainMin =
      ((failure.cooldownUntil as Date).getTime() - Date.now()) / 60_000;
    expect(remainMin).toBeGreaterThan(21 * 60 + 55);
    expect(remainMin).toBeLessThanOrEqual(22 * 60);
  });

  it("中文额度提示即使包含无法调用图像工具,也不归为缺少工具的永久错误", async () => {
    const svc = await loadService();
    const err =
      "ChatGPTAgentToolRateLimitException：目前无法调用图像生成工具。你已达到 Free 套餐的图像生成请求上限，上限将在 21小时26分钟后重置。";

    expect(svc.isMissingImageToolBackendError(err)).toBe(false);
    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("limited");
    const remainMin =
      ((failure.cooldownUntil as Date).getTime() - Date.now()) / 60_000;
    expect(remainMin).toBeGreaterThan(21 * 60 + 20);
    expect(remainMin).toBeLessThanOrEqual(21 * 60 + 26);
  });

  it("从中文文件上传 429 文案解析真实重试小时数", async () => {
    const svc = await loadService();
    const err =
      "ChatGPT Web file upload failed (429)：你已达到文件上传上限。请23小时内重试。";

    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("active");
    const remainMin =
      ((failure.cooldownUntil as Date).getTime() - Date.now()) / 60_000;
    expect(remainMin).toBeGreaterThan(22 * 60 + 55);
    expect(remainMin).toBeLessThanOrEqual(23 * 60);
  });

  it("上游不可用 502(service temporarily unavailable)标 error 踢出,且仍可换号重试", async () => {
    const svc = await loadService();
    const err =
      "Upstream Images API returned HTTP 502: Upstream service temporarily unavailable";
    const failure = await svc.classifyFailure(err);
    // 粘性踢出轮换(error 不被 failureCooldownEnabled 门控)。
    expect(failure.status).toBe("error");
    expect(failure.cooldownUntil).toBeNull();
    // 当次请求仍可切换到下一个后端重试。
    expect(svc.isImageBackendSwitchableError(err)).toBe(true);
  });

  it("504 HTML response body(baseUrl 指向非 OpenAI 兼容端点)同样标 error", async () => {
    const svc = await loadService();
    const err =
      "Upstream Images API returned HTTP 504: HTML response body. Check that the API base URL points to an OpenAI-compatible endpoint.";
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("error");
    expect(failure.cooldownUntil).toBeNull();
  });
});

describe("always_active failure handling (resolveAlwaysActiveFailure)", () => {
  it("常驻后端遇 502/HTML 等 dead-relay 终态错误不被自动标 error 踢出", async () => {
    const svc = await loadService();
    // 复现：常驻 relay 撞到「HTTP 502: HTML response body」——classifyFailure 判终态 error。
    const err =
      "Upstream Images API returned HTTP 502: HTML response body. Check that the API base URL points to an OpenAI-compatible /v1 endpoint.";
    const failure = await svc.classifyFailure(err);
    expect(failure.status).toBe("error");
    // 常驻：豁免——返回空对象，不写 status（不踢出，避免触发"没有可用的默认生图后端"）。
    expect(svc.resolveAlwaysActiveFailure(true, failure)).toEqual({});
  });

  it("非常驻后端的终态错误照常踢出（原样保留 status='error'）", async () => {
    const svc = await loadService();
    const failure = { status: "error", cooldownUntil: null };
    expect(svc.resolveAlwaysActiveFailure(false, failure)).toBe(failure);
  });

  it("常驻后端的临时错误同样不下线", async () => {
    const svc = await loadService();
    const failure = { status: "limited", cooldownUntil: new Date(0) };
    expect(svc.resolveAlwaysActiveFailure(true, failure)).toEqual({});
  });
});

// 注:account 不走 memberAllowedForPhase——其车道由自身 implementationMode 天然决定
// (见 service.ts 账号过滤注释);此处 memberAllowedForPhase 仅用于 api/adobe(无固有类型)。
describe("memberAllowedForPhase (api/adobe 按分组车道隔离)", () => {
  it("mixed 分组不限车道，任何偏好都参与（谁都可请求）", async () => {
    const svc = await loadService();
    expect(svc.memberAllowedForPhase("mixed", "web", false)).toBe(true);
    expect(svc.memberAllowedForPhase("mixed", "responses", false)).toBe(true);
    expect(svc.memberAllowedForPhase("mixed", undefined, false)).toBe(true);
  });

  it("web 分组的 adobe 仅在 web 偏好阶段参与", async () => {
    const svc = await loadService();
    expect(svc.memberAllowedForPhase("web", "web", false)).toBe(true);
    expect(svc.memberAllowedForPhase("web", "responses", false)).toBe(false);
  });

  it("responses(codex)分组的 adobe 仅在 codex 阶段参与，web 偏求不再漏过来", async () => {
    const svc = await loadService();
    expect(svc.memberAllowedForPhase("responses", "responses", false)).toBe(
      true
    );
    // 复现本次问题：web 偏好请求不应再漏到 codex 车道的 adobe（cFnHu 移到 codex 子组后）。
    expect(svc.memberAllowedForPhase("responses", "web", false)).toBe(false);
  });

  it("firefly 请求或请求无偏好时不受车道限制", async () => {
    const svc = await loadService();
    expect(svc.memberAllowedForPhase("responses", "web", true)).toBe(true);
    expect(svc.memberAllowedForPhase("web", undefined, false)).toBe(true);
  });

  it("codex 阶段 codex/mixed 分组的 API 参与——阶段只看车道,不再被 responses 端点能力卡掉(回归)", async () => {
    const svc = await loadService();
    // 修复前 codex 阶段用 requiresResponsesEndpoint 把 images 端点 API 挡在门外;现在阶段
    // 参与纯由车道决定(端点能力是 requestKind 维度的独立筛选,见 api-interface-mode.test)。
    expect(svc.memberAllowedForPhase("responses", "responses", false)).toBe(
      true
    );
    expect(svc.memberAllowedForPhase("mixed", "responses", false)).toBe(true);
    // web 分组的 API 不漏到 codex 阶段。
    expect(svc.memberAllowedForPhase("web", "responses", false)).toBe(false);
  });
});

describe("isWebCapacityWaitCandidate (满并发短等候选判定)", () => {
  it("web 偏好下,非常驻 web 账号/API 满并发时值得短等", async () => {
    const svc = await loadService();
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "account", alwaysActive: false },
        "web",
        true
      )
    ).toBe(true);
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "api", alwaysActive: false },
        "web",
        true
      )
    ).toBe(true);
  });

  it("常驻满并发不触发短等(常驻不计入 web 可用候选)", async () => {
    const svc = await loadService();
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "account", alwaysActive: true },
        "web",
        true
      )
    ).toBe(false);
  });

  it("adobe 不在短等集(短等仅针对 web 账号 / web API)", async () => {
    const svc = await loadService();
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "adobe", alwaysActive: false },
        "web",
        true
      )
    ).toBe(false);
  });

  it("未满并发(有空)则无需短等", async () => {
    const svc = await loadService();
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "account", alwaysActive: false },
        "web",
        false
      )
    ).toBe(false);
  });

  it("非 web 阶段(codex / 无偏好)不短等", async () => {
    const svc = await loadService();
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "account", alwaysActive: false },
        "responses",
        true
      )
    ).toBe(false);
    expect(
      svc.isWebCapacityWaitCandidate(
        { type: "account", alwaysActive: false },
        undefined,
        true
      )
    ).toBe(false);
  });
});
