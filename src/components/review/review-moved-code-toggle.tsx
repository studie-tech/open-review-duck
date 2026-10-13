"use client";

import { MoveRight } from "lucide-react";
import { cn } from "~/lib/utils";
import { ReviewToolbarTooltip } from "./review-toolbar-tooltip";

/** Dims unchanged moved lines while preserving edits and review actions. */
export function ReviewMovedCodeToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ReviewToolbarTooltip label="Dim moved code: gray unchanged moved lines; edits keep their diff colors">
      <button
        type="button"
        aria-label="Dim moved code"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[10px] transition",
          checked
            ? "border-cyan/30 bg-cyan/15 text-cyan"
            : "border-line bg-surface/25 text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <MoveRight className="size-3.5" aria-hidden="true" />
        Dim moved code
      </button>
    </ReviewToolbarTooltip>
  );
}
