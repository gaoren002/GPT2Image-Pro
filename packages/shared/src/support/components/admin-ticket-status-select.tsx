"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@repo/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { updateTicketStatusAction } from "../actions/ticket";
import { ticketStatuses } from "../constants";

interface AdminTicketStatusSelectProps {
  /** 工单 ID */
  ticketId: string;
  /** 当前状态 */
  currentStatus: "open" | "in_progress" | "resolved" | "closed";
}

/**
 * 管理员工单状态选择组件
 *
 * 管理员可以通过此组件修改工单状态
 */
export function AdminTicketStatusSelect({
  ticketId,
  currentStatus,
}: AdminTicketStatusSelectProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState(currentStatus);

  /**
   * 状态颜色映射：单色语义体系，token 自动适配暗色。
   * open=中性待处理，in_progress=warning，resolved=success，closed=已归档灰。
   */
  const colorMap: Record<string, string> = {
    open: "bg-secondary text-foreground",
    in_progress: "bg-warning/10 text-warning",
    resolved: "bg-success/10 text-success",
    closed: "bg-muted text-muted-foreground",
  };

  /**
   * 获取状态标签
   */
  const getStatusLabel = (s: string) => {
    const statusConfig = ticketStatuses.find((item) => item.value === s);
    return statusConfig?.label || s;
  };

  /**
   * 处理状态变更
   */
  const handleStatusChange = async (newStatus: string) => {
    if (newStatus === status) return;

    setIsLoading(true);

    try {
      const result = await updateTicketStatusAction({
        ticketId,
        status: newStatus as "open" | "in_progress" | "resolved" | "closed",
      });

      if (result?.data) {
        toast.success(result.data.message);
        setStatus(newStatus as "open" | "in_progress" | "resolved" | "closed");
        router.refresh();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error("状态更新失败");
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm text-muted-foreground">更新中...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">选择新状态</p>
      <Select value={status} onValueChange={handleStatusChange}>
        <SelectTrigger className="w-full">
          <SelectValue>
            <Badge className={colorMap[status]} variant="secondary">
              {getStatusLabel(status)}
            </Badge>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ticketStatuses.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              <Badge className={colorMap[s.value]} variant="secondary">
                {s.label}
              </Badge>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
