"use client";

import { cn } from "~/lib/utils";

/** Filters whitespace changes in the displayed diff without changing source. */
export function ReviewWhitespaceToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      title="Ignore spaces, tabs, and line-ending whitespace when comparing lines"
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
            "absolute top-0.5 size-2.5 rounded-full bg-panel transition-transform",
            checked ? "translate-x-3" : "translate-x-0.5",
          )}
        />
      </span>
      Ignore whitespace
    </button>
  );
}
