"use client";

import { Space } from "lucide-react";
import { cn } from "~/lib/utils";
import { ReviewToolbarTooltip } from "./review-toolbar-tooltip";

/** Filters whitespace changes in the displayed diff without changing source. */
export function ReviewWhitespaceToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ReviewToolbarTooltip label="Ignore whitespace: hide changes to spaces, tabs, and line endings">
      <button
        type="button"
        aria-label="Ignore whitespace"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-[10px] transition",
          checked
            ? "border-cyan/30 bg-cyan/15 text-cyan"
            : "border-line bg-surface/25 text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative h-3.5 w-6 rounded-full transition",
            checked ? "bg-cyan" : "bg-line-strong",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0 size-2.5 rounded-full bg-panel transition-transform",
              checked ? "translate-x-3" : "translate-x-0.5",
            )}
          />
        </span>
        <Space className="size-3.5" aria-hidden="true" />
      </button>
    </ReviewToolbarTooltip>
  );
}
