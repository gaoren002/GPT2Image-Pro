/**
 * 验证 ChatGPT Sentinel Turnstile dx VM 的解码、输入拒绝与执行步数边界。
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  CHATGPT_TURNSTILE_VM_MAX_STEPS,
  solveChatGptTurnstileToken,
} from "./chatgpt-web-turnstile";

/** 使用与 Sentinel 相同的循环异或和 Base64 规则构造测试程序。 */
function encodeProgram(program: unknown, key: string): string {
  const keyPoints = Array.from(key);
  const encrypted = key
    ? Array.from(JSON.stringify(program), (character, index) => {
        const keyCharacter = keyPoints[index % keyPoints.length];
        if (keyCharacter === undefined) throw new Error("测试密钥不能为空");
        return String.fromCodePoint(
          (character.codePointAt(0) ?? 0) ^ (keyCharacter.codePointAt(0) ?? 0)
        );
      }).join("")
    : JSON.stringify(program);
  return Buffer.from(encrypted, "utf8").toString("base64");
}

describe("solveChatGptTurnstileToken", () => {
  it("执行简单编码程序并返回 Base64 令牌", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, "turnstile-ok"],
        [7, 3, 40],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe(
      Buffer.from("turnstile-ok", "utf8").toString("base64")
    );
  });

  it("按普通对象语义序列化 Object.create 与 Reflect.set 的结果", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, "Object"],
        [6, 41, 10, 40],
        [2, 42, "create"],
        [6, 43, 41, 42],
        [2, 44, null],
        [17, 45, 43, 44],
        [2, 46, "Reflect"],
        [6, 47, 10, 46],
        [2, 48, "set"],
        [6, 49, 47, 48],
        [2, 50, "alpha"],
        [2, 51, "one"],
        [17, 52, 49, 45, 50, 51],
        [15, 53, 45],
        [7, 3, 53],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe(
      Buffer.from('{"alpha":"one"}', "utf8").toString("base64")
    );
  });

  it("在嵌套队列中执行动态 opcode 并序列化最终对象", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [12, 40],
        [2, 41, 15],
        [6, 42, 40, 41],
        [2, 43, "Reflect"],
        [6, 44, 10, 43],
        [2, 45, "set"],
        [6, 46, 44, 45],
        [2, 47, "serialize"],
        [17, 48, 46, 40, 47, 42],
        [2, 50, "Object"],
        [6, 51, 10, 50],
        [2, 52, "create"],
        [6, 53, 51, 52],
        [2, 54, null],
        [17, 55, 53, 54],
        [2, 56, "alpha"],
        [2, 57, "one"],
        [17, 58, 46, 55, 56, 57],
        [
          22,
          59,
          [
            ["serialize", 60, 55],
            [7, 3, 60],
          ],
        ],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe(
      Buffer.from('{"alpha":"one"}', "utf8").toString("base64")
    );
  });

  it("为 opcode 24 读取的数组方法绑定原对象", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, []],
        [2, 41, "push"],
        [24, 42, 40, 41],
        [2, 43, "x"],
        [17, 44, 42, 43],
        [15, 45, 40],
        [7, 3, 45],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("WyJ4Il0=");
  });

  it("按脚本匹配结果绑定字符串 split/pop 方法", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, "/sentinel/[^/]+/sdk\\.js(?=[?#]|$)"],
        [11, 41, 40],
        [2, 42, "split"],
        [24, 43, 41, 42],
        [2, 44, "/"],
        [17, 45, 43, 44],
        [2, 46, "pop"],
        [24, 47, 45, 46],
        [17, 48, 47],
        [7, 3, 48],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("c2RrLmpz");
  });

  it("从 opcode 30 子程序返回指定寄存器", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [30, 40, 50, [[2, 50, "done"]]],
        [17, 60, 40],
        [7, 3, 60],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("ZG9uZQ==");
  });

  it("opcode 22 嵌套队列成功时不覆盖目标寄存器", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, "keep"],
        [22, 40, [[25]]],
        [7, 3, 40],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("a2VlcA==");
  });

  it("opcode 23 允许 null guard 调用子程序", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, null],
        [23, 40, 3, "called"],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("Y2FsbGVk");
  });

  it("执行 opcode 35 除法并处理结果", () => {
    const key = "sentinel-key";
    const dx = encodeProgram(
      [
        [2, 40, 9],
        [2, 41, 3],
        [35, 42, 40, 41],
        [2, 43, "quotient:"],
        [5, 43, 42],
        [7, 3, 43],
      ],
      key
    );

    expect(solveChatGptTurnstileToken(dx, key)).toBe("cXVvdGllbnQ6Mw==");
  });

  it.each([
    ["非法 Base64", "not-base64!", "key"],
    ["无法解析的 JSON", Buffer.from("not-json").toString("base64"), ""],
    ["非队列 JSON", encodeProgram({ opcode: 3 }, "key"), "key"],
    ["畸形指令", encodeProgram([null], "key"), "key"],
    ["非字符串 dx", 42, "key"],
    ["非字符串密钥", encodeProgram([[3, "ok"]], "key"), null],
  ])("拒绝%s并返回 undefined", (_name, dx, key) => {
    expect(solveChatGptTurnstileToken(dx, key)).toBeUndefined();
  });

  it("整次执行超过 20,000 步时停止且不返回迟到结果", () => {
    const noops = Array.from({ length: CHATGPT_TURNSTILE_VM_MAX_STEPS }, () => [
      25,
    ]);
    const dx = encodeProgram([...noops, [3, "too-late"]], "limit-key");

    expect(solveChatGptTurnstileToken(dx, "limit-key")).toBeUndefined();
  });

  it("允许程序在第 20,000 步产出结果", () => {
    const noops = Array.from(
      { length: CHATGPT_TURNSTILE_VM_MAX_STEPS - 1 },
      () => [25]
    );
    const dx = encodeProgram([...noops, [3, "at-limit"]], "limit-key");

    expect(solveChatGptTurnstileToken(dx, "limit-key")).toBe(
      Buffer.from("at-limit", "utf8").toString("base64")
    );
  });
});
