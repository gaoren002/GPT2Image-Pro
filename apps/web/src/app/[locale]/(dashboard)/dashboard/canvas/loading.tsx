/** 路由级骨架支持 Next 侧栏预取，不提前加载画布引擎或私人图片。 */
export default function CanvasLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载画布"
      className="h-[calc(100dvh-72px)] animate-pulse bg-muted/40"
    />
  );
}
