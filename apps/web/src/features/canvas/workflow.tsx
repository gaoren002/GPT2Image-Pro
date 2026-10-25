"use client";

/** 节点工作流 Tab：React Flow 编辑、账号隔离草稿与显式单节点付费执行；复用既有图片 API。 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/alert-dialog";
import { Button } from "@repo/ui/components/button";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Download, ImagePlus, Loader2, Plus, Save, Upload } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "@/i18n/routing";
import { CanvasImageShelf } from "./image-shelf";
import type { CanvasEditorProps, CanvasImageSource } from "./types";
import {
  buildWorkflowRunPlan,
  loadWorkflowDocument,
  MAX_WORKFLOW_BYTES,
  MAX_WORKFLOW_NODES,
  serializeWorkflowDocument,
  type WorkflowData,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowImage,
  workflowConnectionError,
  workflowImageSchema,
} from "./workflow-model";
import {
  type WorkflowFlowNode,
  WorkflowNodeCard,
  WorkflowUIContext,
} from "./workflow-node";
import { failureMessage, useWorkflowRuntime } from "./workflow-runtime";
import { useWorkflowDocument } from "./workflow-storage";
import "@xyflow/react/dist/style.css";

const nodeTypes = { workflow: WorkflowNodeCard };
type Confirmation = { kind: "run" | "acknowledge"; id: string };

/** 账号变化强制重建整个编辑会话，旧账号的请求、回调和草稿不会泄入新账号。 */
export function CanvasWorkflow(props: CanvasEditorProps) {
  return <WorkflowEditor key={props.userId} {...props} />;
}

/** 独立 Tab 生命周期；卸载会中止浏览器等待，但已提交的服务器任务可能继续执行。 */
function WorkflowEditor({
  userId,
  images,
  onRefreshImages,
  onContinueEditing,
}: CanvasEditorProps) {
  const store = useWorkflowDocument(userId);
  const { current, update, save } = store;
  const {
    notice,
    setNotice,
    errors,
    setErrors,
    running,
    transferring,
    active,
    mounted,
    mutate,
    updateData,
    remove,
    runNode,
    continueEditing,
  } = useWorkflowRuntime(store, { onRefreshImages, onContinueEditing });
  const [refreshing, setRefreshing] = useState(false);
  const [shelf, setShelf] = useState<{ id: string; result: boolean } | null>(
    null
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [imported, setImported] = useState<WorkflowDocument | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<WorkflowFlowNode, WorkflowEdge> | null>(
    null
  );
  const invalidConnection = useRef<string | null>(null);

  /** 验证运行计划后才打开付费确认；不提前创建任务号，也不自动启动依赖。 */
  const requestRun = useCallback(
    (id: string) => {
      try {
        const document = current();
        if (!document) return;
        buildWorkflowRunPlan(document, id, new Set(active.current.keys()));
        setConfirmation({ kind: "run", id });
      } catch (error) {
        setErrors((previous) => ({ ...previous, [id]: failureMessage(error) }));
      }
    },
    [current, active, setErrors]
  );

  /** 最近作品通过同一图片 schema 过滤，防止服务端或文件中混入外域图片地址。 */
  const safeImages = useMemo(
    () =>
      images.flatMap((image) => {
        const parsed = workflowImageSchema.safeParse(image);
        return parsed.success ? [parsed.data] : [];
      }),
    [images]
  );

  /** 为参考图/丢失确认的任务选择图片；恢复结果也只是选取已有作品，不触发生图请求。 */
  const selectImage = useCallback(
    (image: CanvasImageSource) => {
      if (!shelf || active.current.has(shelf.id)) return;
      const parsed = workflowImageSchema.safeParse(image);
      if (!parsed.success) {
        setNotice("只能选择本站近期作品");
        return;
      }
      mutate((document) => ({
        ...document,
        nodes: document.nodes.map((node) => {
          if (node.id !== shelf.id) return node;
          if (node.data.kind === "image")
            return { ...node, data: { ...node.data, image: parsed.data } };
          if (
            shelf.result &&
            node.data.kind === "generate" &&
            node.data.attempt
          )
            return {
              ...node,
              data: {
                ...node.data,
                result: parsed.data,
                attempt: { ...node.data.attempt, state: "completed" },
              },
            };
          return node;
        }),
      }));
      setShelf(null);
      setErrors((previous) => ({ ...previous, [shelf.id]: "" }));
    },
    [mutate, shelf, active, setErrors, setNotice]
  );

  /** 刷新仅请求本人作品列表；错误可见，切换账号/Tab 后不更新卸载实例。 */
  const refreshImages = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshImages();
    } catch (error) {
      if (mounted.current) setNotice(`刷新失败：${failureMessage(error)}`);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [onRefreshImages, refreshing, mounted, setNotice]);

  /** 新节点出现在当前视口内；达到数量上限时明确拒绝，不改变原图。 */
  const addNode = useCallback(
    (kind: WorkflowData["kind"]) => {
      const document = current();
      if (!document) return;
      if (document.nodes.length >= MAX_WORKFLOW_NODES) {
        setNotice(`最多创建 ${MAX_WORKFLOW_NODES} 个节点`);
        return;
      }
      const id = crypto.randomUUID();
      const bounds = host.current?.getBoundingClientRect();
      const offset = (document.nodes.length % 5) * 24;
      const position =
        bounds && flow.current
          ? flow.current.screenToFlowPosition({
              x: bounds.left + Math.max(50, bounds.width / 2 - 160) + offset,
              y: bounds.top + 90 + offset,
            })
          : { x: 60 + offset, y: 80 + offset };
      const data: WorkflowData =
        kind === "prompt"
          ? { kind, text: "" }
          : kind === "image"
            ? { kind }
            : {
                kind,
                model: "gpt-image-2.5",
                size: "1024x1024",
                quality: "medium",
              };
      update({
        ...document,
        nodes: [...document.nodes, { id, type: "workflow", position, data }],
      });
      if (kind === "image") setShelf({ id, result: false });
    },
    [current, update, setNotice]
  );

  /** 交互边和导入边共用同一合法性规则；正在运行节点的连线保持锁定。 */
  const connectionError = useCallback(
    (connection: Connection | WorkflowEdge) => {
      if (
        active.current.has(connection.source) ||
        active.current.has(connection.target)
      )
        return "正在运行节点的连线暂不能修改";
      const document = current();
      return document
        ? workflowConnectionError(document, connection)
        : "工作流尚未就绪";
    },
    [current, active]
  );
  /** 只在连接最终提交时写入图；校验失败显示原因而不创建边。 */
  const connect = useCallback(
    (connection: Connection) => {
      const error = connectionError(connection);
      if (error) {
        setNotice(error);
        return;
      }
      if (
        connection.sourceHandle !== "prompt" &&
        connection.sourceHandle !== "image"
      )
        return;
      if (
        connection.targetHandle !== "prompt" &&
        connection.targetHandle !== "image"
      )
        return;
      const edge: WorkflowEdge = {
        ...connection,
        id: crypto.randomUUID(),
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      };
      mutate((document) => ({ ...document, edges: [...document.edges, edge] }));
      setNotice("");
    },
    [connectionError, mutate, setNotice]
  );

  /** 键盘删除与拖动走同一节点锁；清理孤立边，保证下一次保存仍通过模型校验。 */
  const changeNodes = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const allowed = changes.filter(
        (change) => change.type !== "remove" || !active.current.has(change.id)
      );
      if (allowed.length !== changes.length)
        setNotice("正在运行的节点不能删除");
      mutate((document) => {
        const nodes = applyNodeChanges(allowed, document.nodes);
        const ids = new Set(nodes.map((node) => node.id));
        return {
          ...document,
          nodes,
          edges: document.edges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target)
          ),
        };
      });
    },
    [mutate, active, setNotice]
  );
  /** 运行中禁止移除输入/输出边，选中态仍可更新；串行保存会剔除这些瞬时标记。 */
  const changeEdges = useCallback(
    (changes: EdgeChange<WorkflowEdge>[]) => {
      mutate((document) => ({
        ...document,
        edges: applyEdgeChanges(
          changes.filter((change) => {
            if (change.type !== "remove") return true;
            const edge = document.edges.find((item) => item.id === change.id);
            const locked =
              edge &&
              (active.current.has(edge.source) ||
                active.current.has(edge.target));
            if (locked) setNotice("正在运行节点的连线不能删除");
            return !locked;
          }),
          document.edges
        ),
      }));
    },
    [mutate, active, setNotice]
  );

  /** 导出白名单 JSON 备份，生成的 Blob URL 立即安排释放，不在草稿里保存函数/运行态。 */
  const exportDocument = useCallback(() => {
    try {
      const document = current();
      if (!document) return;
      const url = URL.createObjectURL(
        new Blob([serializeWorkflowDocument(document)], {
          type: "application/json",
        })
      );
      const anchor = globalThis.document.createElement("a");
      anchor.href = url;
      anchor.download = "gpt2image-workflow.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setNotice(failureMessage(error));
    }
  }, [current, setNotice]);

  /** 文件读取与 IDB 恢复严格同校验；先验证后确认替换，错误文件不会清空已有草稿。 */
  const importDocument = useCallback(
    async (file: File) => {
      if (active.current.size) {
        setNotice("请等待运行结束，再导入工作流");
        return;
      }
      try {
        if (file.size > MAX_WORKFLOW_BYTES)
          throw new Error("工作流文件超过 4 MiB");
        const document = loadWorkflowDocument(await file.text());
        if (mounted.current) setImported(document);
      } catch (error) {
        if (mounted.current)
          setNotice(`导入失败，原草稿已保留：${failureMessage(error)}`);
      }
    },
    [active, mounted, setNotice]
  );

  const ui = useMemo(
    () => ({
      running,
      transferring,
      errors,
      updateData,
      requestRun,
      remove,
      chooseImage: (id: string, result = false) => setShelf({ id, result }),
      acknowledge: (id: string) => setConfirmation({ kind: "acknowledge", id }),
      continueEditing: (id: string, image: WorkflowImage) => {
        void continueEditing(id, image);
      },
    }),
    [
      running,
      transferring,
      errors,
      updateData,
      requestRun,
      remove,
      continueEditing,
    ]
  );

  if (!store.document)
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        {store.status === "loading" ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin" />
            <p>正在恢复本机工作流</p>
          </>
        ) : (
          <>
            <p className="text-destructive">{store.error}</p>
            <p className="text-sm text-muted-foreground">
              恢复失败，已有草稿保持原样，未启动自动保存。
            </p>
            <Button variant="outline" onClick={store.retry}>
              重新读取
            </Button>
          </>
        )}
      </div>
    );

  return (
    <WorkflowUIContext.Provider value={ui}>
      <div ref={host} className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          <Button variant="outline" size="sm" onClick={() => addNode("prompt")}>
            <Plus className="mr-1 h-4 w-4" />
            提示词
          </Button>
          <Button variant="outline" size="sm" onClick={() => addNode("image")}>
            <ImagePlus className="mr-1 h-4 w-4" />
            参考图
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => addNode("generate")}
          >
            <Plus className="mr-1 h-4 w-4" />
            生成节点
          </Button>
          <span className="hidden flex-1 sm:block" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void save().catch((error: unknown) =>
                setNotice(failureMessage(error))
              );
            }}
          >
            <Save className="mr-1 h-4 w-4" />
            保存
          </Button>
          <Button variant="ghost" size="sm" onClick={exportDocument}>
            <Download className="mr-1 h-4 w-4" />
            导出
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={running.size > 0}
            onClick={() => input.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />
            导入
          </Button>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="导入工作流 JSON"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importDocument(file);
            }}
          />
        </div>
        <div
          aria-live="polite"
          className="space-y-1 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          <p>
            从节点圆点拖出连线：紫色提示词接提示词，绿色图片接图片。只运行点击的生成节点；选中后按
            Delete 删除。
          </p>
          <p>
            {store.status === "saved"
              ? "已保存到本机，按账号与 Tab 隔离"
              : store.status === "saving"
                ? "正在保存本机草稿"
                : "本机草稿保存失败，请导出备份"}{" "}
            · {store.document.nodes.length}/{MAX_WORKFLOW_NODES} 节点
          </p>
          {store.error && (
            <p role="alert" className="text-destructive">
              {store.error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-foreground">
              {notice}
            </p>
          )}
          {running.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/50 p-2 text-foreground">
              <span>
                {running.size} 个节点处理中。切换 Tab /
                离开将断开等待，已提交任务可能继续执行并扣积分；返回后先查历史。
              </span>
              <Link
                href="/dashboard/history"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                查看历史
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  for (const controller of active.current.values())
                    controller.abort();
                  setNotice(
                    "已断开客户端等待；已提交任务仍可能执行，请先核对历史"
                  );
                }}
              >
                断开等待
              </Button>
            </div>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          <ReactFlow<WorkflowFlowNode, WorkflowEdge>
            edges={store.document.edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              flow.current = instance;
            }}
            onNodesChange={changeNodes}
            onEdgesChange={changeEdges}
            onConnect={connect}
            isValidConnection={(connection) => {
              const error = connectionError(connection);
              invalidConnection.current = error;
              return !error;
            }}
            onConnectStart={() => {
              invalidConnection.current = null;
            }}
            onConnectEnd={() => {
              if (invalidConnection.current)
                setNotice(invalidConnection.current);
            }}
            onMoveEnd={(_event, viewport) =>
              mutate((document) => ({ ...document, viewport }))
            }
            defaultViewport={store.document.viewport}
            fitView={!store.document.viewport}
            minZoom={0.1}
            maxZoom={2}
            deleteKeyCode={["Backspace", "Delete"]}
            nodes={store.document.nodes.map((node) => ({
              ...node,
              deletable: !running.has(node.id),
            }))}
            edgesReconnectable={false}
            aria-label="图片节点工作流画布"
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          {shelf && (
            <CanvasImageShelf
              images={safeImages}
              busy={false}
              refreshing={refreshing}
              onAdd={selectImage}
              onRefresh={() => {
                void refreshImages();
              }}
              onClose={() => setShelf(null)}
            />
          )}
        </div>
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        {confirmation && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmation.kind === "run"
                  ? "付费运行此节点"
                  : "确认已核对历史记录"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation.kind === "run"
                  ? "本次仅生成 1 张，按现有生图/编辑规则扣积分，不自动运行其他节点。离开或断线后任务可能继续执行并扣费；结果未知时请先查历史，避免重复提交。"
                  : "请确认已在历史记录核对上次任务。解锁不会取消原任务或退款；再次运行会创建新任务并按现有规则扣积分。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const action = confirmation;
                  setConfirmation(null);
                  if (action.kind === "run") {
                    void runNode(action.id);
                    return;
                  }
                  if (active.current.has(action.id)) return;
                  mutate((document) => ({
                    ...document,
                    nodes: document.nodes.map((node) =>
                      node.id === action.id &&
                      node.data.kind === "generate" &&
                      node.data.attempt?.state === "unconfirmed"
                        ? {
                            ...node,
                            data: {
                              ...node.data,
                              attempt: {
                                ...node.data.attempt,
                                state: "acknowledged",
                              },
                            },
                          }
                        : node
                    ),
                  }));
                  setErrors((previous) => ({ ...previous, [action.id]: "" }));
                }}
              >
                {confirmation.kind === "run"
                  ? "确认扣积分并运行"
                  : "已核对，允许新任务"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      <AlertDialog
        open={imported !== null}
        onOpenChange={(open) => {
          if (!open) setImported(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>用导入文件替换本机工作流？</AlertDialogTitle>
            <AlertDialogDescription>
              文件已通过节点、连线、循环和本站图片地址校验。确认后替换当前草稿；需要保留时请先取消并导出备份。导入不会执行任何生成任务。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (active.current.size) {
                  setNotice("请等待运行结束后再导入");
                  return;
                }
                if (imported) {
                  update(imported);
                  setErrors({});
                  setNotice("工作流已导入，未运行任何任务");
                  setShelf(null);
                  if (imported.viewport)
                    void flow.current?.setViewport(imported.viewport);
                  else
                    setTimeout(() => {
                      void flow.current?.fitView();
                    }, 0);
                }
                setImported(null);
              }}
            >
              确认替换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkflowUIContext.Provider>
  );
}
