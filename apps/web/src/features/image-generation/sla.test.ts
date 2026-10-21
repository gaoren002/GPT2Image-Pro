import {
  IMAGE_GENERATION_TIMEOUT_ERROR,
  IMAGE_GENERATION_WEB_TIMEOUT_ERROR,
  resolveImageGenerationTimeoutError,
} from "@repo/shared/generation-timeout";
import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  isContentSafetyRejection,
} from "./sla-classification";

describe("generation SLA error classification", () => {
  it("excludes account credit shortage from platform errors", () => {
    expect(classifyGenerationError("Insufficient credits")).toBe(
      "user_request"
    );
    expect(classifyGenerationError("积分不足: 需要 1.27，可用 0.5")).toBe(
      "user_request"
    );
  });

  it("excludes external API key quota shortage from platform errors", () => {
    expect(
      classifyGenerationError("API key quota exceeded: required 2, remaining 0")
    ).toBe("user_request");
  });

  it("classifies unsupported transparent background as a user error", () => {
    // 用户对不支持透明的模型传了 transparent,属用户参数与模型能力不匹配,切后端也救不了;
    // 不能算平台失败拖低 SLA 成功率。
    expect(
      classifyGenerationError(
        "Transparent background is not supported for this model. | invalid_value | image_generation_user_error"
      )
    ).toBe("user_request");
  });

  it("keeps pool quota exhaustion and credential failures as platform errors", () => {
    // 裸 insufficient_quota/unauthorized 来自平台自有池(上游配额耗尽/池账号 401)，
    // 不能归 user_request 从 SLA 成功率分母中剔除。
    expect(
      classifyGenerationError(
        "Upstream Images API returned HTTP 429: no available image quota | insufficient_quota"
      )
    ).toBe("platform");
    expect(classifyGenerationError("insufficient_quota")).toBe("platform");
    expect(
      classifyGenerationError(
        "Upstream Responses API returned HTTP 401: Unauthorized"
      )
    ).toBe("platform");
  });

  it("keeps invalid request parameters out of moderation errors", () => {
    expect(
      classifyGenerationError(
        "Upstream Images API returned HTTP 400: Invalid moderation value"
      )
    ).toBe("user_request");
  });

  it("classifies user-uploaded unsupported image formats as user errors", () => {
    // 客户端上传 mpo/avif(手机多图 JPEG 等)被上游 400 拒绝,带 image_generation_user_error
    // 标签。是用户输入问题,切后端也救不了,不能算平台失败拖低 SLA、更不该在后台标成"平台"。
    expect(
      classifyGenerationError(
        "Upstream Images API returned HTTP 400: Unsupported image format: mpo. | invalid_image_format | image_generation_user_error"
      )
    ).toBe("user_request");
    expect(
      classifyGenerationError(
        "Upstream Images API returned HTTP 400: Unsupported image format: avif. | invalid_image_format | image_generation_user_error"
      )
    ).toBe("user_request");
  });

  it("classifies invalid image file or mode as a user error", () => {
    expect(
      classifyGenerationError(
        "Upstream Images API returned HTTP 400: Bad request to openai: Invalid image file or mode for image 1, please check your image file."
      )
    ).toBe("user_request");
  });

  it("keeps safety refusals as moderation even when tagged image_generation_user_error", () => {
    // 审核拒绝同样带 image_generation_user_error 后缀标签;用户错标签判定必须排在审核判定
    // 之后,否则会把安全拦截误归 user_request、污染审核统计。这是顺序回归守卫。
    expect(
      classifyGenerationError(
        "Your request was rejected by the safety system. safety_violations=[sexual]. | moderation_blocked | image_generation_user_error"
      )
    ).toBe("moderation");
  });

  it("classifies updated OAI safety refusals as moderation errors", () => {
    const moderationErrors = [
      "Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID. safety_violations=[sexual].",
      "I’m sorry, but the edit request couldn’t be completed because the referenced image was flagged by the safety system.",
      "I can’t generate that exact image because the request is too sexually suggestive.",
      "I can't help create explicit sexual content.",
      "Sorry, I can’t help create that sexualized image.",
      "Sorry, I can’t create that exact cosplay photo from this reference. I can help with a safer version instead.",
      "Sorry, I can’t generate an image that includes targeted abusive text like “幹你”.",
      "Sorry, I can’t help create an image containing that abusive speech text.",
      "I’m sorry, but I can’t generate that image because it was flagged for sexual content.",
      "I’m sorry, but I couldn’t complete that image edit request as submitted.",
      "抱歉，我无法处理这张图片的增强请求，因为图像包含裸露/性暗示内容。",
      "抱歉，图像生成请求被系统拒绝了，当前无法返回生成图。",
      "抱歉，我不能保留带有人身辱骂含义的对白气泡“幹你”。",
      "抱歉，我无法按“米奇”这一受版权保护角色进行直接编辑。",
      "抱歉，这个请求包含明显性化的成人场景与穿着描写，我不能按原样生成。",
      "抱歉，这个请求因为涉及受版权保护角色的直接生成而未能通过。",
      "抱歉，这个请求里的“用笔扎自己”的画面被系统判定为涉及自伤，因此我不能直接生成该版本图像。",
      "抱歉，这个请求包含近距离打击关节、骨响惨叫等明确暴力伤害分镜，无法生成。",
    ];

    for (const error of moderationErrors) {
      expect(classifyGenerationError(error)).toBe("moderation");
      expect(isContentSafetyRejection(error)).toBe(true);
    }
  });

  it("classifies upstream image_unsafe marker as moderation, not platform", () => {
    // 上游(中转/Web)对违规图像返回的代码标记 image_unsafe:应归审核,不该淹没进平台 SLA。
    const errors = [
      "image_unsafe",
      "Upstream Images API returned HTTP 400: image_unsafe | invalid_request_error",
      '{"code":"image_unsafe","message":"The generated image was flagged."}',
    ];
    for (const error of errors) {
      expect(classifyGenerationError(error)).toBe("moderation");
      expect(isContentSafetyRejection(error)).toBe(true);
    }
  });

  it("classifies prompt/image input-limit errors as user errors (incl. code-less variants)", () => {
    const userErrors = [
      "Upstream Images API returned HTTP 400: 提示词过长 (9147 字), 最长约 4000 字, 请精简后重试。 Prompt too long (9147 chars, max ~4000). | prompt_too_long | invalid_request_error",
      "Upstream Images API returned HTTP 400: 参考图最多 6 张, 当前 9 张, 请减少。 Too many reference images (9 > 6 max). | too_many_images | invalid_request_error",
      // 无错误码、仅文案的变体(不同上游),也必须归用户错。
      "Chat input context must be no more than 30000 characters.",
      "Upstream Images API returned HTTP 400: image dimensions exceed the supported limit of 33177600 pixels | image_too_large | invalid_request_error",
    ];
    for (const error of userErrors) {
      expect(classifyGenerationError(error)).toBe("user_request");
    }
  });

  it("keeps rate-limit / concurrency errors out of user_request (they are switchable platform-side)", () => {
    // 限流是瞬时、可切换的,绝不能误判成用户错而不重试。
    for (const error of [
      "Upstream Images API returned HTTP 429: Upstream rate limit exceeded, please retry later | rate_limit_error",
      "Upstream Images API returned HTTP 429: Concurrency limit exceeded for account, please retry later | rate_limit_error",
      "ChatGPT Web conversation failed: HTTP 429 Too many requests",
    ]) {
      expect(classifyGenerationError(error)).not.toBe("user_request");
    }
  });

  it("classifies Web backend timeouts as platform errors", () => {
    expect(classifyGenerationError(IMAGE_GENERATION_WEB_TIMEOUT_ERROR)).toBe(
      "platform"
    );
    // 历史行保留旧文案时也应按平台错误重新归类。
    expect(
      classifyGenerationError(
        "Image generation timed out after 20 minutes (suspected upstream content moderation rejection; 可能为上游内容审核拒绝). The image generation fee was refunded."
      )
    ).toBe("platform");
    expect(IMAGE_GENERATION_WEB_TIMEOUT_ERROR).toBe(
      IMAGE_GENERATION_TIMEOUT_ERROR
    );
    expect(
      resolveImageGenerationTimeoutError({
        type: "pool-account",
        accountBackend: "web",
      })
    ).toBe(IMAGE_GENERATION_TIMEOUT_ERROR);
  });

  it("keeps non-Web (generic) timeouts as platform errors", () => {
    // 通用超时（codex/responses 账号、外接 API）仍算平台，不误归审核。
    expect(classifyGenerationError(IMAGE_GENERATION_TIMEOUT_ERROR)).toBe(
      "platform"
    );
  });

  it("keeps apology-only platform failures as platform errors", () => {
    const platformErrors = [
      "Sorry, the upstream service is temporarily unavailable. Please try again later.",
      "抱歉，服务暂时不可用，请稍后重试。",
      "aliyun: aliyun moderation timed out after 10000ms",
      "Content moderation failed",
      "aliyun: Aliyun moderation failed: 401",
      "aliyun: socket hang upPOST https://green-cip.ap-southeast-1.aliyuncs.com/ failed.",
      "Upstream Responses API returned HTTP 400: Error while downloading http://example.test/api/storage/generations/id/moderation/file.png. Upstream status code: 400. | invalid_value | invalid_request_error",
      "Upstream Responses API returned HTTP 400: Timeout while downloading http://example.test/api/storage/generations/id/moderation/file.png. | invalid_value | invalid_request_error",
    ];

    for (const error of platformErrors) {
      expect(classifyGenerationError(error)).toBe("platform");
      expect(isContentSafetyRejection(error)).toBe(false);
    }
  });
});
