"use client";

import { Button } from "@repo/ui/components/button";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  MAX_TICKET_ATTACHMENT_BYTES,
  MAX_TICKET_ATTACHMENTS,
} from "../constants";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface TicketImagePickerProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled?: boolean;
}

export async function uploadTicketImages(files: File[]) {
  const attachmentIds: string[] = [];
  try {
    for (const file of files) {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/support/attachments", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as {
        attachment?: { id?: string };
        error?: string;
      } | null;
      const attachmentId = payload?.attachment?.id;
      if (!response.ok || !attachmentId) {
        throw new Error(payload?.error || "图片上传失败");
      }
      attachmentIds.push(attachmentId);
    }
    return attachmentIds;
  } catch (error) {
    await discardTicketImages(attachmentIds);
    throw error;
  }
}

export async function discardTicketImages(attachmentIds: string[]) {
  await Promise.allSettled(
    attachmentIds.map((attachmentId) =>
      fetch(`/api/support/attachments/${attachmentId}`, { method: "DELETE" })
    )
  );
}

export function TicketImagePicker({
  files,
  onFilesChange,
  disabled = false,
}: TicketImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [files]);

  const handleFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    const accepted: File[] = [];
    const existingFiles = new Set(
      files.map((file) => `${file.name}:${file.size}:${file.lastModified}`)
    );
    for (const file of selected) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        toast.error(`${file.name}：仅支持 PNG、JPEG 和 WebP`);
        continue;
      }
      if (file.size <= 0 || file.size > MAX_TICKET_ATTACHMENT_BYTES) {
        toast.error(`${file.name}：图片不能超过 5MB`);
        continue;
      }
      const identity = `${file.name}:${file.size}:${file.lastModified}`;
      if (existingFiles.has(identity)) continue;
      existingFiles.add(identity);
      accepted.push(file);
    }

    const available = MAX_TICKET_ATTACHMENTS - files.length;
    if (accepted.length > available) {
      toast.error(`每条消息最多上传 ${MAX_TICKET_ATTACHMENTS} 张图片`);
    }
    onFilesChange([...files, ...accepted.slice(0, Math.max(0, available))]);
    event.target.value = "";
  };

  return (
    <div className="space-y-3">
      {files.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {files.map((file, index) => (
            <div
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
            >
              {/* biome-ignore lint/performance/noImgElement: local object URLs do not benefit from next/image */}
              <img
                src={previewUrls[index]}
                alt={file.name}
                className="h-full w-full object-cover"
              />
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() =>
                  onFilesChange(
                    files.filter((_, fileIndex) => fileIndex !== index)
                  )
                }
                disabled={disabled}
                title="移除图片"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={handleFiles}
        disabled={disabled}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || files.length >= MAX_TICKET_ATTACHMENTS}
      >
        <ImagePlus className="mr-2 h-4 w-4" />
        添加图片
      </Button>
    </div>
  );
}
