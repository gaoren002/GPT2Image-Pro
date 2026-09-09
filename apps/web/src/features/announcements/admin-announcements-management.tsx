"use client";

import {
  Archive,
  Loader2,
  Megaphone,
  Pencil,
  Pin,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  createAnnouncementAction,
  deleteAnnouncementAction,
  getAdminAnnouncementsAction,
  toggleAnnouncementPublishAction,
  updateAnnouncementAction,
  type AdminAnnouncementItem,
} from "@repo/shared/announcements";
import {
  announcementSeverities,
  type AnnouncementSeverity,
} from "@repo/shared/announcements/schemas";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { cn } from "@repo/ui/utils";

type AnnouncementFormState = {
  id?: string;
  title: string;
  content: string;
  severity: AnnouncementSeverity;
  isPublished: boolean;
  isPinned: boolean;
  priority: number;
  publishedAt: string;
  expiresAt: string;
};

const emptyForm: AnnouncementFormState = {
  title: "",
  content: "",
  severity: "info",
  isPublished: false,
  isPinned: false,
  priority: 0,
  publishedAt: "",
  expiresAt: "",
};

function toInputDateTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function formatDateTime(value?: string | null, timeZone?: string) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// 等级配色走语义 token（success/warning/destructive），普通为中性灰；token 自动适配暗色。
function getSeverityMeta(severity: string) {
  switch (severity) {
    case "success":
      return {
        label: "更新",
        className: "bg-success/10 text-success",
      };
    case "warning":
      return {
        label: "重要",
        className: "bg-warning/10 text-warning",
      };
    case "critical":
      return {
        label: "紧急",
        className: "bg-destructive/10 text-destructive",
      };
    default:
      return {
        label: "普通",
        className: "bg-secondary text-foreground",
      };
  }
}

function isActiveAnnouncement(item: AdminAnnouncementItem) {
  const now = Date.now();
  const publishedAt = item.publishedAt
    ? new Date(item.publishedAt).getTime()
    : 0;
  const expiresAt = item.expiresAt
    ? new Date(item.expiresAt).getTime()
    : Number.POSITIVE_INFINITY;
  return item.isPublished && publishedAt <= now && expiresAt > now;
}

function formFromAnnouncement(
  item: AdminAnnouncementItem
): AnnouncementFormState {
  const severity = announcementSeverities.some(
    (option) => option.value === item.severity
  )
    ? (item.severity as AnnouncementSeverity)
    : "info";

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    severity,
    isPublished: item.isPublished,
    isPinned: item.isPinned,
    priority: item.priority,
    publishedAt: toInputDateTime(item.publishedAt),
    expiresAt: toInputDateTime(item.expiresAt),
  };
}

export function AdminAnnouncementsManagement({
  initialAnnouncements,
  timeZone,
}: {
  initialAnnouncements: AdminAnnouncementItem[];
  timeZone?: string;
}) {
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementFormState>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const active = announcements.filter(isActiveAnnouncement).length;
    const drafts = announcements.filter((item) => !item.isPublished).length;
    const pinned = announcements.filter((item) => item.isPinned).length;
    return { active, drafts, pinned };
  }, [announcements]);

  const refresh = async () => {
    const result = await getAdminAnnouncementsAction();
    if (result?.data?.announcements) {
      setAnnouncements(result.data.announcements);
    }
  };

  const openCreate = () => {
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (item: AdminAnnouncementItem) => {
    setForm(formFromAnnouncement(item));
    setDialogOpen(true);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        title: form.title,
        content: form.content,
        severity: form.severity,
        isPublished: form.isPublished,
        isPinned: form.isPinned,
        priority: form.priority,
        publishedAt: toIsoDateTime(form.publishedAt),
        expiresAt: toIsoDateTime(form.expiresAt),
      };
      const result = form.id
        ? await updateAnnouncementAction({ ...payload, id: form.id })
        : await createAnnouncementAction(payload);

      if (result?.serverError) {
        toast.error(result.serverError);
        return;
      }

      toast.success(form.id ? "公告已更新" : "公告已创建");
      setDialogOpen(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存公告失败");
    } finally {
      setIsSaving(false);
    }
  };

  const togglePublish = async (item: AdminAnnouncementItem) => {
    setMutatingId(item.id);
    try {
      const result = await toggleAnnouncementPublishAction({ id: item.id });
      if (result?.serverError) {
        toast.error(result.serverError);
        return;
      }
      toast.success(item.isPublished ? "公告已下线" : "公告已发布");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setMutatingId(null);
    }
  };

  const deleteAnnouncement = async (item: AdminAnnouncementItem) => {
    if (!window.confirm(`确认删除公告「${item.title}」？此操作不可恢复。`)) {
      return;
    }

    setMutatingId(item.id);
    try {
      const result = await deleteAnnouncementAction({ id: item.id });
      if (result?.serverError) {
        toast.error(result.serverError);
        return;
      }
      toast.success("公告已删除");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除公告失败");
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            公告管理
          </h2>
          <p className="text-muted-foreground">
            发布系统公告、维护通知和活动说明，用户侧会显示未读提醒。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          新建公告
        </Button>
      </div>

      {/* 统计卡:入场错峰放外层包裹,hover 过渡放卡片(duration 工具类共享
          同一 CSS 变量,同元素叠加会互相覆盖)。 */}
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "生效中", value: stats.active },
          { label: "草稿/下线", value: stats.drafts },
          { label: "置顶", value: stats.pinned },
        ].map((item, index) => (
          <div
            key={item.label}
            className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
            style={{
              animationDelay: `${index * 60}ms`,
              animationFillMode: "backwards",
            }}
          >
            <Card className="h-full lift-hover">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {item.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="font-serif text-3xl font-medium tracking-tight">
                  {item.value}
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {announcements.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
              <Megaphone className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="font-medium">暂无公告</p>
                <p className="text-sm text-muted-foreground">
                  新建后可选择保存为草稿或立即发布。
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          announcements.map((item) => {
            const severity = getSeverityMeta(item.severity);
            const active = isActiveAnnouncement(item);
            const busy = mutatingId === item.id;

            return (
              <Card
                key={item.id}
                className="lift-hover"
              >
                <CardContent className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={severity.className}>
                          {severity.label}
                        </Badge>
                        <Badge variant={active ? "default" : "secondary"}>
                          {active
                            ? "生效中"
                            : item.isPublished
                              ? "待生效/已过期"
                              : "草稿"}
                        </Badge>
                        {item.isPinned && (
                          <Badge variant="outline">
                            <Pin className="mr-1 h-3 w-3" />
                            置顶
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          优先级 {item.priority}
                        </span>
                      </div>
                      <div>
                        <h3 className="text-base font-medium">
                          {item.title}
                        </h3>
                        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                          {item.content}
                        </p>
                      </div>
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                        <span>
                          发布时间：{formatDateTime(item.publishedAt, timeZone)}
                        </span>
                        <span>
                          过期时间：{formatDateTime(item.expiresAt, timeZone)}
                        </span>
                        <span>
                          更新于：{formatDateTime(item.updatedAt, timeZone)}
                        </span>
                        <span>ID：{item.id.slice(0, 8)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEdit(item)}
                        disabled={busy}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑
                      </Button>
                      <Button
                        variant={item.isPublished ? "outline" : "default"}
                        size="sm"
                        onClick={() => togglePublish(item)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : item.isPublished ? (
                          <Archive className="mr-2 h-4 w-4" />
                        ) : (
                          <Upload className="mr-2 h-4 w-4" />
                        )}
                        {item.isPublished ? "下线" : "发布"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteAnnouncement(item)}
                        disabled={busy}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        删除
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "编辑公告" : "新建公告"}</DialogTitle>
            <DialogDescription>
              公告正文会按纯文本展示，换行会保留。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label
                htmlFor="announcement-title"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                标题
              </Label>
              <Input
                id="announcement-title"
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                minLength={2}
                maxLength={160}
                required
              />
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="announcement-content"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                内容
              </Label>
              <Textarea
                id="announcement-content"
                value={form.content}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    content: event.target.value,
                  }))
                }
                rows={8}
                minLength={2}
                maxLength={10000}
                required
              />
              <p className="text-xs text-muted-foreground">
                {form.content.length}/10000 字符
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="announcement-severity"
                  className="text-[11px] uppercase tracking-widest text-muted-foreground"
                >
                  等级
                </Label>
                <Select
                  value={form.severity}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      severity: value as AnnouncementSeverity,
                    }))
                  }
                >
                  <SelectTrigger id="announcement-severity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {announcementSeverities.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="announcement-priority"
                  className="text-[11px] uppercase tracking-widest text-muted-foreground"
                >
                  优先级
                </Label>
                <Input
                  id="announcement-priority"
                  type="number"
                  min={0}
                  max={999}
                  value={form.priority}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      priority: Number(event.target.value || 0),
                    }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="announcement-published-at"
                  className="text-[11px] uppercase tracking-widest text-muted-foreground"
                >
                  发布时间
                </Label>
                <Input
                  id="announcement-published-at"
                  type="datetime-local"
                  value={form.publishedAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      publishedAt: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="announcement-expires-at"
                  className="text-[11px] uppercase tracking-widest text-muted-foreground"
                >
                  过期时间
                </Label>
                <Input
                  id="announcement-expires-at"
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      expiresAt: event.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              {/* Radix Switch 渲染为 button,biome 识别不了包裹式 label,
                  须 htmlFor/id 显式关联(button 属 HTML labelable 元素) */}
              <label
                htmlFor="announcement-published"
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border p-3",
                  form.isPublished && "border-primary/50 bg-primary/5"
                )}
              >
                <span>
                  <span className="block text-sm font-medium">发布</span>
                  <span className="block text-xs text-muted-foreground">
                    打开后用户可在生效时间内看到
                  </span>
                </span>
                <Switch
                  id="announcement-published"
                  checked={form.isPublished}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      isPublished: checked,
                    }))
                  }
                />
              </label>
              <label
                htmlFor="announcement-pinned"
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border p-3",
                  form.isPinned && "border-primary/50 bg-primary/5"
                )}
              >
                <span>
                  <span className="block text-sm font-medium">置顶</span>
                  <span className="block text-xs text-muted-foreground">
                    置顶公告会排在普通公告前
                  </span>
                </span>
                <Switch
                  id="announcement-pinned"
                  checked={form.isPinned}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, isPinned: checked }))
                  }
                />
              </label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={isSaving}
              >
                取消
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
