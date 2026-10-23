/** 图库分页回归：覆盖父记录展开成多图及无有效图片的边界。 */
import { describe, expect, it } from "vitest";
import { hasMoreGalleryItems } from "./gallery-pagination";

describe("hasMoreGalleryItems", () => {
  it("一条父记录的图片超过一页时仍能继续加载", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 25,
        limit: 20,
        parentCount: 1,
        totalParentCount: 1,
      })
    ).toBe(true);
  });

  it("每条父记录包含多张图时不会按父记录总数提前结束", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 40,
        limit: 20,
        parentCount: 20,
        totalParentCount: 20,
      })
    ).toBe(true);
  });

  it("已展示的子图数超过父记录总数时仍会读取剩余父记录", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 40,
        limit: 40,
        parentCount: 20,
        totalParentCount: 21,
      })
    ).toBe(true);
  });

  it("当前父记录没有有效图片但后面还有父记录时允许继续", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 0,
        limit: 20,
        parentCount: 20,
        totalParentCount: 21,
      })
    ).toBe(true);
  });

  it("全部父记录和展开图片已展示时结束，包含没有有效图片的父记录", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 25,
        limit: 40,
        parentCount: 20,
        totalParentCount: 20,
      })
    ).toBe(false);
    expect(
      hasMoreGalleryItems({
        itemCount: 0,
        limit: 40,
        parentCount: 20,
        totalParentCount: 20,
      })
    ).toBe(false);
  });

  it("成品一条记录一张图时保留原有分页行为", () => {
    expect(
      hasMoreGalleryItems({
        itemCount: 20,
        limit: 20,
        parentCount: 20,
        totalParentCount: 21,
      })
    ).toBe(true);
    expect(
      hasMoreGalleryItems({
        itemCount: 21,
        limit: 40,
        parentCount: 21,
        totalParentCount: 21,
      })
    ).toBe(false);
  });
});
