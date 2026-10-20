/**
 * 模型计价倍率编辑器：出站模型 id → 计费倍率，每池 API 成员独立配置。
 * 每行两种形态：统一倍率（数字，全质量档生效）或按质量分档
 * （{auto..max → 倍率}，命中该模型时取代成员级质量表）。
 * 值为字符串表单态；提交方负责 modelBillingFromForm 转换。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const QUALITY_LEVELS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelBillingRow = {
  model: string;
  mode: "flat" | "quality";
  /** mode=flat：统一倍率。 */
  multiplier: string;
  /** mode=quality：各质量档倍率（空串=未配置）。 */
  qualityMultipliers: Partial<Record<(typeof QUALITY_LEVELS)[number], string>>;
};

export function emptyModelBillingRows(): ModelBillingRow[] {
  return [
    {
      model: "",
      mode: "flat",
      multiplier: "",
      qualityMultipliers: {},
    },
  ];
}

/** DB/列表返回的倍率表回填成表单行。 */
export function modelBillingToRows(
  value: Record<string, number | Record<string, number>> | null | undefined
): ModelBillingRow[] {
  const rows = Object.entries(value ?? {}).map(([model, entry]) => {
    if (typeof entry === "number") {
      return {
        model,
        mode: "flat" as const,
        multiplier: String(entry),
        qualityMultipliers: {},
      };
    }
    const qualityMultipliers: ModelBillingRow["qualityMultipliers"] = {};
    for (const level of QUALITY_LEVELS) {
      const multiplier = entry?.[level];
      if (typeof multiplier === "number") {
        qualityMultipliers[level] = String(multiplier);
      }
    }
    return {
      model,
      mode: "quality" as const,
      multiplier: "",
      qualityMultipliers,
    };
  });
  return rows.length ? rows : emptyModelBillingRows();
}

const parsePositive = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** 表单行 → 提交值：模型名与倍率合法才保留；全空返回 null（清空配置）。 */
export function modelBillingFromForm(
  rows: ModelBillingRow[]
): Record<string, number | Record<string, number>> | null {
  const out: Record<string, number | Record<string, number>> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue;
    if (row.mode === "flat") {
      const multiplier = parsePositive(row.multiplier);
      if (multiplier === null) continue;
      out[model] = multiplier;
      continue;
    }
    const quality: Record<string, number> = {};
    for (const level of QUALITY_LEVELS) {
      const multiplier = parsePositive(row.qualityMultipliers[level] || "");
      if (multiplier !== null) quality[level] = multiplier;
    }
    if (Object.keys(quality).length) out[model] = quality;
  }
  return Object.keys(out).length ? out : null;
}

export function ModelBillingEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: ModelBillingRow[];
  onChange: (rows: ModelBillingRow[]) => void;
  disabled?: boolean;
}) {
  // 行 id 与数据行平行维护（同 api-model-mapping-editor 的做法）：受控输入在
  // 增删行时按 id 正确复用，不受 index 错位影响。
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

  const update = (index: number, patch: Partial<ModelBillingRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={rowIds[index]}
          className="space-y-2 rounded-md border border-border p-2"
        >
          <div className="grid grid-cols-[1fr_140px_36px] gap-2">
            <Input
              value={row.model}
              placeholder="出站模型 id（精确匹配）"
              disabled={disabled}
              onChange={(event) => update(index, { model: event.target.value })}
            />
            <Select
              value={row.mode}
              onValueChange={(value) =>
                update(index, { mode: value as ModelBillingRow["mode"] })
              }
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flat">统一倍率</SelectItem>
                <SelectItem value="quality">按质量分档</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled || rows.length <= 1}
              onClick={() =>
                onChange(
                  rows.length > 1
                    ? rows.filter((_, i) => i !== index)
                    : emptyModelBillingRows()
                )
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {row.mode === "flat" ? (
            <Input
              value={row.multiplier}
              placeholder="倍率（全部质量档）"
              inputMode="decimal"
              disabled={disabled}
              onChange={(event) =>
                update(index, { multiplier: event.target.value })
              }
            />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {QUALITY_LEVELS.map((level) => (
                <Input
                  key={level}
                  value={row.qualityMultipliers[level] || ""}
                  placeholder={`${level} x?`}
                  inputMode="decimal"
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, {
                      qualityMultipliers: {
                        ...row.qualityMultipliers,
                        [level]: event.target.value,
                      },
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || rows.length >= 100}
        onClick={() =>
          onChange([
            ...rows,
            { model: "", mode: "flat", multiplier: "", qualityMultipliers: {} },
          ])
        }
      >
        <Plus className="mr-1 h-4 w-4" />
        添加模型
      </Button>
    </div>
  );
}
