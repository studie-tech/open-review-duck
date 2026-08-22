"use client";

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
}: {
  lines: HighlightedLine[];
  startLine: number;
  className?: string;
}) {
  return (
    <div className={cn("py-4 font-mono text-[12px] leading-6", className)}>
      {lines.map((line, index) => (
        <div
          key={startLine + index}
          className="group hover:bg-surface-hover/45 flex min-h-6"
        >
          <span className="border-line/60 bg-code text-fog group-hover:bg-surface-hover sticky left-0 w-16 shrink-0 border-r pr-3 text-right select-none">
            {startLine + index}
          </span>
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
      ))}
    </div>
  );
}
