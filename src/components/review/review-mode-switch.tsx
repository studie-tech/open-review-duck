"use client";

import { Files, Route } from "lucide-react";
import type { ReviewMode } from "~/lib/review-files";
import { cn } from "~/lib/utils";

const options = [
  { icon: Route, label: "Guided", value: "path" },
  { icon: Files, label: "Files", value: "files" },
] as const;

/** Compact, reusable navigation switch for the two projections of a review. */
export function ReviewModeSwitch({
  mode,
  onChange,
}: {
  mode: ReviewMode;
  onChange: (mode: ReviewMode) => void;
}) {
  return (
    <div className="flex justify-end">
      <div
        role="tablist"
        aria-label="Review view"
        className="bg-ink/55 inline-flex rounded-lg border border-line p-0.5 shadow-inner"
      >
        {options.map((option) => {
          const Icon = option.icon;
          const selected = mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[10px] font-medium transition",
                selected
                  ? "bg-surface text-cloud shadow-sm ring-1 ring-line-strong"
                  : "text-fog hover:bg-surface/60 hover:text-mist",
              )}
            >
              <Icon
                className={cn("size-3", selected && "text-cyan")}
                aria-hidden="true"
              />
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
