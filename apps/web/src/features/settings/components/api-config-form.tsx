"use client";

import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import { canUseCustomApi } from "@repo/shared/config/subscription-plan";
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
import { Switch } from "@repo/ui/components/switch";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  deleteApiConfig,
  getApiConfig,
  saveApiConfig,
  testApiConfig,
  toggleApiConfig,
} from "../actions";

type ActionError = {
  serverError?: string;
  validationErrors?: Record<string, unknown>;
};

function flattenValidationErrors(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenValidationErrors(item));
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap((item) => flattenValidationErrors(item));
  }
  return [];
}

function getActionErrorMessage(error: ActionError | undefined, fallback: string) {
  const validationMessages = flattenValidationErrors(error?.validationErrors);
  if (validationMessages.length > 0) {
    return validationMessages.join(", ");
  }
  return error?.serverError || fallback;
}

export function ApiConfigForm() {
  const t = useTranslations("Settings");
  const [expanded, setExpanded] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [useStream, setUseStream] = useState(false);
  const [chatCompletionsUpstreamMode, setChatCompletionsUpstreamMode] =
    useState<"responses" | "chat_completions" | "images">("responses");
  const [isActive, setIsActive] = useState(true);
  const [hasConfig, setHasConfig] = useState(false);
  const [customApiAllowed, setCustomApiAllowed] = useState(false);
  const [loading, setLoading] = useState(true);

  const { execute: executeSave, isPending: isSaving } = useAction(
    saveApiConfig,
    {
      onSuccess: () => {
        toast.success(t("apiConfig.saved"));
        setHasConfig(true);
        setIsActive(true);
      },
      onError: (err) => {
        toast.error(getActionErrorMessage(err.error, t("apiConfig.saveFailed")));
      },
    }
  );

  const { execute: executeDelete, isPending: isDeleting } = useAction(
    deleteApiConfig,
    {
      onSuccess: () => {
        toast.success(t("apiConfig.removed"));
        setBaseUrl("");
        setApiKey("");
        setModel("");
        setUseStream(false);
        setChatCompletionsUpstreamMode("responses");
        setHasConfig(false);
      },
    }
  );

  const { execute: executeToggle } = useAction(toggleApiConfig, {
    onSuccess: () => {
      setIsActive(!isActive);
    },
    onError: (err) => {
      toast.error(err.error?.serverError || t("apiConfig.updateFailed"));
    },
  });

  // 测活：把探测结果按本地化文案提示给用户（成功/密钥被拒/HTTP 错误/不可达）。
  const { execute: executeTest, isPending: isTesting } = useAction(
    testApiConfig,
    {
      onSuccess: ({ data }) => {
        if (!data) {
          toast.error(t("apiConfig.testUnreachable"));
          return;
        }
        if (data.ok) {
          toast.success(t("apiConfig.testOk", { latency: data.latencyMs }));
          return;
        }
        if (data.status === "no_image") {
          toast.error(t("apiConfig.testNoImage"));
        } else if (data.status === "auth_failed") {
          toast.error(t("apiConfig.testAuthFailed"));
        } else if (data.status === "unreachable") {
          toast.error(t("apiConfig.testUnreachable"));
        } else {
          toast.error(t("apiConfig.testError"));
        }
      },
      onError: (err) => {
        toast.error(
          getActionErrorMessage(err.error, t("apiConfig.testUnreachable"))
        );
      },
    }
  );

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const [configResult, planResult] = await Promise.all([
          getApiConfig(),
          getMyPlanAction(),
        ]);
        setCustomApiAllowed(
          planResult?.data?.capabilities?.features["customApi.configure"] ??
            (planResult?.data?.plan
              ? canUseCustomApi(planResult.data.plan)
              : false)
        );
        if (configResult?.data) {
          setBaseUrl(configResult.data.baseUrl);
          setApiKey(configResult.data.apiKey);
          setModel(configResult.data.model || "");
          setUseStream(Boolean(configResult.data.useStream));
          setChatCompletionsUpstreamMode(
            configResult.data.chatCompletionsUpstreamMode ===
              "chat_completions"
              ? "chat_completions"
              : configResult.data.chatCompletionsUpstreamMode === "images"
                ? "images"
                : "responses"
          );
          setIsActive(configResult.data.isActive);
          setHasConfig(true);
        }
      } catch {
        // No config exists
      } finally {
        setLoading(false);
      }
    };
    loadConfig();
  }, []);

  const handleSave = () => {
    if (!customApiAllowed) {
      toast.error(t("apiConfig.requiresPaid"));
      return;
    }
    executeSave({
      baseUrl,
      apiKey,
      model: model || undefined,
      useStream,
      chatCompletionsUpstreamMode,
    });
  };

  const handleTest = () => {
    if (!customApiAllowed) {
      toast.error(t("apiConfig.requiresPaid"));
      return;
    }
    if (!baseUrl || !apiKey) {
      toast.error(t("apiConfig.testNeedsInput"));
      return;
    }
    executeTest({ baseUrl, apiKey, model: model || undefined });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="rounded-lg border border-border bg-muted/50 p-4">
        <div className="flex gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground/80">
              {t("apiConfig.warning.title")}
            </p>
            <p className="mt-1">
              {customApiAllowed
                ? t("apiConfig.warning.description")
                : t("apiConfig.paidOnly")}
            </p>
          </div>
        </div>
      </div>

      {/* Collapsible section */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground"
      >
        <span>{t("apiConfig.customEndpoint")}</span>
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="space-y-4 rounded-lg border border-border p-4 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          {/* Active toggle (only if config exists)：行 hover 微提亮 */}
          {hasConfig && (
            <div className="-mx-2 flex items-center justify-between rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/30">
              <div>
                <Label className="text-sm">
                  {t("apiConfig.enabled")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("apiConfig.enabledDescription")}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={(checked) =>
                  executeToggle({ isActive: checked })
                }
                disabled={!customApiAllowed}
              />
            </div>
          )}

          {/* Base URL */}
          <div className="space-y-2">
            <Label
              htmlFor="api-base-url"
              className="text-xs uppercase tracking-[0.6px] text-muted-foreground"
            >
              {t("apiConfig.baseUrl")}
            </Label>
            <Input
              id="api-base-url"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={!customApiAllowed}
            />
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label
              htmlFor="api-key"
              className="text-xs uppercase tracking-[0.6px] text-muted-foreground"
            >
              {t("apiConfig.apiKey")}
            </Label>
            <Input
              id="api-key"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={!customApiAllowed}
            />
          </div>

          {/* Model (optional) */}
          <div className="space-y-2">
            <Label
              htmlFor="api-model"
              className="text-xs uppercase tracking-[0.6px] text-muted-foreground"
            >
              {t("apiConfig.model")}
            </Label>
            <Input
              id="api-model"
              placeholder="gpt-image-2.5"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!customApiAllowed}
            />
            <p className="text-xs text-muted-foreground">
              {t("apiConfig.modelHint")}
            </p>
          </div>

          {/* Streaming toggle：行 hover 微提亮 */}
          <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3 transition-colors duration-150 hover:bg-muted/30">
            <div>
              <Label htmlFor="api-use-stream" className="text-sm">
                {t("apiConfig.useStream")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("apiConfig.useStreamDescription")}
              </p>
            </div>
            <Switch
              id="api-use-stream"
              checked={useStream}
              onCheckedChange={setUseStream}
              disabled={!customApiAllowed}
            />
          </div>

          <div className="space-y-2 rounded-md border border-border px-3 py-3 transition-colors duration-150 hover:bg-muted/30">
            <Label
              htmlFor="api-chat-upstream"
              className="text-xs uppercase tracking-[0.6px] text-muted-foreground"
            >
              Chat Completions 上游
            </Label>
            <Select
              value={chatCompletionsUpstreamMode}
              onValueChange={(value) =>
                setChatCompletionsUpstreamMode(
                  value === "chat_completions" || value === "images"
                    ? value
                    : "responses"
                )
              }
              disabled={!customApiAllowed}
            >
              <SelectTrigger id="api-chat-upstream">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="responses">Responses 生图模式</SelectItem>
                <SelectItem value="chat_completions">
                  原生 Chat Completions
                </SelectItem>
                <SelectItem value="images">原生 Images</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Responses 模式会请求上游 /responses；原生 Chat 模式会请求 /chat/completions；Images 模式会转换为 /images/generations 或 /images/edits，不支持多轮对话。
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button
              onClick={handleSave}
              disabled={!customApiAllowed || !baseUrl || !apiKey || isSaving}
              size="sm"
            >
              {isSaving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
              {t("apiConfig.save")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={
                !customApiAllowed || !baseUrl || !apiKey || isTesting
              }
            >
              {isTesting ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : (
                <Activity className="mr-2 h-3 w-3" />
              )}
              {isTesting ? t("apiConfig.testing") : t("apiConfig.test")}
            </Button>
            {hasConfig && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => executeDelete()}
                disabled={isDeleting}
                className="text-destructive"
              >
                <Trash2 className="mr-2 h-3 w-3" />
                {t("apiConfig.remove")}
              </Button>
            )}
          </div>

          {/* Documentation link */}
          <a
            href="/docs"
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            {t("apiConfig.docsLink")}
          </a>
        </div>
      )}
    </div>
  );
}
