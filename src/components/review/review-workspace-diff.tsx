"use client";

import {
  Check,
  ChevronDown,
  Clock3,
  MessageCircleQuestionMark,
  MessageSquareText,
} from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  forwardRef,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { ShortcutHint } from "~/components/command-center";
import type { IndexedReviewUnit } from "~/lib/review-navigation";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import {
  compactSideBySideDiff,
  focusedRowRegions,
  focusedRowSpan,
  type SideBySideDiffRow,
  sideBySideDiff,
} from "~/lib/side-by-side-diff";
import { isPeekableToken, symbolPeekAttributes } from "~/lib/symbol-peek";
import {
  type HighlightedLine,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { HighlightedTokens } from "./highlighted-tokens";
import { CONTEXT_PAGE_LINES } from "./review-workspace-constants";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

/** Renders highlighted tokens while preserving symbol-peek affordances. */
function HighlightedDiffTokens({
  line,
  lineNumber,
}: {
  line: HighlightedLine | undefined;
  lineNumber?: number;
}) {
  return (
    <HighlightedTokens
      tokens={line?.tokens ?? []}
      renderToken={({ children, className, token }) =>
        isPeekableToken(token) ? (
          <span
            {...symbolPeekAttributes(token.text, lineNumber)}
            className={cn(
              "hover:decoration-cyan/45 rounded-sm hover:underline hover:decoration-dotted hover:underline-offset-4",
              className,
            )}
          >
            {children}
          </span>
        ) : (
          <span className={className}>{children}</span>
        )
      }
    />
  );
}

/** Renders one syntax-highlighted line without adding a second code block. */
function HighlightedDiffLine({
  line,
  lineNumber,
}: {
  line: HighlightedLine | undefined;
  lineNumber?: number;
}) {
  return (
    <pre className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
      <HighlightedDiffTokens line={line} lineNumber={lineNumber} />
    </pre>
  );
}

/** Reveals the next page beyond the unit edge, including any deferred edge gap. */
function DiffEdgeRevealButton({
  direction,
  collapsedRemaining,
  externalRemaining,
  onReveal,
}: {
  direction: -1 | 1;
  collapsedRemaining: number;
  externalRemaining: number;
  onReveal: () => void;
}) {
  const totalRemaining = collapsedRemaining + externalRemaining;
  if (totalRemaining <= 0) return null;
  const pageSize = Math.min(CONTEXT_PAGE_LINES, totalRemaining);
  const directionLabel = direction === -1 ? "above" : "below";
  const ariaLabel =
    collapsedRemaining > 0 && externalRemaining > 0
      ? `Show more lines ${directionLabel}`
      : collapsedRemaining > 0
        ? `Show ${pageSize} more lines ${directionLabel}`
        : `Show ${pageSize} lines ${directionLabel}`;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onReveal}
      className="text-fog hover:text-cloud flex w-full items-center justify-center gap-2 border-y border-line/50 bg-surface-subtle/40 px-3 py-1.5 font-sans text-[10px] transition"
    >
      <ChevronDown className={cn("size-3", direction === -1 && "rotate-180")} />
      {collapsedRemaining > 0 && externalRemaining > 0 ? (
        <>
          Show more {directionLabel}
          <span className="text-mist">
            next {pageSize} of {totalRemaining}
          </span>
        </>
      ) : collapsedRemaining > 0 ? (
        <>
          Show {pageSize} more lines {directionLabel}
          <span className="text-mist">({collapsedRemaining} hidden)</span>
        </>
      ) : (
        <>
          Show {pageSize} lines {directionLabel}
          <span className="text-mist">of {externalRemaining}</span>
        </>
      )}
      <ShortcutHint
        shortcut={
          direction === -1
            ? reviewShortcuts.revealContextAbove
            : reviewShortcuts.revealContextBelow
        }
      />
    </button>
  );
}

/** Reveals another page from an unchanged region inside the focused unit. */
function DiffCollapsedContextButton({
  count,
  revealed,
  onReveal,
}: {
  count: number;
  revealed: number;
  onReveal: () => void;
}) {
  const remaining = count - revealed;
  const pageSize = Math.min(CONTEXT_PAGE_LINES, remaining);
  return (
    <button
      type="button"
      aria-label={`Show ${pageSize} more unchanged lines`}
      onClick={onReveal}
      className="text-fog hover:text-cloud flex w-full items-center justify-center gap-2 border-y border-line/70 bg-surface-subtle/55 px-3 py-2 font-sans text-[10px] transition"
    >
      <ChevronDown className="size-3" />
      Show {pageSize} more unchanged lines
      <span className="text-mist">({remaining} hidden)</span>
    </button>
  );
}

export interface SideBySideUnitDiffHandle {
  revealContext: (direction: -1 | 1) => boolean;
}

/**
 * Amber already means "AI review finding" everywhere else in the workspace, so
 * a finding line stays legible as a claim rather than reading as the cyan line
 * picker, the violet composer, an addition or a deletion.
 */
const FINDING_LINE_HIGHLIGHT =
  "bg-amber-400/[.09] shadow-[inset_2px_0_0_rgb(245_158_11/.85)]";

/**
 * Reports whether a highlighted line is the review line a row stands for.
 */
function highlightsReviewLine(
  highlightedLine: number | undefined,
  reviewLine: number | undefined,
) {
  // A context row has no review line and an unset highlight has no line
  // either, so an unguarded equality would paint every context row.
  return highlightedLine !== undefined && highlightedLine === reviewLine;
}

interface SideBySideUnitDiffProps {
  previousSource: string;
  currentSource: string;
  language: string;
  previousStartLine: number;
  currentStartLine: number;
  previousFocusRanges?: Array<{ startLine: number; endLine: number }>;
  currentFocusRanges?: Array<{ startLine: number; endLine: number }>;
  previousFocusStartLine?: number | null;
  previousFocusEndLine?: number | null;
  currentFocusStartLine?: number | null;
  currentFocusEndLine?: number | null;
  selectedLine?: number;
  keyboardLine?: number;
  findingLine?: number;
  expanded?: boolean;
  onSelectReviewLine: (line: number) => void;
  onAskReviewLine?: (line: number) => void;
  isReviewLineCollapsed?: (line: number) => boolean;
  renderBeforeLine?: (line: number) => ReactNode;
  renderLineDetails?: (line: number) => ReactNode;
}

/**
 * Opens an AI conversation on the line the reviewer is pointing at.
 *
 * It sits beside the comment affordance because the two are the same reach:
 * a line the reviewer has a question about is as likely as one they have a
 * remark about, and neither should cost a trip through the line picker.
 */
export function AskAiLineButton({
  className,
  line,
  onAsk,
  visible = false,
}: {
  className?: string;
  line: number;
  onAsk: (line: number) => void;
  visible?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Ask AI about line ${line}`}
      title="Ask AI about this line"
      onClick={(event) => {
        // The gutter and the side-by-side row both answer clicks with the
        // comment composer, and this button sits inside their hit area.
        event.stopPropagation();
        onAsk(line);
      }}
      className={cn(
        "hover:text-violet grid shrink-0 place-items-center rounded transition-opacity",
        // The button stays in the tab order while the row is unhovered, so it
        // has to show itself on focus or the focus ring lands on nothing.
        visible
          ? "text-violet opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <MessageCircleQuestionMark className="size-3" aria-hidden="true" />
    </button>
  );
}

/** Separates the reviewed unit from surrounding source context. */
export function ReviewScopeMarker({
  edge,
  line,
}: {
  edge: "start" | "end";
  line: number;
}) {
  const label = edge === "start" ? "Unit starts" : "Unit ends";
  return (
    <div
      data-review-scope-edge={edge}
      className="my-2 flex items-center gap-3 px-4 font-sans"
    >
      <span className="text-cyan w-[66px] shrink-0 text-right text-[9px]">
        Review scope
      </span>
      <span className="h-px flex-1 bg-cyan/25" />
      <span className="border-cyan/20 bg-cyan/[.06] text-cyan rounded-full border px-2.5 py-1 text-[9px] whitespace-nowrap">
        {label} · line {line}
      </span>
    </div>
  );
}

interface DiffRowHighlightProps {
  isFinding: boolean;
  keyboardFocused: boolean;
  selected: boolean;
}

interface DiffRowActionProps {
  canAsk: boolean;
  onAsk: (line: number) => void;
  onSelect: (event: ReactMouseEvent<HTMLElement>, line: number) => void;
}

/**
 * Shows one line of an addition-only unit diff.
 *
 * The workspace above re-renders on scroll frames, AI stream chunks and
 * composer keystrokes, none of which move a row, so the highlight scalars
 * reach a row already reduced to booleans and a memoized row keeps its token
 * spans mounted through every event that does not touch it.
 */
const AddedUnitDiffRow = memo(function AddedUnitDiffRow({
  added,
  anchored,
  canAsk,
  isFinding,
  keyboardFocused,
  line,
  lineNumber,
  onAsk,
  onSelect,
  reviewLine,
  selected,
}: DiffRowHighlightProps &
  DiffRowActionProps & {
    added: boolean;
    anchored: boolean;
    line: HighlightedLine | undefined;
    lineNumber: number | undefined;
    reviewLine: number | undefined;
  }) {
  const LineContainer = reviewLine === undefined ? "div" : "button";
  return (
    <div className="group relative">
      <LineContainer
        {...(reviewLine !== undefined
          ? {
              type: "button" as const,
              "aria-label": `Comment on current line ${reviewLine}`,
              title: "Comment on this pull-request line",
              onClick: (event: ReactMouseEvent<HTMLElement>) =>
                onSelect(event, reviewLine),
            }
          : {})}
        id={anchored ? `review-line-${reviewLine}` : undefined}
        data-review-scope={reviewLine === undefined ? "context" : "unit"}
        className={cn(
          // Wide enough to hold the ask affordance that sits over the
          // gutter's leading edge, a comment icon and a four-digit line
          // number without crowding any of them.
          "grid w-full grid-cols-[82px_minmax(0,1fr)] text-left",
          added ? "bg-addition/15" : "bg-surface-subtle/20",
          reviewLine !== undefined &&
            "cursor-pointer transition select-text hover:bg-addition/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
          isFinding && FINDING_LINE_HIGHLIGHT,
          selected && "bg-violet/[.055]",
          keyboardFocused &&
            "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
          reviewLine === undefined &&
            "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
        )}
      >
        <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 text-addition transition select-none group-hover:text-violet">
          {reviewLine !== undefined && (
            <MessageSquareText
              className={cn(
                "size-3 transition-opacity",
                selected || keyboardFocused
                  ? "text-cyan opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
            />
          )}
          {lineNumber}
        </span>
        <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
          <HighlightedDiffTokens line={line} lineNumber={lineNumber} />
        </span>
      </LineContainer>
      {reviewLine !== undefined && canAsk && (
        <AskAiLineButton
          className="absolute top-1/2 left-1.5 size-4 -translate-y-1/2"
          line={reviewLine}
          onAsk={onAsk}
        />
      )}
    </div>
  );
});

/** Tailwind's `sm` breakpoint, where a row fits both sides of the diff. */
const SIDE_BY_SIDE_DIFF_QUERY = "(min-width: 40rem)";

/** Watches the viewport for the width the two-column diff needs. */
function subscribeSideBySideWidth(onStoreChange: () => void) {
  const query = window.matchMedia(SIDE_BY_SIDE_DIFF_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

/** Reports whether the viewport has room for the two-column diff. */
function sideBySideWidth() {
  return window.matchMedia(SIDE_BY_SIDE_DIFF_QUERY).matches;
}

/** Assumes the two-column diff where there is no viewport to measure. */
function serverSideBySideWidth() {
  return true;
}

/**
 * Shows one aligned base/head row of a unit diff.
 *
 * The wide and the narrow layout differ in structure rather than in styling,
 * so the row picks one: an expanded file holds hundreds of rows, and mounting
 * both layouts behind visibility classes would double every token span.
 *
 * Memoized for the same reason as `AddedUnitDiffRow`: an expanded file holds
 * hundreds of rows whose tokens no workspace event changes.
 */
const SplitUnitDiffRow = memo(function SplitUnitDiffRow({
  canAsk,
  currentLine,
  currentLineNumber,
  currentReviewLine,
  isFinding,
  keyboardFocused,
  kind,
  onAsk,
  onSelect,
  previousLine,
  previousLineNumber,
  previousReviewLine,
  selected,
  sideBySide,
}: DiffRowHighlightProps &
  DiffRowActionProps & {
    currentLine: HighlightedLine | undefined;
    currentLineNumber: number | undefined;
    currentReviewLine: number | undefined;
    kind: SideBySideDiffRow["kind"];
    previousLine: HighlightedLine | undefined;
    previousLineNumber: number | undefined;
    previousReviewLine: number | undefined;
    sideBySide: boolean;
  }) {
  // A row commentable on both sides is commented through the head line, so at
  // most one side carries the provider line and the other is always unset.
  const reviewLine = currentReviewLine ?? previousReviewLine;
  if (sideBySide) {
    return (
      <div
        data-review-scope={reviewLine === undefined ? "context" : "unit"}
        className={cn(
          "group relative grid grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)]",
          reviewLine === undefined &&
            "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
        )}
      >
        {reviewLine !== undefined && canAsk && (
          <AskAiLineButton
            className="bg-panel/90 absolute top-1/2 right-2 z-10 size-5 -translate-y-1/2 rounded-md border border-line shadow-sm"
            line={reviewLine}
            onAsk={onAsk}
          />
        )}
        {previousReviewLine !== undefined ? (
          <button
            type="button"
            aria-label={`Comment on deleted line ${previousReviewLine}`}
            title="Comment on this deleted pull-request line"
            onClick={(event) => onSelect(event, previousReviewLine)}
            className={cn(
              "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] bg-red-400/15 text-left transition select-text hover:bg-red-400/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
              isFinding && FINDING_LINE_HIGHLIGHT,
              selected && "bg-violet/[.055]",
              keyboardFocused &&
                "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
            )}
          >
            <span className="flex items-center justify-end gap-1 border-r border-line/60 bg-red-400/10 px-2 text-red-700 transition select-none group-hover:text-violet dark:text-red-200">
              <MessageSquareText
                className={cn(
                  "size-3 transition-opacity",
                  selected || keyboardFocused
                    ? "text-cyan opacity-100"
                    : "opacity-0 group-hover:opacity-100",
                )}
              />
              {previousLineNumber}
            </span>
            <HighlightedDiffLine line={previousLine} />
          </button>
        ) : (
          <>
            <span
              className={cn(
                "flex justify-end border-r border-line/60 px-2 text-fog select-none",
                (kind === "deleted" || kind === "modified") &&
                  "bg-red-400/10 text-red-700 dark:text-red-200",
              )}
            >
              {previousLineNumber}
            </span>
            <div
              className={cn(
                "min-w-0 border-r border-line",
                (kind === "deleted" || kind === "modified") && "bg-red-400/15",
              )}
            >
              <HighlightedDiffLine line={previousLine} />
            </div>
          </>
        )}
        {currentLineNumber === undefined ? (
          <span className="col-span-2" />
        ) : currentReviewLine === undefined ? (
          <div
            className={cn(
              "col-span-2 grid min-w-0 grid-cols-[42px_minmax(0,1fr)] text-fog",
              (kind === "added" || kind === "modified") && "bg-addition/15",
            )}
          >
            <span
              className={cn(
                "flex justify-end border-r border-line/60 px-2 select-none",
                (kind === "added" || kind === "modified") &&
                  "bg-addition/12 text-addition",
              )}
            >
              {currentLineNumber}
            </span>
            <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
              <HighlightedDiffTokens
                line={currentLine}
                lineNumber={currentLineNumber}
              />
            </span>
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Comment on current line ${currentReviewLine}`}
            title="Comment on this pull-request line"
            onClick={(event) => onSelect(event, currentReviewLine)}
            className={cn(
              "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition select-text hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
              (kind === "added" || kind === "modified") &&
                "bg-addition/15 hover:bg-addition/22",
              isFinding && FINDING_LINE_HIGHLIGHT,
              selected && "bg-violet/[.055]",
              keyboardFocused &&
                "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
            )}
          >
            <span
              className={cn(
                "flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet",
                (kind === "added" || kind === "modified") &&
                  "bg-addition/12 text-addition",
              )}
            >
              <MessageSquareText
                className={cn(
                  "size-3 transition-opacity",
                  selected || keyboardFocused
                    ? "text-cyan opacity-100"
                    : "opacity-0 group-hover:opacity-100",
                )}
              />
              {currentLineNumber}
            </span>
            <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
              <HighlightedDiffTokens
                line={currentLine}
                lineNumber={currentLineNumber}
              />
            </span>
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      data-review-scope={reviewLine === undefined ? "context" : "unit"}
      className={cn(
        "group relative",
        reviewLine === undefined &&
          "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
      )}
    >
      {reviewLine !== undefined && canAsk && (
        <AskAiLineButton
          className="bg-panel/90 absolute top-1/2 right-2 z-10 size-5 -translate-y-1/2 rounded-md border border-line shadow-sm"
          line={reviewLine}
          onAsk={onAsk}
        />
      )}
      {kind === "unchanged" ? (
        <div
          className={cn(
            "grid grid-cols-[42px_42px_minmax(0,1fr)]",
            isFinding && FINDING_LINE_HIGHLIGHT,
            selected && "bg-violet/[.055]",
            keyboardFocused &&
              "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
          )}
        >
          <span className="text-fog border-r border-line/60 px-2 text-right select-none">
            {previousLineNumber}
          </span>
          {currentReviewLine !== undefined ? (
            <button
              type="button"
              aria-label={`Comment on current line ${currentReviewLine}`}
              title="Comment on this pull-request line"
              onClick={(event) => onSelect(event, currentReviewLine)}
              className="group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition select-text hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
            >
              <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet">
                <MessageSquareText
                  className={cn(
                    "size-3 transition-opacity",
                    selected || keyboardFocused
                      ? "text-cyan opacity-100"
                      : "opacity-0 group-hover:opacity-100",
                  )}
                />
                {currentLineNumber}
              </span>
              <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                <HighlightedDiffTokens
                  line={currentLine}
                  lineNumber={currentLineNumber}
                />
              </span>
            </button>
          ) : (
            <>
              <span className="text-fog border-r border-line/60 px-2 text-right select-none">
                {currentLineNumber}
              </span>
              <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                <HighlightedDiffTokens
                  line={currentLine}
                  lineNumber={currentLineNumber}
                />
              </span>
            </>
          )}
        </div>
      ) : (
        <>
          {previousLine &&
            (previousReviewLine !== undefined ? (
              <button
                type="button"
                aria-label={`Comment on deleted line ${previousReviewLine}`}
                title="Comment on this deleted pull-request line"
                onClick={(event) => onSelect(event, previousReviewLine)}
                className={cn(
                  "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/15 text-left transition select-text hover:bg-red-400/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                  isFinding && FINDING_LINE_HIGHLIGHT,
                  selected && "bg-violet/[.055]",
                  keyboardFocused &&
                    "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                )}
              >
                <span className="bg-red-400/10 px-2 text-right text-red-700 select-none dark:text-red-200">
                  {previousLineNumber}
                </span>
                <span className="flex items-center justify-center gap-1 border-x border-line/60 px-2 text-red-700 transition select-none group-hover:text-violet dark:text-red-200">
                  <MessageSquareText
                    className={cn(
                      "size-3 transition-opacity",
                      selected || keyboardFocused
                        ? "text-cyan opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                  />
                  −
                </span>
                <HighlightedDiffLine line={previousLine} />
              </button>
            ) : (
              <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/15">
                <span className="bg-red-400/10 px-2 text-right text-red-700 select-none dark:text-red-200">
                  {previousLineNumber}
                </span>
                <span className="border-x border-line/60 px-2 text-center text-red-700 select-none dark:text-red-200">
                  −
                </span>
                <HighlightedDiffLine line={previousLine} />
              </div>
            ))}
          {currentLine &&
            (currentReviewLine !== undefined ? (
              <button
                type="button"
                aria-label={`Comment on current line ${currentReviewLine}`}
                title="Comment on this pull-request line"
                onClick={(event) => onSelect(event, currentReviewLine)}
                className={cn(
                  "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/15 text-left transition select-text hover:bg-addition/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                  isFinding && FINDING_LINE_HIGHLIGHT,
                  selected && "bg-violet/[.055]",
                  keyboardFocused &&
                    "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                )}
              >
                <span className="px-2 text-right text-addition select-none">
                  {currentLineNumber}
                </span>
                <span className="flex items-center justify-center gap-1 border-x border-line/60 px-2 text-addition transition select-none group-hover:text-violet">
                  <MessageSquareText
                    className={cn(
                      "size-3 transition-opacity",
                      selected || keyboardFocused
                        ? "text-cyan opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                  />
                  +
                </span>
                <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                  <HighlightedDiffTokens
                    line={currentLine}
                    lineNumber={currentLineNumber}
                  />
                </span>
              </button>
            ) : (
              <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/15">
                <span className="px-2 text-right text-addition select-none">
                  {currentLineNumber}
                </span>
                <span className="border-x border-line/60 px-2 text-center text-addition select-none">
                  +
                </span>
                <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                  <HighlightedDiffTokens
                    line={currentLine}
                    lineNumber={currentLineNumber}
                  />
                </span>
              </div>
            ))}
        </>
      )}
    </div>
  );
});

/** Shows a focused base/head diff with aligned lines and provider comment actions. */
export const SideBySideUnitDiff = forwardRef<
  SideBySideUnitDiffHandle,
  SideBySideUnitDiffProps
>(function SideBySideUnitDiff(
  {
    previousSource,
    currentSource,
    language,
    previousStartLine,
    currentStartLine,
    previousFocusRanges,
    currentFocusRanges,
    previousFocusStartLine,
    previousFocusEndLine,
    currentFocusStartLine,
    currentFocusEndLine,
    selectedLine,
    keyboardLine,
    findingLine,
    expanded = false,
    onSelectReviewLine,
    onAskReviewLine,
    isReviewLineCollapsed,
    renderBeforeLine,
    renderLineDetails,
  },
  ref,
) {
  // The workspace rebuilds both line handlers on every render, so the rows
  // reach them through a ref instead: memoized rows that only ever see stable
  // callbacks sit out the scroll frames and keystrokes above them.
  const lineHandlersRef = useRef({ onAskReviewLine, onSelectReviewLine });
  useEffect(() => {
    lineHandlersRef.current = { onAskReviewLine, onSelectReviewLine };
  }, [onAskReviewLine, onSelectReviewLine]);
  // One subscription for the whole diff: the rows below read the breakpoint
  // from it instead of each mounting a wide and a narrow copy of itself.
  const sideBySide = useSyncExternalStore(
    subscribeSideBySideWidth,
    sideBySideWidth,
    serverSideBySideWidth,
  );
  const previousLines = useHighlightedSource(previousSource, language);
  const currentLines = useHighlightedSource(currentSource, language);
  const rows = useMemo(
    () => sideBySideDiff(previousSource, currentSource),
    [currentSource, previousSource],
  );
  const focusRange = useMemo(() => {
    const previousRanges =
      previousFocusRanges ??
      (previousFocusStartLine === null
        ? []
        : [
            {
              startLine: previousFocusStartLine ?? previousStartLine,
              endLine:
                previousFocusEndLine ??
                previousStartLine + Math.max(0, previousLines.length - 1),
            },
          ]);
    const currentRanges =
      currentFocusRanges ??
      (currentFocusStartLine === null
        ? []
        : [
            {
              startLine: currentFocusStartLine ?? currentStartLine,
              endLine:
                currentFocusEndLine ??
                currentStartLine + Math.max(0, currentLines.length - 1),
            },
          ]);
    const previousStart =
      previousRanges.length > 0
        ? Math.min(...previousRanges.map(({ startLine }) => startLine))
        : undefined;
    const previousEnd =
      previousRanges.length > 0
        ? Math.max(...previousRanges.map(({ endLine }) => endLine))
        : undefined;
    const currentStart =
      currentRanges.length > 0
        ? Math.min(...currentRanges.map(({ startLine }) => startLine))
        : undefined;
    const currentEnd =
      currentRanges.length > 0
        ? Math.max(...currentRanges.map(({ endLine }) => endLine))
        : undefined;
    const span = focusedRowSpan({
      rows,
      previousStartLine,
      currentStartLine,
      previousRanges,
      currentRanges,
      multiRange:
        previousFocusRanges !== undefined || currentFocusRanges !== undefined,
    });
    return {
      start: span.start,
      end: span.end,
      previousStart,
      previousEnd,
      currentStart,
      currentEnd,
      previousRanges,
      currentRanges,
      // Only a declaration stating several ranges leaves gaps holding other
      // declarations; a single range has none, and asking for its regions
      // would collapse the surrounding source a reviewer paged in.
      ownRegions:
        previousFocusRanges !== undefined || currentFocusRanges !== undefined
          ? focusedRowRegions({
              rows,
              previousStartLine,
              currentStartLine,
              previousRanges,
              currentRanges,
            })
          : undefined,
    };
  }, [
    currentFocusEndLine,
    currentFocusRanges,
    currentFocusStartLine,
    currentLines.length,
    currentStartLine,
    previousFocusEndLine,
    previousFocusRanges,
    previousFocusStartLine,
    previousLines.length,
    previousStartLine,
    rows,
  ]);
  const [contextBeforeRows, setContextBeforeRows] = useState(0);
  const [contextAfterRows, setContextAfterRows] = useState(0);
  const visibleRowStart = expanded
    ? 0
    : Math.max(0, focusRange.start - contextBeforeRows);
  const visibleRowEnd = expanded
    ? rows.length
    : Math.min(rows.length, focusRange.end + contextAfterRows);
  const visibleRows = useMemo(
    () => rows.slice(visibleRowStart, visibleRowEnd),
    [rows, visibleRowEnd, visibleRowStart],
  );
  const hasExplicitFocus =
    previousFocusRanges !== undefined ||
    currentFocusRanges !== undefined ||
    previousFocusStartLine !== undefined ||
    previousFocusEndLine !== undefined ||
    currentFocusStartLine !== undefined ||
    currentFocusEndLine !== undefined;
  const focusedRows = rows.slice(focusRange.start, focusRange.end);
  const explicitFocusHasDiff = focusedRows.some(
    (row) => row.kind !== "unchanged",
  );
  const compactRows = useMemo(() => {
    if (expanded) {
      return visibleRows.map((row, rowIndex) => ({
        kind: "row" as const,
        row,
        rowIndex,
      }));
    }
    const focusStart = Math.max(0, focusRange.start - visibleRowStart);
    const focusEnd = Math.min(
      visibleRows.length,
      Math.max(focusStart, focusRange.end - visibleRowStart),
    );
    const hasFocusWindow = hasExplicitFocus && focusEnd > focusStart;
    return compactSideBySideDiff(visibleRows, 3, {
      // Keep undiffed focus windows fully expanded.
      requiredRange:
        hasFocusWindow && !explicitFocusHasDiff
          ? { start: focusStart, end: focusEnd }
          : undefined,
      // Never recollapse paged surrounding file context — that yanks scroll.
      collapseWithin: hasFocusWindow
        ? { start: focusStart, end: focusEnd }
        : undefined,
      // Keep unit edges visible so trail compact never stacks with "show below".
      pinRangeEnds: hasFocusWindow && explicitFocusHasDiff ? 2 : 0,
      ownRegions: focusRange.ownRegions?.map(({ start, end }) => ({
        start: start - visibleRowStart,
        end: end - visibleRowStart,
      })),
    });
  }, [
    explicitFocusHasDiff,
    expanded,
    focusRange.end,
    focusRange.ownRegions,
    focusRange.start,
    hasExplicitFocus,
    visibleRowStart,
    visibleRows,
  ]);
  const [revealedGapLines, setRevealedGapLines] = useState<Map<string, number>>(
    () => new Map(),
  );
  const revealCollapsedGap = useCallback((key: string, count: number) => {
    setRevealedGapLines((current) => {
      const revealed = current.get(key) ?? 0;
      if (revealed >= count) return current;
      const next = new Map(current);
      next.set(key, Math.min(count, revealed + CONTEXT_PAGE_LINES));
      return next;
    });
  }, []);
  const revealEdge = useCallback(
    (direction: -1 | 1) => {
      const collapsedGaps = compactRows.filter(
        (
          item,
        ): item is Extract<
          (typeof compactRows)[number],
          { kind: "collapsed" }
        > => item.kind === "collapsed",
      );
      // Expand the collapse nearest the edge being scrolled, so pinned unit
      // ends still let ArrowUp/Down unfold the interior toward that edge.
      const gap = direction === -1 ? collapsedGaps[0] : collapsedGaps.at(-1);
      if (gap) {
        const key = `${visibleRowStart + gap.rowStart}-${visibleRowStart + gap.rowEnd}`;
        const revealed = revealedGapLines.get(key) ?? 0;
        if (revealed < gap.count) {
          revealCollapsedGap(key, gap.count);
          return true;
        }
      }
      if (direction === -1 && visibleRowStart > 0) {
        setContextBeforeRows((current) =>
          Math.min(focusRange.start, current + CONTEXT_PAGE_LINES),
        );
        return true;
      }
      if (direction === 1 && visibleRowEnd < rows.length) {
        setContextAfterRows((current) =>
          Math.min(rows.length - focusRange.end, current + CONTEXT_PAGE_LINES),
        );
        return true;
      }
      return false;
    },
    [
      compactRows,
      focusRange.end,
      focusRange.start,
      revealCollapsedGap,
      revealedGapLines,
      rows.length,
      visibleRowEnd,
      visibleRowStart,
    ],
  );
  // File-context paging only — unit interior uses in-flow collapse buttons.
  const leadingCollapsedRemaining = 0;
  const trailingCollapsedRemaining = 0;
  useImperativeHandle(
    ref,
    () => ({
      revealContext(direction) {
        return revealEdge(direction);
      },
    }),
    [revealEdge],
  );
  const displayItems = useMemo(
    () =>
      compactRows.flatMap((item) => {
        if (item.kind === "row") return [item];
        const key = `${visibleRowStart + item.rowStart}-${visibleRowStart + item.rowEnd}`;
        const revealed = Math.min(revealedGapLines.get(key) ?? 0, item.count);
        if (revealed === 0) return [item];
        if (revealed === item.count) {
          return visibleRows
            .slice(item.rowStart, item.rowEnd)
            .map((row, index) => ({
              kind: "row" as const,
              row,
              rowIndex: item.rowStart + index,
            }));
        }

        // Expand from the side nearest the change neighborhood defaults
        // kept: reveal symmetrically inside unit interior collapses.
        const revealedBefore = Math.ceil(revealed / 2);
        const revealedAfter = Math.floor(revealed / 2);
        const before = visibleRows
          .slice(item.rowStart, item.rowStart + revealedBefore)
          .map((row, index) => ({
            kind: "row" as const,
            row,
            rowIndex: item.rowStart + index,
          }));
        const afterStart = item.rowEnd - revealedAfter;
        const after = visibleRows
          .slice(afterStart, item.rowEnd)
          .map((row, index) => ({
            kind: "row" as const,
            row,
            rowIndex: afterStart + index,
          }));
        return [...before, item, ...after];
      }),
    [compactRows, revealedGapLines, visibleRowStart, visibleRows],
  );
  const additionOnly =
    focusedRows.length > 0 && focusedRows.every((row) => row.kind === "added");
  const scopeStartLine = focusRange.currentStart ?? focusRange.previousStart;
  const scopeEndLine = focusRange.currentEnd ?? focusRange.previousEnd;
  const showsContextBefore = visibleRowStart < focusRange.start;
  const showsContextAfter = visibleRowEnd > focusRange.end;

  /** Returns the provider-commentable line represented by one focused row. */
  function reviewLineForRow(row: (typeof rows)[number]) {
    const currentLine =
      row.currentIndex === undefined
        ? undefined
        : currentStartLine + row.currentIndex;
    if (
      currentLine !== undefined &&
      focusRange.currentRanges.some(
        ({ startLine, endLine }) =>
          currentLine >= startLine && currentLine <= endLine,
      )
    ) {
      return currentLine;
    }
    const previousLine =
      row.previousIndex === undefined
        ? undefined
        : previousStartLine + row.previousIndex;
    return previousLine !== undefined &&
      focusRange.previousRanges.some(
        ({ startLine, endLine }) =>
          previousLine >= startLine && previousLine <= endLine,
      )
      ? previousLine
      : undefined;
  }

  /** Opens a comment unless the pointer click completed a text selection. */
  const selectReviewLine = useCallback(
    (event: ReactMouseEvent<HTMLElement>, line: number) => {
      if (
        event.detail > 0 &&
        typeof window !== "undefined" &&
        window.getSelection()?.isCollapsed === false
      ) {
        return;
      }
      lineHandlersRef.current.onSelectReviewLine(line);
    },
    [],
  );

  /** Opens the inline AI conversation on the line a row stands for. */
  const askReviewLine = useCallback((line: number) => {
    lineHandlersRef.current.onAskReviewLine?.(line);
  }, []);
  const renderedDetailLines = new Set<number>();
  const renderedBeforeLines = new Set<number>();

  if (additionOnly) {
    return (
      <section
        aria-label="Added code diff"
        className="overflow-hidden rounded-b-xl border border-line"
      >
        {visibleRowStart > 0 || leadingCollapsedRemaining > 0 ? (
          <DiffEdgeRevealButton
            direction={-1}
            collapsedRemaining={leadingCollapsedRemaining}
            externalRemaining={visibleRowStart}
            onReveal={() => {
              revealEdge(-1);
            }}
          />
        ) : null}
        {displayItems.map((item) => {
          if (item.kind === "collapsed") {
            const absoluteStart = visibleRowStart + item.rowStart;
            const absoluteEnd = visibleRowStart + item.rowEnd;
            const key = `${absoluteStart}-${absoluteEnd}`;
            const revealed = revealedGapLines.get(key) ?? 0;
            return (
              <DiffCollapsedContextButton
                key={`gap-${key}`}
                count={item.count}
                revealed={revealed}
                onReveal={() => revealCollapsedGap(key, item.count)}
              />
            );
          }
          const { row } = item;
          const lineNumber =
            row.currentIndex === undefined
              ? undefined
              : currentStartLine + row.currentIndex;
          const line =
            row.currentIndex === undefined
              ? undefined
              : currentLines[row.currentIndex];
          const reviewLine = reviewLineForRow(row);
          const rendersLineDetails =
            reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
          if (rendersLineDetails) renderedDetailLines.add(reviewLine);
          const rendersBeforeLine =
            reviewLine !== undefined && !renderedBeforeLines.has(reviewLine);
          if (rendersBeforeLine) renderedBeforeLines.add(reviewLine);
          const lineCollapsed =
            reviewLine !== undefined && isReviewLineCollapsed?.(reviewLine);
          const absoluteRowIndex = visibleRowStart + item.rowIndex;
          const startsScope =
            showsContextBefore &&
            absoluteRowIndex === focusRange.start &&
            scopeStartLine !== undefined;
          const endsScope =
            showsContextAfter &&
            absoluteRowIndex === focusRange.end - 1 &&
            scopeEndLine !== undefined;
          return (
            <Fragment
              key={`${item.rowIndex}-${row.currentIndex ?? "x"}-${row.previousIndex ?? "x"}`}
            >
              {startsScope && (
                <ReviewScopeMarker edge="start" line={scopeStartLine} />
              )}
              {rendersBeforeLine && renderBeforeLine?.(reviewLine)}
              {!lineCollapsed && (
                <>
                  <AddedUnitDiffRow
                    added={row.kind === "added"}
                    anchored={rendersLineDetails}
                    canAsk={onAskReviewLine !== undefined}
                    isFinding={highlightsReviewLine(findingLine, reviewLine)}
                    keyboardFocused={highlightsReviewLine(
                      keyboardLine,
                      reviewLine,
                    )}
                    line={line}
                    lineNumber={lineNumber}
                    onAsk={askReviewLine}
                    onSelect={selectReviewLine}
                    reviewLine={reviewLine}
                    selected={highlightsReviewLine(selectedLine, reviewLine)}
                  />
                  {rendersLineDetails && renderLineDetails?.(reviewLine)}
                </>
              )}
              {endsScope && (
                <ReviewScopeMarker edge="end" line={scopeEndLine} />
              )}
            </Fragment>
          );
        })}
        {visibleRowEnd < rows.length || trailingCollapsedRemaining > 0 ? (
          <DiffEdgeRevealButton
            direction={1}
            collapsedRemaining={trailingCollapsedRemaining}
            externalRemaining={Math.max(0, rows.length - visibleRowEnd)}
            onReveal={() => {
              revealEdge(1);
            }}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label="Side-by-side code diff"
      className="overflow-hidden rounded-b-xl border border-line"
    >
      <div className="text-fog sticky top-0 z-10 hidden grid-cols-2 border-b border-line bg-panel/95 font-sans text-[9px] font-semibold tracking-[.12em] uppercase backdrop-blur sm:grid">
        <div className="border-r border-line px-4 py-2">Base</div>
        <div className="px-4 py-2">Pull request</div>
      </div>
      <div className="text-fog sticky top-0 z-10 border-b border-line bg-panel/95 px-4 py-2 font-sans text-[9px] font-semibold tracking-[.12em] uppercase backdrop-blur sm:hidden">
        Changes
      </div>
      {visibleRowStart > 0 || leadingCollapsedRemaining > 0 ? (
        <DiffEdgeRevealButton
          direction={-1}
          collapsedRemaining={leadingCollapsedRemaining}
          externalRemaining={visibleRowStart}
          onReveal={() => {
            revealEdge(-1);
          }}
        />
      ) : null}
      {displayItems.map((item) => {
        if (item.kind === "collapsed") {
          const key = `${visibleRowStart + item.rowStart}-${visibleRowStart + item.rowEnd}`;
          const revealed = revealedGapLines.get(key) ?? 0;
          return (
            <DiffCollapsedContextButton
              key={`gap-${key}`}
              count={item.count}
              revealed={revealed}
              onReveal={() => revealCollapsedGap(key, item.count)}
            />
          );
        }
        const { row, rowIndex } = item;
        const previousLineNumber =
          row.previousIndex === undefined
            ? undefined
            : previousStartLine + row.previousIndex;
        const currentLineNumber =
          row.currentIndex === undefined
            ? undefined
            : currentStartLine + row.currentIndex;
        const previousLine =
          row.previousIndex === undefined
            ? undefined
            : previousLines[row.previousIndex];
        const currentLine =
          row.currentIndex === undefined
            ? undefined
            : currentLines[row.currentIndex];
        const reviewLine = reviewLineForRow(row);
        const rendersLineDetails =
          reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
        if (rendersLineDetails) renderedDetailLines.add(reviewLine);
        const rendersBeforeLine =
          reviewLine !== undefined && !renderedBeforeLines.has(reviewLine);
        if (rendersBeforeLine) renderedBeforeLines.add(reviewLine);
        const lineCollapsed =
          reviewLine !== undefined && isReviewLineCollapsed?.(reviewLine);
        const currentIsReviewLine =
          reviewLine !== undefined &&
          currentLineNumber !== undefined &&
          reviewLine === currentLineNumber &&
          focusRange.currentRanges.some(
            ({ startLine, endLine }) =>
              currentLineNumber >= startLine && currentLineNumber <= endLine,
          );
        const previousIsReviewLine =
          reviewLine !== undefined &&
          previousLineNumber !== undefined &&
          reviewLine === previousLineNumber &&
          !currentIsReviewLine;
        const absoluteRowIndex = visibleRowStart + rowIndex;
        const startsScope =
          showsContextBefore &&
          absoluteRowIndex === focusRange.start &&
          scopeStartLine !== undefined;
        const endsScope =
          showsContextAfter &&
          absoluteRowIndex === focusRange.end - 1 &&
          scopeEndLine !== undefined;
        const key = `${rowIndex}-${row.previousIndex ?? "x"}-${row.currentIndex ?? "x"}`;
        return (
          <Fragment key={key}>
            {startsScope && (
              <ReviewScopeMarker edge="start" line={scopeStartLine} />
            )}
            {rendersBeforeLine && renderBeforeLine?.(reviewLine)}
            {!lineCollapsed && (
              <>
                {rendersLineDetails && (
                  <span
                    id={`review-line-${reviewLine}`}
                    className="block h-0"
                    aria-hidden="true"
                  />
                )}
                <SplitUnitDiffRow
                  canAsk={onAskReviewLine !== undefined}
                  currentLine={currentLine}
                  currentLineNumber={currentLineNumber}
                  currentReviewLine={
                    currentIsReviewLine ? reviewLine : undefined
                  }
                  isFinding={highlightsReviewLine(findingLine, reviewLine)}
                  keyboardFocused={highlightsReviewLine(
                    keyboardLine,
                    reviewLine,
                  )}
                  kind={row.kind}
                  onAsk={askReviewLine}
                  onSelect={selectReviewLine}
                  previousLine={previousLine}
                  previousLineNumber={previousLineNumber}
                  previousReviewLine={
                    previousIsReviewLine ? reviewLine : undefined
                  }
                  selected={highlightsReviewLine(selectedLine, reviewLine)}
                  sideBySide={sideBySide}
                />
                {rendersLineDetails && renderLineDetails?.(reviewLine)}
              </>
            )}
            {endsScope && <ReviewScopeMarker edge="end" line={scopeEndLine} />}
          </Fragment>
        );
      })}
      {visibleRowEnd < rows.length || trailingCollapsedRemaining > 0 ? (
        <DiffEdgeRevealButton
          direction={1}
          collapsedRemaining={trailingCollapsedRemaining}
          externalRemaining={Math.max(0, rows.length - visibleRowEnd)}
          onReveal={() => {
            revealEdge(1);
          }}
        />
      ) : null}
    </section>
  );
});

/** Displays a normalized error when an AI job cannot be started. */
export function showAiStartError(error: { message: string }) {
  if (error.message !== "Configure an AI provider first") {
    toast.error(error.message);
    return;
  }

  toast.error(error.message, {
    description: (
      <Link
        href="/settings/ai"
        className="text-lime hover:text-cloud mt-1 inline-flex items-center gap-2 font-medium underline underline-offset-4"
      >
        Set up provider
        <ShortcutHint shortcut={reviewShortcuts.aiSettings} />
      </Link>
    ),
    duration: 15_000,
  });
}

/** Renders the review path unit interface. */
export function ReviewPathUnit({
  entry,
  active,
  onSelect,
}: {
  entry: IndexedReviewUnit<ReviewUnit>;
  active: boolean;
  onSelect: (index: number) => void;
}) {
  const { unit, index } = entry;
  const fileName = unit.path.split("/").at(-1) ?? unit.path;
  const statusLabel =
    unit.status === "signed_off"
      ? "reviewed"
      : unit.status === "waiting"
        ? "waiting for response"
        : "not reviewed";

  return (
    <button
      type="button"
      aria-current={active ? "step" : undefined}
      aria-label={`${unit.name}, ${statusLabel}, dependency depth ${unit.depth}`}
      title={unit.path}
      onClick={() => onSelect(index)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
        active ? "bg-surface-hover" : "hover:bg-surface-subtle",
      )}
      style={{ paddingLeft: `${12 + Math.min(unit.depth, 4) * 5}px` }}
    >
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full",
          unit.status === "signed_off"
            ? "bg-lime text-accent-foreground"
            : unit.status === "waiting"
              ? "border border-cyan/35 bg-cyan/10 text-cyan"
              : active
                ? "bg-cyan/15 text-cyan"
                : unit.status === "changed"
                  ? "border border-amber-500/45 bg-amber-400/10"
                  : "border border-line-strong",
        )}
      >
        {unit.status === "signed_off" && (
          <Check className="size-2.5" strokeWidth={3} />
        )}
        {unit.status === "waiting" && <Clock3 className="size-2.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-[11px]">
          {unit.name}
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px] capitalize">
          {fileName} · {unit.kind} · depth {unit.depth}
        </span>
      </span>
    </button>
  );
}

/**
 * Provider page for this pull request, or the repository when that is all we have.
 *
 * GitHub, GitLab, and Azure already store the PR/MR web URL on the pull
 * request. The header must not invent a second URL scheme.
 */
