"use client";

/**
 * 即时筛选表单(客户端包装)。
 *
 * 职责:把"原生 GET form 点提交 = 浏览器整页刷新"改为客户端路由导航。
 * 管理页(如全局状态页)是 server component,筛选表单此前直接裸 <form>
 * 提交,点一次筛选整页重载(白屏 + 重滚动)。本组件拦截 submit 与受控
 * 控件的 change,经 useRouter + startTransition 低优先级导航,控件保持
 * 即时响应;URL query 语义不变(可分享/可后退)。
 *
 * 约定:子元素为原生控件(select/input/button),name 属性即 query 参数名;
 * change 即提交适用于 select 与 date;文本输入只在回车/按钮提交
 * (打字每次导航会打断输入)。
 */

import { useRouter } from "next/navigation";
import {
  type ReactNode,
  startTransition,
  useEffect,
  useRef,
  useState,
} from "react";

export function InstantFilterForm({
  basePath,
  hash,
  extraParams,
  children,
  className,
}: {
  /** 目标路由(如 /zh/dashboard/admin/status)。 */
  basePath: string;
  /** 可选锚点(提交后聚焦到该元素,如 #historical-errors)。 */
  hash?: string;
  /** 额外固定参数(每次提交都携带,如 tab=final)。 */
  extraParams?: Record<string, string>;
  /** 表单控件;name 即参数名。 */
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  // 受控镜像:select/date 变更后立即读最新 DOM 值导航(避免 useState 异步
  // 导致导航用旧值)。
  const [, setSubmitTick] = useState(0);

  const buildHref = () => {
    const form = formRef.current;
    const params = new URLSearchParams();
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        if (value) params.set(key, value);
      }
    }
    if (form) {
      const data = new FormData(form);
      for (const [key, value] of data.entries()) {
        const str = String(value).trim();
        if (str) params.set(key, str);
      }
    }
    const query = params.toString();
    return `${basePath}${query ? `?${query}` : ""}${hash ?? ""}`;
  };

  const navigate = () => {
    startTransition(() => {
      router.push(buildHref());
    });
  };

  // 受控控件(select/date)change 即提交:跳过文本类输入。
  const handleChange = (event: React.ChangeEvent<HTMLFormElement>) => {
    const target = event.target as unknown as
      | HTMLSelectElement
      | HTMLInputElement;
    if (target instanceof HTMLInputElement && target.type === "search") {
      return; // 关键词框只在提交时导航
    }
    setSubmitTick((tick) => tick + 1);
    navigate();
  };

  // 同步 URL 回退(浏览器后退恢复表单默认值)由 defaultValue 承担,
  // 服务端渲染已带当前筛选值。

  useEffect(() => {
    // noop:保持 hooks 顺序稳定(未来可在此做后退同步)
  }, []);

  return (
    <form
      ref={formRef}
      action="#"
      onSubmit={(event) => {
        event.preventDefault();
        navigate();
      }}
      onChange={handleChange}
      className={className}
    >
      {children}
    </form>
  );
}
