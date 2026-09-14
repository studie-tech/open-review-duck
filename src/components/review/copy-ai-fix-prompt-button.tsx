"use client";

import { Check, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "~/lib/utils";

export const COPY_AI_FIX_PROMPT_TITLE = "Copy fix prompt for your AI agent";

/**
 * Copies a self-contained fix request for a coding agent to the clipboard.
 *
 * Every surface that shows something the pull request branch still has to
 * change carries this one control, so the wand reads the same way whether
 * it sits beside a merge block, a failed check, a finding, or a review
 * conversation. A check replaces the wand once the clipboard has the text,
 * so the click does not need a toast to confirm.
 *
 * The prompt is a thunk because the text is only worth assembling on click.
 */
export function CopyAiFixPromptButton({
  className,
  prompt,
  subject,
  variant = "icon",
}: {
  className?: string;
  prompt: () => string;
  /** Names what the prompt fixes for assistive technology. */
  subject: string;
  /** `icon` fits dense rows; `inline` and `button` carry a visible label. */
  variant?: "icon" | "inline" | "button";
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** Puts the prompt on the clipboard without touching the surrounding row. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt());
      setCopied(true);
    } catch {
      toast.error("Could not copy the fix prompt");
    }
  }

  const label = copied ? "Copied" : "Copy fix prompt";
  const icon = copied ? (
    <Check className="text-lime size-3" aria-hidden="true" />
  ) : (
    <WandSparkles className="size-3" aria-hidden="true" />
  );

  return (
    <button
      type="button"
      aria-label={
        copied
          ? `AI fix prompt for ${subject} copied`
          : `Copy AI fix prompt for ${subject}`
      }
      title={copied ? "Copied" : COPY_AI_FIX_PROMPT_TITLE}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      className={cn(
        "text-violet shrink-0 rounded-md transition hover:bg-violet/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50",
        variant === "icon" && "grid size-6 place-items-center",
        variant === "inline" &&
          "inline-flex items-center gap-1 px-1 py-0.5 hover:underline",
        variant === "button" &&
          "inline-flex h-7 items-center gap-2 px-2 text-[10px] font-semibold",
        className,
      )}
    >
      {icon}
      {variant !== "icon" && <span>{label}</span>}
    </button>
  );
}
