"use client";

/** 工作流运行生命周期：同步运行锁、提交前落盘、未知结果保护和卸载取消；由工作流 Tab 调用。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasEditorProps } from "./types";
import {
  executeWorkflowNode,
  fetchWorkflowImage,
  WorkflowExecutionError,
} from "./workflow-execution";
import {
  buildWorkflowRunPlan,
  type WorkflowData,
  type WorkflowDocument,
  type WorkflowImage,
  type WorkflowRunPlan,
} from "./workflow-model";
import type { useWorkflowDocument } from "./workflow-storage";

/** 将未知异常转为有界用户提示，不展示请求正文、图片内容或浏览器凭据。 */
export function failureMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1600)
    : "操作失败，请稍后检查";
}

/** 单个 Tab 的运行会话；只公开 UI 所需状态和动作，运行中数据从不进入持久模型。 */
export function useWorkflowRuntime(
  store: Pick<
    ReturnType<typeof useWorkflowDocument>,
    "current" | "update" | "save"
  >,
  {
    onRefreshImages,
    onContinueEditing,
  }: Pick<CanvasEditorProps, "onRefreshImages" | "onContinueEditing">
) {
  const { current, update, save } = store;
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [transferring, setTransferring] = useState<Set<string>>(new Set());
  const active = useRef(new Map<string, AbortController>());
  const transfers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    /** 浏览器级离开给出系统确认；Tab 切换的风险提示常驻运行节点和顶部横幅。 */
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!active.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    /** 主动断开只停止客户端等待，不声称撤销服务器任务或退款。 */
    const abort = () => {
      for (const controller of active.current.values()) controller.abort();
      for (const controller of transfers.current.values()) controller.abort();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", abort);
    return () => {
      mounted.current = false;
      abort();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", abort);
    };
  }, []);

  /** 一切异步回调从同步草稿 ref 取得最新图，不用闭包旧快照覆盖用户的新改动。 */
  const mutate = useCallback(
    (transform: (document: WorkflowDocument) => WorkflowDocument) => {
      const document = current();
      if (document) update(transform(document));
    },
    [current, update]
  );

  /** 锁住运行中的生成配置；其他节点仍可编辑，但提交已捕获的运行计划不随编辑改变。 */
  const updateData = useCallback(
    (id: string, data: WorkflowData) => {
      if (active.current.has(id)) {
        setNotice("此节点正在运行，暂不能修改配置或删除");
        return;
      }
      mutate((document) => ({
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === id ? { ...node, data } : node
        ),
      }));
    },
    [mutate]
  );

  /** 删除节点同时清理关联边；运行锁使用 ref，因此快速连点也不会绕过保护。 */
  const remove = useCallback(
    (id: string) => {
      if (active.current.has(id)) {
        setNotice(
          "此节点正在运行，不能删除。离开会断开等待，已提交任务可能继续执行并扣积分"
        );
        return;
      }
      mutate((document) => ({
        ...document,
        nodes: document.nodes.filter((node) => node.id !== id),
        edges: document.edges.filter(
          (edge) => edge.source !== id && edge.target !== id
        ),
      }));
    },
    [mutate]
  );

  /**
   * 同步加锁防重复点击；任务编号落盘成功才允许付费 POST。提交后失败保留 unconfirmed，
   * 只允许用户核对历史后显式解锁；完成后保存失败不会把已经收到的图片伪装成生成失败。
   */
  const runNode = useCallback(
    async (id: string) => {
      if (active.current.has(id)) return;
      const document = current();
      if (!document) return;
      let plan: WorkflowRunPlan;
      try {
        plan = buildWorkflowRunPlan(
          document,
          id,
          new Set(active.current.keys())
        );
      } catch (error) {
        setErrors((previous) => ({ ...previous, [id]: failureMessage(error) }));
        return;
      }
      const generationId = crypto.randomUUID();
      const controller = new AbortController();
      active.current.set(id, controller);
      setRunning(new Set(active.current.keys()));
      setErrors((previous) => ({ ...previous, [id]: "" }));
      setNotice("");
      try {
        const result = await executeWorkflowNode({
          plan,
          generationId,
          signal: controller.signal,
          /** 先记录未知任务状态，刷新或卸载也不会恢复成可直接重跑的按钮。 */
          beforeSubmit: async () => {
            controller.signal.throwIfAborted();
            if (!mounted.current) throw new Error("已离开工作流");
            // 显式核对或恢复出的完成态必须先按原任务编号落盘，之后才能写新编号。
            // 两次写入都受 IDB 事务保护，旧恢复稿仍不能抹掉另一页的未知任务。
            await save();
            controller.signal.throwIfAborted();
            if (!mounted.current) throw new Error("已离开工作流");
            mutate((latest) => ({
              ...latest,
              nodes: latest.nodes.map((node) => {
                if (node.id !== id || node.data.kind !== "generate")
                  return node;
                return {
                  ...node,
                  data: {
                    ...node.data,
                    result: undefined,
                    attempt: {
                      generationId,
                      state: "unconfirmed",
                      startedAt: new Date().toISOString(),
                    },
                  },
                };
              }),
            }));
            await save();
          },
        });
        if (!mounted.current) return;
        mutate((latest) => ({
          ...latest,
          nodes: latest.nodes.map((node) => {
            if (
              node.id !== id ||
              node.data.kind !== "generate" ||
              node.data.attempt?.generationId !== generationId
            )
              return node;
            return {
              ...node,
              data: {
                ...node.data,
                result,
                attempt: { ...node.data.attempt, state: "completed" },
              },
            };
          }),
        }));
        try {
          await save();
        } catch (error) {
          if (mounted.current)
            setNotice(
              `图片已返回，但本机草稿保存失败，请立即导出备份。${failureMessage(error)}`
            );
        }
        if (mounted.current)
          void onRefreshImages().catch((error: unknown) => {
            if (mounted.current)
              setNotice(
                `图片已生成，近期作品刷新失败：${failureMessage(error)}`
              );
          });
      } catch (error) {
        if (!mounted.current) return;
        const submitted =
          error instanceof WorkflowExecutionError && error.submitted;
        if (!submitted)
          mutate((latest) => ({
            ...latest,
            nodes: latest.nodes.map((node) => {
              if (
                node.id !== id ||
                node.data.kind !== "generate" ||
                node.data.attempt?.generationId !== generationId
              )
                return node;
              return {
                ...node,
                data: {
                  ...node.data,
                  attempt: { ...node.data.attempt, state: "acknowledged" },
                },
              };
            }),
          }));
        setErrors((previous) => ({
          ...previous,
          [id]: submitted
            ? `${failureMessage(error)}。请求已尝试提交，结果尚未确认；服务器可能继续执行并扣积分。请先查看历史，不要重复提交。`
            : `尚未提交生成请求：${failureMessage(error)}`,
        }));
      } finally {
        active.current.delete(id);
        if (mounted.current) setRunning(new Set(active.current.keys()));
      }
    },
    [current, mutate, onRefreshImages, save]
  );

  /** 继续编辑下载有界站内 Blob；随 Tab 卸载 abort，父组件处理创作页入口。 */
  const continueEditing = useCallback(
    async (id: string, image: WorkflowImage) => {
      if (transfers.current.has(id)) return;
      const controller = new AbortController();
      transfers.current.set(id, controller);
      setTransferring(new Set(transfers.current.keys()));
      try {
        const blob = await fetchWorkflowImage(image.url, controller.signal);
        controller.signal.throwIfAborted();
        if (mounted.current) await onContinueEditing(blob);
      } catch (error) {
        if (mounted.current)
          setErrors((previous) => ({
            ...previous,
            [id]: failureMessage(error),
          }));
      } finally {
        transfers.current.delete(id);
        if (mounted.current) setTransferring(new Set(transfers.current.keys()));
      }
    },
    [onContinueEditing]
  );

  return {
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
  };
}
