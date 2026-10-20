/**
 * 模型计价倍率编辑器：出站模型 id → 计费倍率，每池 API 成员独立配置。
 * 动态行（模型名 + 倍率），不限定枚举；空行提交时被丢弃。
 * 值为字符串表单态；提交方负责 parseModelBillingFromForm 转换。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

export type ModelBillingRow = { model: string; multiplier: string };

export function emptyModelBillingRows(): ModelBillingRow[] {
  return [{ model: "", multiplier: "" }];
}

/** DB/列表返回的倍率表回填成表单行（保留输入顺序）。 */
export function modelBillingToRows(
  value: Record<string, number> | null | undefined
): ModelBillingRow[] {
  const rows = Object.entries(value ?? {}).map(([model, multiplier]) => ({
    model,
    multiplier: String(multiplier),
  }));
  return rows.length ? rows : emptyModelBillingRows();
}

/** 表单行 → 提交值：模型名与正倍率合法才保留；全空返回 null（清空配置）。 */
export function modelBillingFromForm(
  rows: ModelBillingRow[]
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue;
    const parsed = Number(row.multiplier);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    out[model] = parsed;
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
          className="grid grid-cols-[1fr_100px_36px] gap-2"
        >
          <Input
            value={row.model}
            placeholder="出站模型 id（精确匹配）"
            disabled={disabled}
            onChange={(event) => update(index, { model: event.target.value })}
          />
          <Input
            value={row.multiplier}
            placeholder="倍率"
            inputMode="decimal"
            disabled={disabled}
            onChange={(event) =>
              update(index, { multiplier: event.target.value })
            }
          />
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
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || rows.length >= 100}
        onClick={() => onChange([...rows, { model: "", multiplier: "" }])}
      >
        <Plus className="mr-1 h-4 w-4" />
        添加模型
      </Button>
    </div>
  );
}
