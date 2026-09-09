/**
 * 路由级加载骨架:提供 Suspense 边界,避免软导航在服务端组件 resolve 前阻塞
 * (否则切到本 tab 时会卡住、点其他 tab 无响应)。
 *
 * 规格对齐 dashboard/loading.tsx 基准:animate-pulse + rounded-md 裸块,
 * 容器不带 max-w 限制(与真实页面一致,避免骨架->内容宽度跳变);
 * 页头补衬线大标题占位(与真实页头的 font-serif text-3xl 对齐)。
 */
export default function Loading() {
  return (
    <div className="container mx-auto animate-pulse px-4 py-6 motion-reduce:animate-none md:px-6">
      <div className="mb-8 space-y-2">
        {/* 页头大标题占位(对齐设置页 font-serif text-3xl 页头) */}
        <div className="h-9 w-32 rounded-md bg-muted" />
        <div className="h-4 w-72 rounded-md bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-40 w-full rounded-md bg-muted" />
        <div className="h-40 w-full rounded-md bg-muted" />
      </div>
    </div>
  );
}
