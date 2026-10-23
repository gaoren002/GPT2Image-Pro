/**
 * 图库累计分页的终止判定，供服务端页面使用。
 * 草稿和上传图会由一条生成记录展开为多张图片，父记录计数仅供徽章使用。
 */

type GalleryPagination = {
  itemCount: number;
  limit: number;
  parentCount: number;
  totalParentCount: number;
};

/** 根据当前已展开的图片和父记录数量，判断下一页是否还有内容可读取。 */
export function hasMoreGalleryItems({
  itemCount,
  limit,
  parentCount,
  totalParentCount,
}: GalleryPagination): boolean {
  // 已取父记录内仍有被展示上限截断的图片，或后面还有未取的父记录，均不能结束。
  return itemCount > limit || parentCount < totalParentCount;
}
