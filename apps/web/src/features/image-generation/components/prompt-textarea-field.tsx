"use client";

/**
 * 提示词输入框(独立订阅组件)。
 *
 * 职责:订阅 runtime store 的 prompt key,把高频击键限制在本组件重渲;
 * 派生布尔(promptHasText/promptHasRef)的唯一收口也在此(父级各处 setter
 * 写入 store 后经本订阅回流,不需要每个写入点重复同步)。
 * 从 create-page-client 拆出供 TextPanel 等面板文件复用。
 */

import { Textarea } from "@repo/ui/components/textarea";
import { useEffect } from "react";
import {
  useCreateRuntimeAccessor,
  useCreateRuntimeState,
} from "@/features/image-generation/create-runtime-store";

const PROMPT_IMAGE_REFERENCE_PATTERN = /@(?:第)?\d+轮图\d+|@图\d+/;

function hasPromptImageReference(text: string) {
  return PROMPT_IMAGE_REFERENCE_PATTERN.test(text);
}

type PromptTextareaFieldProps = Omit<
  React.ComponentProps<typeof Textarea>,
  "value" | "onChange" | "defaultValue"
> & {
  /** runtime store 里的提示词 key(如 "chatPrompt")。 */
  promptKey: string;
  /** 键入回调(新值, 光标位置),用于 mention 触发检测;不要在此做重活。 */
  onValueChange?: (next: string, selectionStart: number) => void;
  /** 转发给内部 textarea 的 ref(mention 插入后恢复焦点/光标用)。 */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
};

/**
 * 提示词输入框:独立订阅 runtime store 的 promptKey,把"每次击键"的重渲
 * 限制在本小组件内。
 *
 * WHY:CreatePageClient 是近万行单组件,输入框若由它受控,每个字符都会
 * 重建整棵创作页 JSX(实测打字卡的主因之一)。下沉后父组件改用
 * useCreateRuntimeAccessor 非订阅读写,任何一方写 promptKey(键入、发送后
 * 清空、mention 插入)都经同一 store 汇合,不存在双份状态。
 *
 * 同时单点维护两个派生布尔 key(`${promptKey}HasText` / `${promptKey}HasRef`),
 * 供父组件的发送按钮 disabled 与"@ 引用路由提示"订阅——它们只在翻转时
 * 变化(store 的 Object.is 短路),父组件不会因逐字输入而重渲。
 */

export function PromptTextareaField({
  promptKey,
  onValueChange,
  textareaRef,
  ...textareaProps
}: PromptTextareaFieldProps) {
  const [value, setValue] = useCreateRuntimeState<string>(promptKey, "");
  const [, setHasText] = useCreateRuntimeAccessor<boolean>(
    `${promptKey}HasText`,
    false
  );
  const [, setHasRef] = useCreateRuntimeAccessor<boolean>(
    `${promptKey}HasRef`,
    false
  );
  // 派生布尔的唯一收口:父组件各处 setter(清空/插入 mention)也会经
  // 本订阅回流到这里,不需要在每个写入点重复同步。
  useEffect(() => {
    setHasText(Boolean(value.trim()));
    setHasRef(hasPromptImageReference(value));
  }, [setHasRef, setHasText, value]);
  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        onValueChange?.(next, event.target.selectionStart ?? next.length);
      }}
      {...textareaProps}
    />
  );
}
