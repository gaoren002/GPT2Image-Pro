/** 创建页加载骨架，供 App Router 在表单与历史缩略图加载期间占位。 */
const IMAGE_PLACEHOLDERS = [
  "image-a",
  "image-b",
  "image-c",
  "image-d",
  "image-e",
  "image-f",
];

export default function CreateLoading() {
  return (
    <div className="container mx-auto animate-pulse motion-reduce:animate-none px-4 py-6 md:px-6">
      <div className="mb-8 space-y-2">
        <div className="h-9 w-40 rounded-md bg-muted" />
        <div className="h-4 w-72 rounded-md bg-muted" />
      </div>

      <div className="mb-10 space-y-4">
        <div className="h-32 w-full rounded-md bg-muted" />
        <div className="flex items-center justify-between">
          <div className="h-9 w-40 rounded-md bg-muted" />
          <div className="h-9 w-32 rounded-md bg-muted" />
        </div>
      </div>

      <div className="space-y-4">
        <div className="h-6 w-24 rounded-md bg-muted" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
          {IMAGE_PLACEHOLDERS.map((key) => (
            <div key={key} className="aspect-square rounded-md bg-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}
