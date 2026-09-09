/**
 * 路由级加载骨架:提供 Suspense 边界,避免软导航在服务端组件 resolve 前阻塞
 * (否则切到本 tab 时会卡住、点其他 tab 无响应)。
 */
export default function Loading() {
  return (
    <div className="container mx-auto animate-pulse px-4 py-6 md:px-6">
      <div className="mb-8 space-y-2">
        <div className="h-9 w-48 rounded bg-muted" />
        <div className="h-4 w-72 rounded bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-40 w-full rounded-md bg-muted" />
        <div className="h-40 w-full rounded-md bg-muted" />
      </div>
    </div>
  );
}
