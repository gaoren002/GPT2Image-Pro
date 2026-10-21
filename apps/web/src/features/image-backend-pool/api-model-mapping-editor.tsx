/**
 * API 模型映射表编辑器：本站型号 → 上游型号，可按质量分档。
 * 后台池 API 与用户自配 API 共用；文案由 labels 注入。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  type ApiModelMappingEntry,
  type ApiModelMappingQuality,
  API_MODEL_MAPPING_QUALITIES,
  PRESET_GEMINI_IMAGE_MAPPING,
  PRESET_GPT_IMAGE_ADOBE_MAPPING,
} from "@/features/image-generation/api-model-mapping";

const QUALITY_ANY = "__any__";

export type ApiModelMappingEditorLabels = {
  title: string;
  hint: string;
  from: string;
  to: string;
  whenQuality: string;
  setQuality: string;
  anyQuality: string;
  add: string;
  presetAdobe: string;
  presetGemini: string;
  presetHint: string;
};

const DEFAULT_LABELS: ApiModelMappingEditorLabels = {
  title: "模型映射",
  hint: "把本站型号改写成上游 id。高清可单独映射并强制 quality=high。留空则按请求原样发送。",
  from: "本站型号",
  to: "上游型号",
  whenQuality: "当质量为",
  setQuality: "出站质量",
  anyQuality: "任意",
  add: "添加映射",
  presetAdobe: "填入 GPT Image -ad 预设",
  presetGemini: "填入 Gemini 预设",
  presetHint:
    "-ad 后缀上游令牌只能调 gpt-image-2-ad / gpt-image-2-high；Gemini 渠道只能调 gemini-*-ad，且不要走 /v1/images/*。",
};

function qualitySelectValue(
  value: ApiModelMappingQuality | undefined
): string {
  return value || QUALITY_ANY;
}

function parseQualitySelect(
  value: string
): ApiModelMappingQuality | undefined {
  return value === QUALITY_ANY
    ? undefined
    : (value as ApiModelMappingQuality);
}

export function ApiModelMappingEditor(props: {
  value: ApiModelMappingEntry[];
  onChange: (next: ApiModelMappingEntry[]) => void;
  disabled?: boolean;
  labels?: Partial<ApiModelMappingEditorLabels>;
}) {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const rows = props.value.length
    ? props.value
    : [{ from: "", to: "" } satisfies ApiModelMappingEntry];
  const [rowIds, setRowIds] = useState<string[]>(() =>
    rows.map(() => crypto.randomUUID())
  );
  useEffect(() => {
    setRowIds((current) => {
      if (current.length === rows.length) return current;
      if (current.length < rows.length) {
        return [
          ...current,
          ...Array.from({ length: rows.length - current.length }, () =>
            crypto.randomUUID()
          ),
        ];
      }
      return current.slice(0, rows.length);
    });
  }, [rows.length]);

  const updateRow = (index: number, patch: Partial<ApiModelMappingEntry>) => {
    const next = rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch } : row
    );
    props.onChange(next.filter((row) => row.from.trim() || row.to.trim()));
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <Label>{labels.title}</Label>
        <p className="mt-1 text-xs text-muted-foreground">{labels.hint}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled}
          onClick={() => props.onChange([...PRESET_GPT_IMAGE_ADOBE_MAPPING])}
        >
          {labels.presetAdobe}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled}
          onClick={() => props.onChange([...PRESET_GEMINI_IMAGE_MAPPING])}
        >
          {labels.presetGemini}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{labels.presetHint}</p>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div
            key={rowIds[index] ?? `mapping-${row.from}-${row.to}`}
            className="grid gap-2 rounded-md border border-border/70 p-2 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Input
              placeholder={labels.from}
              value={row.from}
              disabled={props.disabled}
              onChange={(event) =>
                updateRow(index, { from: event.target.value })
              }
            />
            <Input
              placeholder={labels.to}
              value={row.to}
              disabled={props.disabled}
              onChange={(event) =>
                updateRow(index, { to: event.target.value })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="justify-self-end text-destructive"
              disabled={props.disabled || rows.length <= 1}
              onClick={() =>
                props.onChange(rows.filter((_, rowIndex) => rowIndex !== index))
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">
                {labels.whenQuality}
              </p>
              <Select
                value={qualitySelectValue(row.whenQuality)}
                onValueChange={(value) =>
                  updateRow(index, {
                    whenQuality: parseQualitySelect(value),
                  })
                }
                disabled={props.disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={QUALITY_ANY}>
                    {labels.anyQuality}
                  </SelectItem>
                  {API_MODEL_MAPPING_QUALITIES.map((quality) => (
                    <SelectItem key={quality} value={quality}>
                      {quality}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">
                {labels.setQuality}
              </p>
              <Select
                value={qualitySelectValue(row.setQuality)}
                onValueChange={(value) =>
                  updateRow(index, {
                    setQuality: parseQualitySelect(value),
                  })
                }
                disabled={props.disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={QUALITY_ANY}>
                    {labels.anyQuality}
                  </SelectItem>
                  {API_MODEL_MAPPING_QUALITIES.map((quality) => (
                    <SelectItem key={quality} value={quality}>
                      {quality}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled}
        onClick={() => props.onChange([...rows, { from: "", to: "" }])}
      >
        <Plus className="mr-1 h-3 w-3" />
        {labels.add}
      </Button>
    </div>
  );
}

export function compactApiModelMapping(
  rows: ApiModelMappingEntry[]
): ApiModelMappingEntry[] {
  return rows
    .map((row) => ({
      from: row.from.trim(),
      to: row.to.trim(),
      ...(row.whenQuality ? { whenQuality: row.whenQuality } : {}),
      ...(row.setQuality ? { setQuality: row.setQuality } : {}),
    }))
    .filter((row) => row.from && row.to);
}
