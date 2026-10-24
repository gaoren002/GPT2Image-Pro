import { describe, expect, it } from "vitest";

import { parseImportTokensText } from "./import-token-parser";

const jwtA = `${"a".repeat(24)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const jwtB = `${"e".repeat(24)}.${"f".repeat(48)}.${"g".repeat(48)}`;

describe("image backend import token parser", () => {
  it("rejects oversized UTF-8 input before parsing", () => {
    expect(() => parseImportTokensText("汉".repeat(12 * 1024 * 1024))).toThrow(
      /32 MiB/
    );
  });

  it("handles repeated JWT prefixes in linear time", () => {
    const start = performance.now();
    parseImportTokensText("eyJ".repeat(64_000), { plainFallback: "none" });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("does not truncate a real JWT signature containing eyJ", () => {
    const token = `eyJ${"h".repeat(30)}.${"p".repeat(150)}.abc_eyJ_suffix`;
    expect(
      parseImportTokensText(`token=${token}`, { plainFallback: "none" })
        .accessTokens
    ).toEqual([token]);
  });

  it("normalizes long quote runs without suffix-regex backtracking", () => {
    const start = performance.now();
    parseImportTokensText(`${";".repeat(100_000)}x`, {
      plainFallback: "access",
    });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("accepts a realistic bulk of long JWTs and nested RT exports", () => {
    const at = `eyJ${"a".repeat(30)}.${"b".repeat(3000)}.${"c".repeat(300)}`;
    expect(
      parseImportTokensText(Array(1000).fill(at).join("\n"), {
        plainFallback: "access",
      }).accessTokens
    ).toEqual([at]);
    expect(
      parseImportTokensText(
        '{"accounts":[{"credentials":{"refresh_token":"rt_real-123"}}]}'
      ).refreshTokens
    ).toEqual(["rt_real-123"]);
  });
  it("parses one access token per line", () => {
    const result = parseImportTokensText(`${jwtA}\n${jwtB}`, {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
    expect(result.refreshTokens).toEqual([]);
  });

  it("parses bearer access token lines with quotes and commas", () => {
    const result = parseImportTokensText(`"Bearer ${jwtA}",\nBearer ${jwtB}`, {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
  });

  it("parses access tokens from auth session JSON", () => {
    const result = parseImportTokensText(
      JSON.stringify({
        accessToken: jwtA,
        sessionToken: "not-an-access-token",
      }),
      { plainFallback: "access" }
    );

    expect(result.accessTokens).toEqual([jwtA]);
  });

  it("parses JSON arrays of access tokens", () => {
    const result = parseImportTokensText(JSON.stringify([jwtA, jwtB]), {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
  });

  it("extracts eyJ JWT access tokens regardless of separator", () => {
    const atA = `eyJ${"a".repeat(24)}.${"b".repeat(48)}.${"c".repeat(48)}`;
    const atB = `eyJ${"d".repeat(24)}.${"e".repeat(48)}.${"f".repeat(48)}`;

    // 无分隔粘连。
    expect(
      parseImportTokensText(`${atA}${atB}`, { plainFallback: "access" })
        .accessTokens
    ).toEqual([atA, atB]);

    // 非常规分隔符(竖线)。
    expect(
      parseImportTokensText(`${atA}|${atB}`, { plainFallback: "access" })
        .accessTokens
    ).toEqual([atA, atB]);

    // 混在文本里(label= / label:)。
    expect(
      parseImportTokensText(`token1=${atA}\ntoken2: ${atB}`, {
        plainFallback: "access",
      }).accessTokens
    ).toEqual([atA, atB]);
  });
});
