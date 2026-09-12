"use client";

import { type ComponentProps, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  COMMENT_IMAGE_MAX_BYTES,
  COMMENT_IMAGE_TYPES,
} from "~/lib/comment-images";

export type UploadCommentImage = (file: File) => Promise<string>;

/** Reads clipboard bytes without expanding them into a JavaScript argument list. */
export function commentImageBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the pasted image"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

/** Inserts uploaded images at the selection while keeping the draft stable. */
export function CommentImageTextarea({
  onUploadImage,
  onUploadingChange,
  onValueChange,
  ...props
}: Omit<ComponentProps<"textarea">, "onChange"> & {
  onUploadImage?: UploadCommentImage;
  onUploadingChange: (uploading: boolean) => void;
  onValueChange: (value: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (busy.current) onUploadingChange(false);
    };
  }, [onUploadingChange]);
  return (
    <>
      <textarea
        {...props}
        readOnly={props.readOnly || uploading}
        aria-busy={uploading || undefined}
        onChange={(event) => {
          if (!busy.current) onValueChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            busy.current &&
            (event.key === "Enter" || event.key === "Escape")
          ) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onKeyDown?.(event);
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            )
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          if (busy.current || props.disabled || props.readOnly) return;
          if (!onUploadImage) {
            toast.error(
              "Attach the image on the provider and paste its link here.",
            );
            return;
          }
          if (
            files.some(
              (file) =>
                !COMMENT_IMAGE_TYPES.some((type) => type === file.type) ||
                file.size === 0 ||
                file.size > COMMENT_IMAGE_MAX_BYTES,
            )
          ) {
            toast.error(
              "Paste a PNG, JPEG, GIF, or WebP image no larger than 2 MB.",
            );
            return;
          }
          const textarea = event.currentTarget;
          const before = textarea.value.slice(0, textarea.selectionStart);
          const after = textarea.value.slice(textarea.selectionEnd);
          busy.current = true;
          setUploading(true);
          onUploadingChange(true);
          void (async () => {
            const links: string[] = [];
            try {
              for (const file of files) {
                links.push(await onUploadImage(file));
                if (!mounted.current) return;
                onValueChange(`${before}${links.join("\n")}${after}`);
              }
            } catch (cause) {
              if (mounted.current)
                toast.error(
                  cause instanceof Error
                    ? cause.message
                    : "Image upload failed. Paste the image again to retry.",
                );
            } finally {
              if (mounted.current) {
                busy.current = false;
                setUploading(false);
                onUploadingChange(false);
                textarea.focus();
                const cursor = before.length + links.join("\n").length;
                requestAnimationFrame(() => {
                  if (mounted.current)
                    textarea.setSelectionRange(cursor, cursor);
                });
              }
            }
          })();
        }}
      />
      {uploading && (
        <p role="status" className="text-cyan mt-1 text-xs">
          Uploading image…
        </p>
      )}
    </>
  );
}
