"use client";

import { ChevronDown } from "lucide-react";
import { ShortcutHint } from "~/components/command-center";
import { CONTEXT_PAGE_LINES } from "~/components/review/review-workspace-constants";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import { cn } from "~/lib/utils";

type ContextRevealDirection = "above" | "below";

type ContextRevealControlProps = {
  availableLines: number;
  className?: string;
  direction: ContextRevealDirection;
  onReveal: () => void;
  revealedLines: number;
  shortcut: KeyboardShortcut;
};

/** Reveals the next page of source outside a focused review range. */
export function ContextRevealControl({
  availableLines,
  className,
  direction,
  onReveal,
  revealedLines,
  shortcut,
}: ContextRevealControlProps) {
  const remainingLines = Math.max(0, availableLines - revealedLines);
  if (remainingLines === 0) return null;

  const pageLines = Math.min(CONTEXT_PAGE_LINES, remainingLines);
  return (
    <div className={cn("flex items-center gap-3 px-4 font-sans", className)}>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <button
        type="button"
        onClick={onReveal}
        className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
      >
        <ChevronDown
          className={cn("size-3", direction === "above" && "rotate-180")}
          aria-hidden="true"
        />
        Show {pageLines} {revealedLines > 0 ? "more " : ""}lines {direction}
        <ShortcutHint shortcut={shortcut} className="ml-1" />
      </button>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}
