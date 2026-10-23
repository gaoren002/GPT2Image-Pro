/** 列表 URL 参数回归：分页必须能安全传给 SQL，日期必须为存在的日历日。 */
import { describe, expect, it } from "vitest";
import {
  getSingleGenerationListParam,
  normalizeGenerationListDate,
  normalizeGenerationListPage,
} from "./generation-list-filters";

describe("单值列表筛选", () => {
  it("保留单个字符串的原值，交由具体筛选规范化", () => {
    expect(getSingleGenerationListParam(" cat ")).toBe(" cat ");
  });

  it("忽略重复查询键及非字符串，不对数组执行trim或隐式页码转换", () => {
    const inputs: unknown[] = [["2"], ["2", "3"], 2, null, {}];
    for (const input of inputs) {
      expect(getSingleGenerationListParam(input)).toBe("");
      expect(normalizeGenerationListPage(input, 20)).toBe(1);
      expect(normalizeGenerationListDate(input)).toBe("");
    }
  });
});

describe("normalizeGenerationListPage", () => {
  it.each([undefined, "", "0", "-1", "1.01", "NaN", "Infinity"])(
    "非法页码 %s 回到第一页",
    (value) => {
      expect(normalizeGenerationListPage(value, 20)).toBe(1);
    }
  );

  it("保留合法页码，不施加产品层面的页数上限", () => {
    expect(normalizeGenerationListPage("2", 20)).toBe(2);
    expect(normalizeGenerationListPage("1000000", 20)).toBe(1_000_000);
  });

  it("拒绝整数精度溢出的页码与分页计算", () => {
    expect(normalizeGenerationListPage("9007199254740992", 20)).toBe(1);
    expect(normalizeGenerationListPage("9007199254740991", 20)).toBe(1);
  });
});

describe("normalizeGenerationListDate", () => {
  it.each([
    undefined,
    "",
    "bad",
    "2026-13-01",
    "2026-01-32",
    "2026-02-30",
    "2026-02-29",
    "2026-2-01",
    "2026-10-22T00:00:00Z",
  ])("忽略无效日历日期 %s", (value) => {
    expect(normalizeGenerationListDate(value)).toBe("");
  });

  it("保留有效日历日和闰年日期", () => {
    expect(normalizeGenerationListDate("2026-10-22")).toBe("2026-10-22");
    expect(normalizeGenerationListDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeGenerationListDate(" 2026-10-22 ")).toBe("2026-10-22");
  });
});
