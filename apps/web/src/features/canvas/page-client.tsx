"use client";

/** 无限画布的三种工作区；编辑器分包懒加载，切换账号时立即卸载旧文档。 */
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { GitBranch, ImageIcon, Loader2, PencilRuler } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import { useRouter } from "@/i18n/routing";
import { getCanvasImagesAction } from "./actions";
import { validateCanvasImageUrl } from "./scene-tools";
import type { CanvasImageSource } from "./types";

/** 水合只需比较固定快照，不订阅其他状态；客户端首次提交后 React 会切到 true。 */
const subscribeToHydration = () => () => undefined;
/** 浏览器后续渲染可以读取已恢复的账号状态。 */
const readClientHydration = () => true;
/** SSR 与水合首帧保持同一个占位，避免侧栏先写入共享身份时改掉 HTML 结构。 */
const readServerHydration = () => false;

/** 字体路径必须早于 SDK 模块求值设置，避免首次打开从公共 CDN 取字体。 */
const Editor = dynamic(
  async () => {
    window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
    return (await import("./editor")).CanvasEditor;
  },
  { ssr: false, loading: CanvasLoading }
);
const Workflow = dynamic(
  async () => (await import("./workflow")).CanvasWorkflow,
  { ssr: false, loading: CanvasLoading }
);

/** 占位与最终工作区同高，保持侧栏切换时布局稳定。 */
function CanvasLoading() {
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      正在加载工作区
    </div>
  );
}

/** 本地草稿不做跨设备同步；生成动作由现有创作页显式确认后才执行。 */
export function CanvasPageClient({
  userId,
  initialImages,
}: {
  userId: string;
  initialImages: CanvasImageSource[];
}) {
  return (
    <CanvasAccountWorkspace
      key={userId}
      userId={userId}
      initialImages={initialImages}
    />
  );
}

/** 服务端账号变化时重建所有本地状态；迟到刷新结果还要通过当前会话代际校验。 */
function CanvasAccountWorkspace({
  userId,
  initialImages,
}: {
  userId: string;
  initialImages: CanvasImageSource[];
}) {
  const router = useRouter();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    readClientHydration,
    readServerHydration
  );
  const params = useSearchParams();
  const [accountId] = useCreateRuntimeState<string | null | undefined>(
    "chatAccountUserId",
    undefined
  );
  const scopeRef = useRef({ accountId });
  if (scopeRef.current.accountId !== accountId)
    scopeRef.current = { accountId };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [images, setImages] = useState(initialImages);
  const [tab, setTab] = useState<"images" | "workflow" | "whiteboard">(
    "images"
  );
  const [incomingConsumed, setIncomingConsumed] = useState(false);
  const rawReference = params.get("ref");
  let incomingImage: CanvasImageSource | undefined;
  if (rawReference && !incomingConsumed) {
    try {
      const url = validateCanvasImageUrl(rawReference);
      incomingImage = {
        id: params.get("sourceId") || url,
        prompt: "从图库加入的图片",
        url,
        thumbnailUrl: url,
      };
    } catch {
      incomingImage = undefined;
    }
  }

  const refreshImages = useCallback(async () => {
    const scope = scopeRef.current;
    if (scope.accountId !== userId)
      throw new Error("账号已变更，请重新进入画布");
    const result = await getCanvasImagesAction();
    if (!alive.current || scopeRef.current !== scope) return;
    if (!result?.data) throw new Error(result?.serverError || "刷新作品失败");
    setImages(result.data);
  }, [userId]);

  const consumeIncoming = useCallback(() => {
    setIncomingConsumed(true);
    router.replace("/dashboard/canvas", { scroll: false });
  }, [router]);

  /** 对象地址仅跨一次同文档软导航，十分钟后回收；不把大图写入 sessionStorage。 */
  const continueEditing = useCallback(
    async (image: Blob) => {
      if (!alive.current || scopeRef.current.accountId !== userId)
        throw new Error("账号已切换，请重新打开画布");
      const url = URL.createObjectURL(image);
      const id = crypto.randomUUID();
      const query = new URLSearchParams({
        mode: "image",
        ref: url,
        sourceId: `canvas-${id}`,
        sourceName: "canvas.png",
        intent: id,
        sendRef: id,
      });
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      router.push(`/dashboard/create?${query.toString()}`);
    },
    [userId, router]
  );

  if (!hydrated || accountId !== userId) {
    return (
      <div
        role="status"
        className="flex h-96 items-center justify-center text-sm text-muted-foreground"
      >
        {!hydrated || accountId === undefined
          ? "正在确认账号"
          : "账号已变更，请重新进入画布"}
      </div>
    );
  }

  const sharedProps = {
    userId,
    images,
    onRefreshImages: refreshImages,
    onContinueEditing: continueEditing,
  };
  return (
    <section
      aria-label="无限画布"
      className="flex h-[calc(100dvh-72px)] min-h-[420px] flex-col overflow-hidden rounded-b-lg"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as typeof tab)}
        className="border-b px-3 py-2"
      >
        <TabsList
          aria-label="画布类型"
          className="grid w-full max-w-lg grid-cols-3"
        >
          <TabsTrigger value="images">
            <ImageIcon className="mr-1.5 h-4 w-4" />
            图片工作台
          </TabsTrigger>
          <TabsTrigger value="workflow">
            <GitBranch className="mr-1.5 h-4 w-4" />
            节点工作流
          </TabsTrigger>
          <TabsTrigger value="whiteboard">
            <PencilRuler className="mr-1.5 h-4 w-4" />
            自由白板
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div
        className="min-h-0 flex-1"
        role="tabpanel"
        aria-label={
          tab === "images"
            ? "图片工作台"
            : tab === "workflow"
              ? "节点工作流"
              : "自由白板"
        }
      >
        {tab === "workflow" ? (
          <Workflow key={`${userId}-workflow`} {...sharedProps} />
        ) : (
          <Editor
            key={`${userId}-${tab}`}
            {...sharedProps}
            workspace={tab}
            incomingImage={tab === "images" ? incomingImage : undefined}
            onIncomingImageConsumed={consumeIncoming}
          />
        )}
      </div>
    </section>
  );
}
