/**
 * 面板共享常量与小工具(纯函数,无 store/组件依赖)。
 *
 * 职责:创作页各面板文件(text-panel/image-panel 等)与 create-page-client
 * 共用的选项表、格式化函数与 mention 触发检测。拆面板文件时抽出,
 * 避免面板文件反向 import 主组件文件造成环依赖。
 */

import { Input } from "@repo/ui/components/input";
import { useEffect, useRef } from "react";
import type {
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
} from "../types";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export const EDIT_MODEL_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "gpt-image-2.5", label: "GPT Image 2.5" },
  { value: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { value: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { value: "gpt-image-2", label: "GPT Image 2" },
  { value: "gpt-image-1.5", label: "GPT Image 1.5" },
  { value: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
] as const;

export const QUALITY_OPTIONS: Array<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  // gpt-image-2.5 系列（sunburst/flare）新增档位。
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export const MODERATION_OPTIONS: Array<{
  value: ImageModeration;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
];

export const OUTPUT_FORMAT_OPTIONS: Array<{
  value: ImageOutputFormat;
  label: string;
}> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

export function ConcurrencyNumberInput({
  id,
  value,
  max,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || disabled) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1 : -1;
      onChange(Math.min(max, Math.max(1, Math.floor(value + delta))));
    };
    // 非被动监听，确保可 preventDefault 阻止页面滚动
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [value, max, disabled, onChange]);
  return (
    <div ref={wrapperRef} className="w-full">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            Math.min(
              max,
              Math.max(1, Math.floor(Number(event.target.value) || 1))
            )
          )
        }
        className="w-full"
      />
    </div>
  );
}

export function formatMegabytes(bytes: number) {
  return `${Math.ceil(bytes / 1024 / 1024)}MB`;
}

export type MentionState = {
  open: boolean;
  start: number;
  end: number;
  query: string;
};

export function getMentionTrigger(
  text: string,
  cursor: number
): MentionState | null {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const token = match[0].trimStart();
  return {
    open: true,
    start: cursor - token.length,
    end: cursor,
    query: match[2] || "",
  };
}
