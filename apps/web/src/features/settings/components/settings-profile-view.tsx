"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Camera, Loader2 } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Button } from "@repo/ui/components/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  getAllowedModerationBlockRiskLevels,
  type ModerationBlockRiskLevel,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import type { PlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import {
  deleteAccountAction,
  updateProfileAction,
} from "@/features/settings/actions";
import { updateProfileSchema } from "@/features/settings/schemas";
import {
  ALLOWED_IMAGE_TYPES,
  generateAvatarKey,
  getAvatarUrl,
  getSignedUploadUrlAction,
  MAX_FILE_SIZE,
} from "@repo/shared/storage";
import { usePathname, useRouter } from "@/i18n/routing";
import { signOut } from "@repo/shared/auth/client";
import { ImageBackendPreferenceSection } from "@/features/image-backend-pool";

import { ApiConfigForm } from "./api-config-form";
import { SecuritySection } from "./security-section";

interface SettingsProfileViewProps {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    moderationBlockRiskLevel: ModerationBlockRiskLevel;
  };
}

type FormValues = z.infer<typeof updateProfileSchema>;

/** 设置分区节标题：uppercase 小标签 + 下边框分隔（对齐参考项目排版语言） */
const sectionTitleClass =
  "text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground";

/** 表单字段标签：uppercase 小字距；不带颜色以保留 FormLabel 错误态变红 */
const fieldLabelClass = "text-xs uppercase tracking-[0.6px]";

/**
 * 设置行 hover 微提亮：负外边距抵消内边距，hover 背景外扩而内容不位移。
 * 仅作视觉反馈，不改变行内交互。
 */
const settingRowClass =
  "-mx-3 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-muted/30";

export function SettingsProfileView({ user }: SettingsProfileViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const t = useTranslations("Settings");
  const tTabs = useTranslations("Settings.tabs");

  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams();
  const [isChangingLocale, startLocaleTransition] = useTransition();

  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [userPlan, setUserPlan] = useState<SubscriptionPlan>("free");
  const [capabilities, setCapabilities] =
    useState<PlanCapabilitySnapshot | null>(null);
  const moderationOptions =
    capabilities?.moderation.allowedBlockRiskLevels ||
    getAllowedModerationBlockRiskLevels(userPlan);
  const moderationBlockingEnabled =
    capabilities?.features["moderation.blocking"] ?? true;
  const moderationControlAllowed =
    moderationBlockingEnabled && moderationOptions.length > 1;
  const avatarMaxFileSizeBytes =
    capabilities?.limits.maxFileSizeBytes ?? MAX_FILE_SIZE;
  const normalizeTab = useCallback((value: string | null) => {
    if (
      value === "security" ||
      value === "backend" ||
      value === "advanced" ||
      value === "account"
    ) {
      return value;
    }
    return "account";
  }, []);
  const [activeTab, setActiveTab] = useState(() =>
    normalizeTab(searchParams.get("tab"))
  );
  const lastAppliedTabParamRef = useRef(searchParams.get("tab"));

  const handleLanguageChange = (newLocale: string) => {
    startLocaleTransition(() => {
      router.replace(
        // @ts-expect-error Current route params always match the current pathname.
        { pathname, params },
        { locale: newLocale }
      );
    });
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const currentAvatarUrl = avatarPreview ?? getAvatarUrl(user.image);

  const form = useForm<FormValues>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      name: user.name,
      moderationBlockRiskLevel: user.moderationBlockRiskLevel,
    },
  });

  useEffect(() => {
    getMyPlanAction().then((result) => {
      if (result?.data?.plan) {
        const nextPlan = result.data.plan;
        setUserPlan(nextPlan);
        setCapabilities(result.data.capabilities ?? null);
        const allowed =
          result.data.capabilities?.moderation.allowedBlockRiskLevels ||
          getAllowedModerationBlockRiskLevels(nextPlan);
        const current = form.getValues("moderationBlockRiskLevel");
        if (current && !allowed.includes(current)) {
          form.setValue("moderationBlockRiskLevel", allowed.at(-1) || "low");
        }
      }
    });
  }, [form]);

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab === "billing" || requestedTab === "usage") {
      router.replace(`/${locale}/dashboard/billing`);
      return;
    }
    if (requestedTab === "external-api") {
      router.replace(`/${locale}/dashboard/external-api`);
      return;
    }
    if (requestedTab === lastAppliedTabParamRef.current) return;
    lastAppliedTabParamRef.current = requestedTab;
    if (!requestedTab) return;
    setActiveTab(normalizeTab(requestedTab));
  }, [searchParams, normalizeTab, router, locale]);

  const { execute: executeUpdateProfile, isPending } = useAction(
    updateProfileAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) {
          toast.success(data.message);
        }
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError);
        }
        if (error.validationErrors) {
          const errors = Object.values(error.validationErrors).flat();
          toast.error(errors.join(", ") || t("errors.validationFailed"));
        }
      },
    }
  );

  const { execute: executeDeleteAccount, isPending: isDeletingAccount } =
    useAction(deleteAccountAction, {
      onSuccess: async ({ data }) => {
        setIsDeleteDialogOpen(false);

        if (data?.message) {
          toast.success(data.message);
        }

        try {
          await signOut({
            fetchOptions: {
              onSuccess: () => {
                router.replace("/");
                router.refresh();
              },
            },
          });
        } catch {
          router.replace("/");
          router.refresh();
        }
      },
      onError: ({ error }) => {
        toast.error(error.serverError || t("deleteAccount.error"));
      },
    });

  const onSubmit = (values: FormValues) => {
    executeUpdateProfile(values);
  };

  const handleAvatarClick = () => {
    if (!isUploadingAvatar) {
      fileInputRef.current?.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (
      !ALLOWED_IMAGE_TYPES.includes(
        file.type as (typeof ALLOWED_IMAGE_TYPES)[number]
      )
    ) {
      toast.error(
        t("errors.unsupportedFileType", {
          types: ALLOWED_IMAGE_TYPES.join(", "),
        })
      );
      return;
    }

    if (file.size > avatarMaxFileSizeBytes) {
      toast.error(
        t("errors.fileTooLarge", { size: avatarMaxFileSizeBytes / 1024 / 1024 })
      );
      return;
    }

    setIsUploadingAvatar(true);

    try {
      const localPreviewUrl = URL.createObjectURL(file);
      setAvatarPreview(localPreviewUrl);

      const key = generateAvatarKey(user.id, file);

      const uploadUrlResult = await getSignedUploadUrlAction({
        key,
        contentType: file.type as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
      });

      if (!uploadUrlResult?.data?.uploadUrl) {
        throw new Error(t("errors.uploadFailed"));
      }
      const signedMaxFileSizeBytes =
        uploadUrlResult.data.maxFileSizeBytes || avatarMaxFileSizeBytes;
      if (file.size > signedMaxFileSizeBytes) {
        throw new Error(
          t("errors.fileTooLarge", {
            size: signedMaxFileSizeBytes / 1024 / 1024,
          })
        );
      }

      const uploadResponse = await fetch(uploadUrlResult.data.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error(t("errors.fileUploadFailed"));
      }

      executeUpdateProfile({ image: uploadUrlResult.data.key });
      toast.success(t("success.avatarUpdated"));
    } catch (error) {
      console.error("Avatar upload error:", error);
      toast.error(
        error instanceof Error ? error.message : t("errors.avatarUploadError")
      );
      setAvatarPreview(null);
    } finally {
      setIsUploadingAvatar(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDeleteAccount = () => {
    executeDeleteAccount();
  };

  return (
    <div className="max-w-4xl space-y-8">
      {/* 页头:对齐 dashboard/admin 页头节奏(衬线大标题),此前无标题直接进 Tab */}
      <div className="space-y-1">
        <h1 className="font-serif text-3xl font-medium tracking-tight">
          {t("title")}
        </h1>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(normalizeTab(value))}
        className="w-full"
      >
        {/* Tab 语言收敛到全站胶囊规格(TabsList 默认类),不再用下划线风 */}
        <TabsList className="h-auto gap-1">
          <TabsTrigger value="account">
            {tTabs("account")}
          </TabsTrigger>
          <TabsTrigger value="security">
            {tTabs("security")}
          </TabsTrigger>
          <TabsTrigger value="backend">
            {tTabs("backend")}
          </TabsTrigger>
          <TabsTrigger value="advanced">
            {tTabs("advanced")}
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="account"
          className="mt-8 space-y-8 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <section className="space-y-6">
            <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("general.title")}</h2>
              <Button
                type="submit"
                form="profile-form"
                size="sm"
                disabled={isPending}
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("general.save")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("general.description")}
            </p>

            <Form {...form}>
              <form
                id="profile-form"
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-6"
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={fieldLabelClass}>
                        {t("general.name")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t("general.namePlaceholder")}
                          disabled={isPending}
                          className="max-w-md"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {t("general.nameDescription")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <label
                    htmlFor="settings-email"
                    className="block text-xs font-medium uppercase leading-none tracking-[0.6px] text-muted-foreground"
                  >
                    {t("general.email")}
                  </label>
                  <Input
                    id="settings-email"
                    type="email"
                    value={user.email}
                    disabled
                    className="max-w-md bg-muted"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t("general.emailDescription")}
                  </p>
                </div>

                <FormField
                  control={form.control}
                  name="moderationBlockRiskLevel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={fieldLabelClass}>
                        {t("moderation.title")}
                      </FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value}
                          onValueChange={(value) =>
                            field.onChange(value as ModerationBlockRiskLevel)
                          }
                          className="grid max-w-2xl gap-3 md:grid-cols-3"
                          disabled={isPending || !moderationControlAllowed}
                        >
                          {(
                            [
                              "low",
                              "medium",
                              "high",
                            ] as ModerationBlockRiskLevel[]
                          ).map((level) => {
                            const optionAllowed =
                              moderationOptions.includes(level);
                            return (
                              <Label
                                key={level}
                                htmlFor={`moderation-risk-${level}`}
                                className={`rounded-md border border-border p-3 text-sm transition-colors duration-150 has-[[data-state=checked]]:border-foreground/40 has-[[data-state=checked]]:bg-muted/40 ${
                                  optionAllowed
                                    ? "cursor-pointer hover:bg-muted/50"
                                    : "cursor-not-allowed opacity-50"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem
                                    id={`moderation-risk-${level}`}
                                    value={level}
                                    disabled={!optionAllowed}
                                  />
                                  <span className="font-medium">
                                    {t(`moderation.options.${level}.label`)}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs font-normal text-muted-foreground">
                                  {t(
                                    `moderation.options.${level}.description`
                                  )}
                                </p>
                              </Label>
                            );
                          })}
                        </RadioGroup>
                      </FormControl>
                      <FormDescription>
                        {moderationControlAllowed
                          ? t("moderation.description")
                          : moderationBlockingEnabled
                            ? t("moderation.upgradeHint")
                            : t("moderation.disabledByPlan")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </form>
            </Form>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("avatar.title")}</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("avatar.description")}
            </p>

            <div className="flex flex-col items-center space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={handleFileChange}
                disabled={isUploadingAvatar}
              />

              <button
                type="button"
                onClick={handleAvatarClick}
                disabled={isUploadingAvatar}
                className="group relative cursor-pointer disabled:cursor-not-allowed"
              >
                <Avatar className="h-24 w-24 transition-opacity group-hover:opacity-80 group-disabled:opacity-60">
                  <AvatarImage src={currentAvatarUrl} alt={user.name} />
                  <AvatarFallback className="bg-foreground text-background text-2xl">
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-100">
                  {isUploadingAvatar ? (
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  ) : (
                    <Camera className="h-6 w-6 text-white" />
                  )}
                </div>
              </button>

              <p className="text-sm text-muted-foreground">
                {isUploadingAvatar
                  ? t("avatar.uploading")
                  : t("avatar.supportedFormats", {
                      size: avatarMaxFileSizeBytes / 1024 / 1024,
                    })}
              </p>
            </div>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("language.title")}</h2>
            </div>
            <div
              className={`flex items-center justify-between gap-4 ${settingRowClass}`}
            >
              <p className="text-sm text-muted-foreground">
                {t("language.description")}
              </p>

              <Select
                value={locale}
                onValueChange={handleLanguageChange}
                disabled={isChangingLocale}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t("language.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="zh">中文</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className="text-xs font-medium uppercase tracking-[1.2px] text-destructive">
                {t("deleteAccount.title")}
              </h2>
            </div>
            <div
              className={`flex items-center justify-between gap-4 ${settingRowClass}`}
            >
              <p className="text-sm text-muted-foreground">
                {t("deleteAccount.description")}
              </p>

              <AlertDialog
                open={isDeleteDialogOpen}
                onOpenChange={(open) => {
                  if (!isDeletingAccount) {
                    setIsDeleteDialogOpen(open);
                  }
                }}
              >
                <Button
                  type="button"
                  variant="outline"
                  className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={isDeletingAccount}
                >
                  {isDeletingAccount && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t("deleteAccount.button")}
                </Button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("deleteAccount.confirmTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("deleteAccount.confirmDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeletingAccount}>
                      {t("deleteAccount.cancel")}
                    </AlertDialogCancel>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDeleteAccount}
                      disabled={isDeletingAccount}
                    >
                      {isDeletingAccount && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {t("deleteAccount.confirm")}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </section>
        </TabsContent>

        <TabsContent
          value="security"
          className="mt-8 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <SecuritySection />
        </TabsContent>

        <TabsContent
          value="backend"
          className="mt-8 space-y-6 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <div className="space-y-2">
            <div className="border-b border-border/60 pb-2">
              <h3 className={sectionTitleClass}>{t("backend.title")}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("backend.description")}
            </p>
          </div>
          <ImageBackendPreferenceSection />
        </TabsContent>

        <TabsContent
          value="advanced"
          className="mt-8 space-y-6 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <div className="space-y-2">
            <div className="border-b border-border/60 pb-2">
              <h3 className={sectionTitleClass}>{t("advanced.title")}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("advanced.description")}
            </p>
          </div>
          <ApiConfigForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
