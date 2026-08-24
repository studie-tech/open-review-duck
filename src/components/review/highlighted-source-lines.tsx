"use client";

import { Fragment, type ReactNode } from "react";
import type { HighlightedLine } from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";

/**
 * Renders syntax-highlighted source rows with a sticky line-number gutter.
 *
 * Shared by the pull-request review workspace and the repository reader so
 * both surfaces present source through one visual treatment.
 */
export function HighlightedSourceLines({
  lines,
  startLine,
  className,
  focusRange,
  selectedRange,
  onSelectLine,
  renderAfterLine,
}: {
  lines: HighlightedLine[];
  startLine: number;
  className?: string;
  focusRange?: { startLine: number; endLine: number };
  selectedRange?: { startLine: number; endLine: number };
  onSelectLine?: (line: number, extend: boolean) => void;
  renderAfterLine?: (line: number) => ReactNode;
}) {
  return (
    <div className={cn("py-4 font-mono text-[12px] leading-6", className)}>
      {lines.map((line, index) => {
        const lineNumber = startLine + index;
        const selected = Boolean(
          selectedRange &&
            lineNumber >= selectedRange.startLine &&
            lineNumber <= selectedRange.endLine,
        );
        const contextLine = Boolean(
          focusRange &&
            (lineNumber < focusRange.startLine ||
              lineNumber > focusRange.endLine),
        );
        return (
          <Fragment key={lineNumber}>
            <div
              data-source-line={lineNumber}
              className={cn(
                "group hover:bg-surface-hover/45 flex min-h-6 border-l-2 border-transparent",
                focusRange && !contextLine && "border-l-cyan/35 bg-cyan/[.012]",
                contextLine &&
                  "bg-surface-subtle/15 opacity-55 hover:opacity-80",
                selected &&
                  "bg-cyan/[.07] opacity-100 hover:bg-cyan/[.09] hover:opacity-100",
              )}
            >
              {onSelectLine ? (
                <button
                  type="button"
                  aria-label={`Create compliance rule from line ${lineNumber}`}
                  aria-pressed={selected}
                  title="Create a compliance rule · Shift-click to select a range"
                  onClick={(event) => onSelectLine(lineNumber, event.shiftKey)}
                  className={cn(
                    "border-line/60 bg-code text-fog group-hover:bg-surface-hover sticky left-0 flex w-16 shrink-0 items-center justify-end gap-1 border-r pr-3 text-right select-none",
                    selected && "bg-cyan/[.09] text-cyan",
                  )}
                >
                  <span className="opacity-0 transition group-hover:opacity-100">
                    +
                  </span>
                  {lineNumber}
                </button>
              ) : (
                <span className="border-line/60 bg-code text-fog group-hover:bg-surface-hover sticky left-0 w-16 shrink-0 border-r pr-3 text-right select-none">
                  {lineNumber}
                </span>
              )}
              <code className="syntax-code px-4 whitespace-pre text-cloud/80">
                {line.tokens.length
                  ? line.tokens.map((token, tokenIndex) => (
                      <span
                        key={`${tokenIndex}-${token.text.length}`}
                        className={token.className || undefined}
                      >
                        {token.text}
                      </span>
                    ))
                  : " "}
              </code>
            </div>
            {renderAfterLine?.(lineNumber)}
          </Fragment>
        );
      })}
    </div>
  );
}
