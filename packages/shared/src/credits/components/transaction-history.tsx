"use client";

/**
 * 积分交易历史组件
 *
 * 显示用户的积分交易记录表格
 */

import { ENTERPRISE_RESOURCE_PACKAGE_ID } from "@repo/shared/credits/config";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Separator } from "@repo/ui/components/separator";
import { cn } from "@repo/ui/utils";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { formatDateInTimeZone } from "../../time-zone";
import { getMyTransactions } from "../actions";
import { formatCredits } from "../format";
import {
  type CreditLedgerTransaction,
  getCreditTransactionSemantics,
  type UpgradeReservationLedgerKind,
} from "../transaction-semantics";

/**
 * 交易类型键
 */
type TransactionTypeKey =
  | "registration_bonus"
  | "admin_grant"
  | "monthly_grant"
  | "purchase"
  | "consumption"
  | "expiration"
  | "refund"
  | UpgradeReservationLedgerKind;

/**
 * 交易类型变体映射
 */
const TRANSACTION_TYPE_VARIANTS: Record<
  TransactionTypeKey,
  "default" | "secondary" | "destructive" | "outline"
> = {
  registration_bonus: "default",
  admin_grant: "default",
  monthly_grant: "default",
  purchase: "secondary",
  consumption: "destructive",
  expiration: "outline",
  refund: "secondary",
  upgrade_hold: "outline",
  upgrade_release: "secondary",
  upgrade_settlement: "outline",
  upgrade_expiration: "outline",
  upgrade_refund_hold: "outline",
  upgrade_refund_settlement: "outline",
  upgrade_refund_restore: "secondary",
};

/**
 * 格式化日期时间
 */
function formatDateTime(
  date: Date | string,
  locale: string,
  timeZone: string
): string {
  return formatDateInTimeZone(
    date,
    locale,
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    timeZone
  );
}

function getMonthlyCreditsFromMetadata(
  meta: Record<string, unknown> | null | undefined,
  amount: number,
  interval?: string
) {
  const value = meta?.monthlyCredits ?? meta?.creditsAmount;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value.toLocaleString("en-US");
  }
  const inferred = interval === "year" ? amount / 12 : amount;
  return Number.isFinite(inferred) && inferred > 0
    ? inferred.toLocaleString("en-US")
    : "";
}

/**
 * 交易历史组件
 */
export function TransactionHistory({ timeZone }: { timeZone: string }) {
  const t = useTranslations("Settings.usage.transactions");
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { execute, result, isPending } = useAction(getMyTransactions);

  // 获取交易记录
  useEffect(() => {
    execute({ limit: pageSize, offset: (page - 1) * pageSize });
  }, [execute, page, pageSize]);

  const transactions = result.data?.transactions ?? [];
  const totalCount = result.data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  /**
   * 获取交易类型标签
   */
  const getTypeLabel = (type: string): string => {
    const typeKey = type as TransactionTypeKey;
    if (typeKey in TRANSACTION_TYPE_VARIANTS) {
      return t(`types.${typeKey}`);
    }
    return type;
  };

  /**
   * 获取本地化的交易描述
   */
  const getLocalizedDescription = (
    tx: CreditLedgerTransaction & {
      description: string | null;
    }
  ): string => {
    const kind = getCreditTransactionSemantics(tx).reservationKind;
    if (kind) return t(`descriptions.${kind}`);
    const meta = tx.metadata;
    switch (tx.type) {
      case "registration_bonus":
        return t("descriptions.registration_bonus");
      case "monthly_grant": {
        const planType = (meta?.planType as string) ?? "";
        const plan = planType.charAt(0).toUpperCase() + planType.slice(1);
        const interval = meta?.interval as string;
        const monthlyCredits = getMonthlyCreditsFromMetadata(
          meta,
          tx.amount,
          interval
        );
        if (interval === "year") {
          return t("descriptions.yearly_grant", {
            plan,
            monthly: monthlyCredits,
          });
        }
        return t("descriptions.monthly_grant", { plan });
      }
      case "consumption":
        return tx.description ?? t("descriptions.consumption");
      case "expiration":
        return t("descriptions.expiration");
      case "admin_grant":
        return t("descriptions.admin_grant");
      case "purchase":
        if (meta?.packageId === ENTERPRISE_RESOURCE_PACKAGE_ID) {
          const quantity =
            typeof meta.quantity === "number" && meta.quantity > 1
              ? meta.quantity
              : null;
          return quantity
            ? `${t("descriptions.purchase")} (${quantity}x enterprise resource pack)`
            : `${t("descriptions.purchase")} (enterprise resource pack)`;
        }
        return t("descriptions.purchase");
      case "refund":
        return t("descriptions.refund");
      default:
        return tx.description ?? "-";
    }
  };

  /**
   * 获取交易类型变体
   */
  const getTypeVariant = (
    type: string
  ): "default" | "secondary" | "destructive" | "outline" => {
    const typeKey = type as TransactionTypeKey;
    return TRANSACTION_TYPE_VARIANTS[typeKey] ?? "outline";
  };

  // 空状态
  if (!isPending && transactions.length === 0) {
    return (
      <div className="space-y-4">
        {/* 标题 */}
        <div>
          <h3 className="text-lg font-semibold">{t("title")}</h3>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>

        {/* 空状态 */}
        <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg">
          <Inbox className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground">{t("noTransactions")}</p>
          <p className="text-sm text-muted-foreground/70">
            {t("noTransactionsHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 标题 */}
      <div>
        <h3 className="text-lg font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {/* 表格 */}
      <div className="rounded-lg border">
        {/* 表头 */}
        <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-muted/50 text-sm font-medium text-muted-foreground">
          <div className="col-span-3">{t("date")}</div>
          <div className="col-span-2">{t("type")}</div>
          <div className="col-span-5">{t("transactionDescription")}</div>
          <div className="col-span-2 text-right">{t("transactionAmount")}</div>
        </div>

        <Separator />

        {/* 加载状态 */}
        {isPending ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-pulse text-muted-foreground">
              {t("loading")}
            </div>
          </div>
        ) : (
          /* 表格内容 */
          <div className="divide-y">
            {transactions.map((tx) => {
              const { reservationKind, walletDelta } =
                getCreditTransactionSemantics(tx);
              const presentationType = reservationKind ?? tx.type;

              return (
                <div
                  key={tx.id}
                  className="grid grid-cols-12 gap-4 px-4 py-3 text-sm hover:bg-muted/30 transition-colors"
                >
                  {/* 日期 */}
                  <div className="col-span-3 text-muted-foreground">
                    {formatDateTime(tx.createdAt, locale, timeZone)}
                  </div>

                  {/* 类型 */}
                  <div className="col-span-2">
                    <Badge
                      variant={getTypeVariant(presentationType)}
                      className="text-xs"
                    >
                      {getTypeLabel(presentationType)}
                    </Badge>
                  </div>

                  {/* 描述 */}
                  <div
                    className="col-span-5 truncate"
                    title={getLocalizedDescription(tx)}
                  >
                    {getLocalizedDescription(tx)}
                  </div>

                  {/* 金额 */}
                  <div
                    className={cn(
                      "col-span-2 text-right font-medium",
                      walletDelta > 0
                        ? "text-success"
                        : walletDelta < 0
                          ? "text-destructive"
                          : "text-muted-foreground"
                    )}
                    title={walletDelta === 0 ? t("walletUnchanged") : undefined}
                  >
                    {walletDelta > 0 ? "+" : walletDelta < 0 ? "-" : ""}
                    {formatCredits(Math.abs(walletDelta))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <div>
          {t("showing", {
            from: Math.min((page - 1) * pageSize + 1, totalCount),
            to: Math.min(page * pageSize, totalCount),
            total: totalCount,
          })}
        </div>

        <div className="flex items-center gap-4">
          {/* 每页数量选择 */}
          <div className="flex items-center gap-2">
            <span>{t("rowsPerPage")}</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-16 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 页码信息 */}
          <span>{t("pageOf", { page, total: totalPages })}</span>

          {/* 分页按钮 */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage(1)}
              disabled={page === 1}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
