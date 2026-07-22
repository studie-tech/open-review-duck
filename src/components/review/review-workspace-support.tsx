"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ShortcutHint } from "~/components/command-center";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  type ImportReference,
  importReferenceIsUsed,
  parseImportStatements,
} from "~/lib/import-navigation";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import type {
  IndexedReviewUnit,
  ReviewHierarchyNode,
} from "~/lib/review-navigation";
import { compactSideBySideDiff, sideBySideDiff } from "~/lib/side-by-side-diff";
import { highlightSource } from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";
import {
  type SupportedLanguage,
  supportedLanguages,
} from "~/server/analysis/types";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./provider-comment-body";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

type ProviderConversationThread =
  RouterOutputs["review"]["providerConversations"]["threads"][number];

export const INITIAL_PATH_ITEMS = 10;
export const PATH_PAGE_SIZE = 20;
export const CONTEXT_PAGE_LINES = 20;
const DIFF_CONTEXT_PAGE_LINES = 20;
const HIGHLIGHT_CACHE_SIZE = 6;
export const reviewShortcuts = {
  nextUnit: [{ key: "j" }],
  nextUnitArrow: [{ key: "ArrowRight" }],
  previousUnit: [{ key: "k" }],
  previousUnitArrow: [{ key: "ArrowLeft" }],
  scrollUp: [{ key: "ArrowUp" }],
  scrollDown: [{ key: "ArrowDown" }],
  togglePathPanel: [{ key: "[" }],
  toggleInsightsPanel: [{ key: "]" }],
  nextPending: [{ key: "n" }],
  search: [{ key: "/" }],
  explainMenu: [{ key: "e" }],
  explainUnit: [{ key: "e" }, { key: "e" }],
  explainPending: [{ key: "e" }, { key: "a" }],
  reviewPullRequest: [{ key: "e" }, { key: "r" }],
  comment: [{ key: "l" }],
  context: [{ key: "c" }],
  signOff: [{ key: "s" }],
  undoReview: [{ key: "u" }],
  awaitResponse: [{ key: "w" }],
  refresh: [{ key: "r" }],
  reset: [{ key: "r", shift: true }],
  loadChanges: [{ key: "r" }],
  dashboard: [{ key: "g" }, { key: "r" }],
  aiSettings: [{ key: "g" }, { key: "a" }],
  postComment: [{ key: "Enter", mod: true }],
} satisfies Record<string, KeyboardShortcut>;

export interface AiActionMenuItem {
  description: string;
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onSelect: () => void;
  shortcut: KeyboardShortcut;
}

/** Renders the compact AI action menu used by mouse and keyboard reviewers. */
export function AiActionMenu({
  disabled = false,
  fullWidth = false,
  items,
}: {
  disabled?: boolean;
  fullWidth?: boolean;
  items: AiActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    /** Closes the menu after clicking elsewhere or pressing Escape. */
    function closeMenu(event: PointerEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [open]);

  return (
    <div
      ref={menuRef}
      className={cn("relative shrink-0", fullWidth && "w-full")}
    >
      <Button
        size="sm"
        variant="secondary"
        className={cn(fullWidth && "w-full justify-between")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2">
          <Sparkles className="size-3.5" />
          AI assistance
        </span>
        <span className="flex items-center gap-2">
          <ShortcutHint shortcut={reviewShortcuts.explainMenu} />
          <ChevronDown
            className={cn("size-3 transition-transform", open && "rotate-180")}
          />
        </span>
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="AI review actions"
          className="bg-panel absolute top-[calc(100%+0.5rem)] right-0 z-50 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line-strong p-1.5 shadow-2xl shadow-black/20"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="hover:bg-surface-hover focus-visible:bg-surface-hover flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition outline-none disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="text-violet mt-0.5 grid size-5 shrink-0 place-items-center">
                {item.loading ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-cloud block text-xs font-medium">
                  {item.label}
                </span>
                <span className="text-fog mt-0.5 block text-[10px] leading-4">
                  {item.description}
                </span>
              </span>
              <ShortcutHint shortcut={item.shortcut} className="mt-0.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type HighlightCache = Map<
  string,
  { source: string; lines: ReturnType<typeof highlightSource> }
>;

/** Stores a highlighted unit while keeping review-workspace memory bounded. */
export function cacheHighlightedUnit(
  cache: HighlightCache,
  unitId: string,
  source: string,
  lines: ReturnType<typeof highlightSource>,
) {
  cache.delete(unitId);
  cache.set(unitId, { source, lines });
  while (cache.size > HIGHLIGHT_CACHE_SIZE) {
    const oldestUnitId = cache.keys().next().value;
    if (!oldestUnitId) break;
    cache.delete(oldestUnitId);
  }
}

/** Renders reusable syntax-highlighted tokens for static and interactive rows. */
function HighlightedDiffTokens({
  line,
}: {
  line: ReturnType<typeof highlightSource>[number] | undefined;
}) {
  return line?.tokens.length
    ? line.tokens.map((token, index) => (
        <span
          key={`${index}-${token.text.length}`}
          className={token.className || undefined}
        >
          {token.text}
        </span>
      ))
    : " ";
}

/** Renders one syntax-highlighted line without adding a second code block. */
function HighlightedDiffLine({
  line,
}: {
  line: ReturnType<typeof highlightSource>[number] | undefined;
}) {
  return (
    <pre className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
      <HighlightedDiffTokens line={line} />
    </pre>
  );
}

/** Reveals another page beyond the currently focused diff unit. */
function DiffExternalContextButton({
  direction,
  remaining,
  onReveal,
}: {
  direction: -1 | 1;
  remaining: number;
  onReveal: () => void;
}) {
  const pageSize = Math.min(DIFF_CONTEXT_PAGE_LINES, remaining);
  return (
    <button
      type="button"
      aria-label={`Show ${pageSize} lines ${direction === -1 ? "above" : "below"}`}
      onClick={onReveal}
      className="text-fog hover:text-cloud flex w-full items-center justify-center gap-2 border-y border-line/70 bg-surface-subtle/55 px-3 py-2 font-sans text-[10px] transition"
    >
      <ChevronDown className={cn("size-3", direction === -1 && "rotate-180")} />
      Show {pageSize} lines {direction === -1 ? "above" : "below"}
      <span className="text-mist">({remaining} available)</span>
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
  const pageSize = Math.min(DIFF_CONTEXT_PAGE_LINES, remaining);
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

interface SideBySideUnitDiffProps {
  previousSource: string;
  currentSource: string;
  language: string;
  previousStartLine: number;
  currentStartLine: number;
  previousFocusStartLine?: number | null;
  previousFocusEndLine?: number | null;
  currentFocusStartLine?: number | null;
  currentFocusEndLine?: number | null;
  selectedLine?: number;
  keyboardLine?: number;
  onSelectReviewLine: (line: number) => void;
  renderLineDetails?: (line: number) => ReactNode;
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
      <span className="text-cyan w-[55px] shrink-0 text-right text-[9px]">
        Review scope
      </span>
      <span className="h-px flex-1 bg-cyan/25" />
      <span className="border-cyan/20 bg-cyan/[.06] text-cyan rounded-full border px-2.5 py-1 text-[9px] whitespace-nowrap">
        {label} · line {line}
      </span>
    </div>
  );
}

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
    previousFocusStartLine,
    previousFocusEndLine,
    currentFocusStartLine,
    currentFocusEndLine,
    selectedLine,
    keyboardLine,
    onSelectReviewLine,
    renderLineDetails,
  },
  ref,
) {
  const previousLines = useMemo(
    () => highlightSource(previousSource, language),
    [language, previousSource],
  );
  const currentLines = useMemo(
    () => highlightSource(currentSource, language),
    [currentSource, language],
  );
  const rows = useMemo(
    () => sideBySideDiff(previousSource, currentSource),
    [currentSource, previousSource],
  );
  const focusRange = useMemo(() => {
    const previousStart =
      previousFocusStartLine === null
        ? undefined
        : (previousFocusStartLine ?? previousStartLine);
    const previousEnd =
      previousFocusEndLine === null || previousStart === undefined
        ? undefined
        : (previousFocusEndLine ??
          previousStartLine + Math.max(0, previousLines.length - 1));
    const currentStart =
      currentFocusStartLine === null
        ? undefined
        : (currentFocusStartLine ?? currentStartLine);
    const currentEnd =
      currentFocusEndLine === null || currentStart === undefined
        ? undefined
        : (currentFocusEndLine ??
          currentStartLine + Math.max(0, currentLines.length - 1));
    const focusedIndexes = rows.flatMap((row, rowIndex) => {
      const previousLine =
        row.previousIndex === undefined
          ? undefined
          : previousStartLine + row.previousIndex;
      const currentLine =
        row.currentIndex === undefined
          ? undefined
          : currentStartLine + row.currentIndex;
      return (previousLine !== undefined &&
        previousStart !== undefined &&
        previousEnd !== undefined &&
        previousLine >= previousStart &&
        previousLine <= previousEnd) ||
        (currentLine !== undefined &&
          currentStart !== undefined &&
          currentEnd !== undefined &&
          currentLine >= currentStart &&
          currentLine <= currentEnd)
        ? [rowIndex]
        : [];
    });
    return {
      start: focusedIndexes[0] ?? 0,
      end: (focusedIndexes.at(-1) ?? Math.max(0, rows.length - 1)) + 1,
      previousStart,
      previousEnd,
      currentStart,
      currentEnd,
    };
  }, [
    currentFocusEndLine,
    currentFocusStartLine,
    currentLines.length,
    currentStartLine,
    previousFocusEndLine,
    previousFocusStartLine,
    previousLines.length,
    previousStartLine,
    rows,
  ]);
  const [contextBeforeRows, setContextBeforeRows] = useState(0);
  const [contextAfterRows, setContextAfterRows] = useState(0);
  const visibleRowStart = Math.max(0, focusRange.start - contextBeforeRows);
  const visibleRowEnd = Math.min(
    rows.length,
    focusRange.end + contextAfterRows,
  );
  const visibleRows = useMemo(
    () => rows.slice(visibleRowStart, visibleRowEnd),
    [rows, visibleRowEnd, visibleRowStart],
  );
  const hasExplicitFocus =
    previousFocusStartLine !== undefined ||
    previousFocusEndLine !== undefined ||
    currentFocusStartLine !== undefined ||
    currentFocusEndLine !== undefined;
  const focusedRows = rows.slice(focusRange.start, focusRange.end);
  const explicitFocusHasDiff = focusedRows.some(
    (row) => row.kind !== "unchanged",
  );
  const compactRows = useMemo(
    () =>
      compactSideBySideDiff(
        visibleRows,
        3,
        hasExplicitFocus && !explicitFocusHasDiff
          ? {
              start: focusRange.start - visibleRowStart,
              end: focusRange.end - visibleRowStart,
            }
          : undefined,
      ),
    [
      focusRange.end,
      focusRange.start,
      hasExplicitFocus,
      explicitFocusHasDiff,
      visibleRowStart,
      visibleRows,
    ],
  );
  const [revealedGapLines, setRevealedGapLines] = useState<Map<string, number>>(
    () => new Map(),
  );
  useImperativeHandle(
    ref,
    () => ({
      revealContext(direction) {
        const gap = compactRows
          .filter((item) => item.kind === "collapsed")
          .find((item) =>
            direction === -1
              ? item.rowStart === 0
              : item.rowEnd === visibleRows.length,
          );
        if (gap) {
          const key = `${visibleRowStart + gap.rowStart}-${visibleRowStart + gap.rowEnd}`;
          if ((revealedGapLines.get(key) ?? 0) < gap.count) {
            setRevealedGapLines((current) => {
              const next = new Map(current);
              next.set(
                key,
                Math.min(
                  gap.count,
                  (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
                ),
              );
              return next;
            });
            return true;
          }
        }
        if (direction === -1 && visibleRowStart > 0) {
          setContextBeforeRows((current) =>
            Math.min(focusRange.start, current + DIFF_CONTEXT_PAGE_LINES),
          );
          return true;
        }
        if (direction === 1 && visibleRowEnd < rows.length) {
          setContextAfterRows((current) =>
            Math.min(
              rows.length - focusRange.end,
              current + DIFF_CONTEXT_PAGE_LINES,
            ),
          );
          return true;
        }
        return false;
      },
    }),
    [
      compactRows,
      focusRange.end,
      focusRange.start,
      revealedGapLines,
      rows.length,
      visibleRowEnd,
      visibleRows.length,
      visibleRowStart,
    ],
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

        const leading = item.rowStart === 0;
        const trailing = item.rowEnd === rows.length;
        const revealedBefore = leading
          ? 0
          : trailing
            ? revealed
            : Math.ceil(revealed / 2);
        const revealedAfter = leading
          ? revealed
          : trailing
            ? 0
            : Math.floor(revealed / 2);
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
    [compactRows, revealedGapLines, visibleRowStart, visibleRows, rows.length],
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
      focusRange.currentStart !== undefined &&
      focusRange.currentEnd !== undefined &&
      currentLine >= focusRange.currentStart &&
      currentLine <= focusRange.currentEnd
    ) {
      return currentLine;
    }
    const previousLine =
      row.previousIndex === undefined
        ? undefined
        : previousStartLine + row.previousIndex;
    return previousLine !== undefined &&
      focusRange.previousStart !== undefined &&
      focusRange.previousEnd !== undefined &&
      previousLine >= focusRange.previousStart &&
      previousLine <= focusRange.previousEnd
      ? previousLine
      : undefined;
  }

  if (additionOnly) {
    return (
      <section
        aria-label="Added code diff"
        className="overflow-hidden rounded-b-xl border border-line"
      >
        <div className="text-fog sticky top-0 z-10 border-b border-line bg-panel/95 px-4 py-2 font-sans text-[9px] font-semibold tracking-[.12em] uppercase backdrop-blur">
          Pull request
        </div>
        {visibleRowStart > 0 && (
          <DiffExternalContextButton
            direction={-1}
            remaining={visibleRowStart}
            onReveal={() =>
              setContextBeforeRows((current) =>
                Math.min(focusRange.start, current + DIFF_CONTEXT_PAGE_LINES),
              )
            }
          />
        )}
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
                onReveal={() =>
                  setRevealedGapLines((current) => {
                    const next = new Map(current);
                    next.set(
                      key,
                      Math.min(
                        item.count,
                        (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
                      ),
                    );
                    return next;
                  })
                }
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
          const interactive = reviewLine !== undefined;
          const absoluteRowIndex = visibleRowStart + item.rowIndex;
          const isContextRow = reviewLine === undefined;
          const startsScope =
            showsContextBefore &&
            absoluteRowIndex === focusRange.start &&
            scopeStartLine !== undefined;
          const endsScope =
            showsContextAfter &&
            absoluteRowIndex === focusRange.end - 1 &&
            scopeEndLine !== undefined;
          const LineContainer = interactive ? "button" : "div";
          return (
            <Fragment
              key={`${item.rowIndex}-${row.currentIndex ?? "x"}-${row.previousIndex ?? "x"}`}
            >
              {startsScope && (
                <ReviewScopeMarker edge="start" line={scopeStartLine} />
              )}
              <LineContainer
                {...(interactive
                  ? {
                      type: "button" as const,
                      "aria-label": `Comment on current line ${reviewLine}`,
                      title: "Comment on this pull-request line",
                      onClick: () => onSelectReviewLine(reviewLine),
                    }
                  : {})}
                id={
                  reviewLine === undefined
                    ? undefined
                    : `review-line-${reviewLine}`
                }
                data-review-scope={isContextRow ? "context" : "unit"}
                className={cn(
                  "group grid w-full grid-cols-[50px_minmax(0,1fr)] text-left",
                  row.kind === "added"
                    ? "bg-addition/[.085]"
                    : "bg-surface-subtle/20",
                  interactive &&
                    "cursor-pointer transition hover:bg-addition/[.13] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                  selectedLine === reviewLine && "bg-violet/[.055]",
                  keyboardLine === reviewLine &&
                    "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  isContextRow &&
                    "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
                )}
              >
                <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 text-addition transition select-none group-hover:text-violet">
                  {interactive && (
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
                          ? "text-cyan opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                  )}
                  {lineNumber}
                </span>
                <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                  <HighlightedDiffTokens line={line} />
                </span>
              </LineContainer>
              {reviewLine !== undefined && renderLineDetails?.(reviewLine)}
              {endsScope && (
                <ReviewScopeMarker edge="end" line={scopeEndLine} />
              )}
            </Fragment>
          );
        })}
        {visibleRowEnd < rows.length && (
          <DiffExternalContextButton
            direction={1}
            remaining={rows.length - visibleRowEnd}
            onReveal={() =>
              setContextAfterRows((current) =>
                Math.min(
                  rows.length - focusRange.end,
                  current + DIFF_CONTEXT_PAGE_LINES,
                ),
              )
            }
          />
        )}
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
      {visibleRowStart > 0 && (
        <DiffExternalContextButton
          direction={-1}
          remaining={visibleRowStart}
          onReveal={() =>
            setContextBeforeRows((current) =>
              Math.min(focusRange.start, current + DIFF_CONTEXT_PAGE_LINES),
            )
          }
        />
      )}
      {displayItems.map((item) => {
        if (item.kind === "collapsed") {
          const key = `${visibleRowStart + item.rowStart}-${visibleRowStart + item.rowEnd}`;
          const revealed = revealedGapLines.get(key) ?? 0;
          return (
            <DiffCollapsedContextButton
              key={`gap-${key}`}
              count={item.count}
              revealed={revealed}
              onReveal={() =>
                setRevealedGapLines((current) => {
                  const next = new Map(current);
                  next.set(
                    key,
                    Math.min(
                      item.count,
                      (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
                    ),
                  );
                  return next;
                })
              }
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
        const previousIsReviewLine =
          reviewLine !== undefined &&
          reviewLine === previousLineNumber &&
          focusRange.currentStart === undefined;
        const currentIsReviewLine =
          reviewLine !== undefined && reviewLine === currentLineNumber;
        const absoluteRowIndex = visibleRowStart + rowIndex;
        const isContextRow = reviewLine === undefined;
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
            {reviewLine !== undefined && (
              <span
                id={`review-line-${reviewLine}`}
                className="block h-0"
                aria-hidden="true"
              />
            )}
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "hidden grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] sm:grid",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {previousIsReviewLine ? (
                <button
                  type="button"
                  aria-label={`Comment on deleted line ${reviewLine}`}
                  title="Comment on this deleted pull-request line"
                  onClick={() => onSelectReviewLine(reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] bg-red-400/[.07] text-left transition hover:bg-red-400/[.12] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span className="flex items-center justify-end gap-1 border-r border-line/60 bg-red-400/10 px-2 text-red-700 transition select-none group-hover:text-violet dark:text-red-200">
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
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
                      (row.kind === "deleted" || row.kind === "modified") &&
                        "bg-red-400/10 text-red-700 dark:text-red-200",
                    )}
                  >
                    {previousLineNumber}
                  </span>
                  <div
                    className={cn(
                      "min-w-0 border-r border-line",
                      (row.kind === "deleted" || row.kind === "modified") &&
                        "bg-red-400/[.07]",
                    )}
                  >
                    <HighlightedDiffLine line={previousLine} />
                  </div>
                </>
              )}
              {currentLineNumber === undefined ? (
                <span className="col-span-2" />
              ) : !currentIsReviewLine ? (
                <div
                  className={cn(
                    "col-span-2 grid min-w-0 grid-cols-[42px_minmax(0,1fr)] text-fog",
                    (row.kind === "added" || row.kind === "modified") &&
                      "bg-addition/[.085]",
                  )}
                >
                  <span
                    className={cn(
                      "flex justify-end border-r border-line/60 px-2 select-none",
                      (row.kind === "added" || row.kind === "modified") &&
                        "bg-addition/12 text-addition",
                    )}
                  >
                    {currentLineNumber}
                  </span>
                  <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                    <HighlightedDiffTokens line={currentLine} />
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`Comment on current line ${reviewLine}`}
                  title="Comment on this pull-request line"
                  onClick={() => onSelectReviewLine(reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    (row.kind === "added" || row.kind === "modified") &&
                      "bg-addition/[.085] hover:bg-addition/[.13]",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet",
                      (row.kind === "added" || row.kind === "modified") &&
                        "bg-addition/12 text-addition",
                    )}
                  >
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
                          ? "text-cyan opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                    {currentLineNumber}
                  </span>
                  <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                    <HighlightedDiffTokens line={currentLine} />
                  </span>
                </button>
              )}
            </div>
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "sm:hidden",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {row.kind === "unchanged" ? (
                <div
                  className={cn(
                    "grid grid-cols-[42px_42px_minmax(0,1fr)]",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span className="text-fog border-r border-line/60 px-2 text-right select-none">
                    {previousLineNumber}
                  </span>
                  {currentIsReviewLine ? (
                    <button
                      type="button"
                      aria-label={`Comment on current line ${reviewLine}`}
                      title="Comment on this pull-request line"
                      onClick={() => onSelectReviewLine(reviewLine)}
                      className="group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
                    >
                      <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet">
                        <MessageSquareText
                          className={cn(
                            "size-3 transition-opacity",
                            selectedLine === reviewLine ||
                              keyboardLine === reviewLine
                              ? "text-cyan opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                          )}
                        />
                        {currentLineNumber}
                      </span>
                      <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                        <HighlightedDiffTokens line={currentLine} />
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="text-fog border-r border-line/60 px-2 text-right select-none">
                        {currentLineNumber}
                      </span>
                      <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                        <HighlightedDiffTokens line={currentLine} />
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {previousLine &&
                    (previousIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on deleted line ${reviewLine}`}
                        title="Comment on this deleted pull-request line"
                        onClick={() => onSelectReviewLine(reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/[.07] text-left transition hover:bg-red-400/[.12] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          selectedLine === reviewLine && "bg-violet/[.055]",
                          keyboardLine === reviewLine &&
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
                              selectedLine === reviewLine ||
                                keyboardLine === reviewLine
                                ? "text-cyan opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                            )}
                          />
                          −
                        </span>
                        <HighlightedDiffLine line={previousLine} />
                      </button>
                    ) : (
                      <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/[.07]">
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
                    (currentIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on current line ${reviewLine}`}
                        title="Comment on this pull-request line"
                        onClick={() => onSelectReviewLine(reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/[.085] text-left transition hover:bg-addition/[.13] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          selectedLine === reviewLine && "bg-violet/[.055]",
                          keyboardLine === reviewLine &&
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
                              selectedLine === reviewLine ||
                                keyboardLine === reviewLine
                                ? "text-cyan opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                            )}
                          />
                          +
                        </span>
                        <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                          <HighlightedDiffTokens line={currentLine} />
                        </span>
                      </button>
                    ) : (
                      <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/[.085]">
                        <span className="px-2 text-right text-addition select-none">
                          {currentLineNumber}
                        </span>
                        <span className="border-x border-line/60 px-2 text-center text-addition select-none">
                          +
                        </span>
                        <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                          <HighlightedDiffTokens line={currentLine} />
                        </span>
                      </div>
                    ))}
                </>
              )}
            </div>
            {reviewLine !== undefined && renderLineDetails?.(reviewLine)}
            {endsScope && <ReviewScopeMarker edge="end" line={scopeEndLine} />}
          </Fragment>
        );
      })}
      {visibleRowEnd < rows.length && (
        <DiffExternalContextButton
          direction={1}
          remaining={rows.length - visibleRowEnd}
          onReveal={() =>
            setContextAfterRows((current) =>
              Math.min(
                rows.length - focusRange.end,
                current + DIFF_CONTEXT_PAGE_LINES,
              ),
            )
          }
        />
      )}
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

/** Returns the display name for a connected code provider. */
export function providerLabel(
  provider: WorkspaceData["pullRequest"]["provider"],
) {
  if (provider === "azure_devops") return "Azure DevOps";
  if (provider === "gitlab") return "GitLab";
  return "GitHub";
}

/** Formats a provider comment timestamp for the review conversation. */
function conversationTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Renders the provider conversation interface. */
export function ProviderConversation({
  className,
  onReply,
  provider,
  replying,
  thread,
  publishedByReviewDuck,
}: {
  className?: string;
  onReply: (body: string) => Promise<unknown>;
  provider: WorkspaceData["pullRequest"]["provider"];
  replying: boolean;
  thread: ProviderConversationThread;
  publishedByReviewDuck: boolean;
}) {
  const [expanded, setExpanded] = useState(thread.status !== "resolved");
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyOpen) replyInputRef.current?.focus();
  }, [replyOpen]);

  useEffect(() => {
    setExpanded(thread.status !== "resolved");
    setReplyOpen(false);
  }, [thread.status]);

  /** Publishes the draft while preserving it if the provider rejects the reply. */
  async function submitReply() {
    const body = replyBody.trim();
    if (!body || replying) return;
    try {
      await onReply(body);
      setReplyBody("");
      setReplyOpen(false);
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    }
  }

  return (
    <article
      className={cn(
        "border-cyan/20 bg-panel mx-4 my-2 ml-[71px] overflow-hidden rounded-xl border font-sans shadow-lg",
        className,
      )}
    >
      <header
        className={cn(
          "bg-cyan/[.035] flex items-center justify-between gap-2 px-3 py-2.5",
          expanded && "border-b border-line",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${providerLabel(provider)} conversation`}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              "text-cyan size-3.5 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <MessageSquareText className="text-cyan size-3.5 shrink-0" />
          <span className="text-cloud truncate text-[10px] font-medium">
            {providerLabel(provider)} conversation
          </span>
          {publishedByReviewDuck && (
            <Badge className="border-cyan/20 bg-cyan/8 text-cyan">
              Posted here
            </Badge>
          )}
          {thread.status === "resolved" && (
            <Badge className="border-lime/20 bg-lime/8 text-lime">
              Resolved
            </Badge>
          )}
        </button>
        {thread.webUrl && (
          <a
            href={thread.webUrl}
            target="_blank"
            rel="noreferrer"
            className="text-mist hover:text-cloud flex shrink-0 items-center gap-1 text-[9px] transition"
          >
            Open on {providerLabel(provider)}
            <ExternalLink className="size-3" />
          </a>
        )}
      </header>
      {expanded && (
        <>
          <div className="divide-y divide-line">
            {thread.comments.map((comment, index) => (
              <div
                key={comment.externalId}
                className={cn(
                  "px-4 py-4 sm:px-5",
                  index > 0 && "bg-surface-subtle/45 sm:pl-8",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="bg-cyan/10 text-cyan grid size-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold uppercase">
                    {comment.author.slice(0, 1)}
                  </span>
                  <span className="text-cloud truncate text-[11px] font-medium">
                    {comment.author}
                  </span>
                  <time
                    dateTime={comment.createdAt}
                    className="text-fog shrink-0 text-[10px]"
                  >
                    {conversationTimestamp(comment.createdAt)}
                  </time>
                  {index > 0 && (
                    <span className="text-cyan ml-auto text-[8px] font-semibold tracking-wider uppercase">
                      Reply
                    </span>
                  )}
                </div>
                <ProviderCommentBody body={comment.body} />
              </div>
            ))}
          </div>
          <footer className="border-t border-line bg-surface-subtle/25 px-4 py-3 sm:px-5">
            {replyOpen ? (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-cloud text-[11px] font-medium">
                    Reply on {providerLabel(provider)}
                  </p>
                  <span className="text-fog flex items-center gap-1 text-[9px]">
                    <ShortcutHint shortcut={reviewShortcuts.postComment} />
                    post
                  </span>
                </div>
                <textarea
                  ref={replyInputRef}
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setReplyOpen(false);
                    } else if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      void submitReply();
                    }
                  }}
                  placeholder="Continue this conversation…"
                  rows={3}
                  className="bg-surface text-cloud focus:border-cyan/45 mt-2 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={replying}
                    onClick={() => setReplyOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!replyBody.trim() || replying}
                    onClick={() => void submitReply()}
                  >
                    {replying ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    {replying ? "Posting…" : "Reply"}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setReplyOpen(true)}
                className="text-mist hover:text-cyan flex items-center gap-2 text-[10px] font-medium transition"
              >
                <MessageSquareText className="size-3.5" />
                Reply on {providerLabel(provider)}
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

/** Groups provider conversations while surfacing unresolved work by default. */
export function ProviderConversationHistory({
  children,
  threads,
}: {
  children: ReactNode;
  threads: ProviderConversationThread[];
}) {
  const hasUnresolved = threads.some((thread) => thread.status !== "resolved");
  const [expanded, setExpanded] = useState(hasUnresolved);

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group mt-3 rounded-xl border border-line bg-surface/30 font-sans"
    >
      <summary className="text-mist hover:bg-surface-hover flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-[10px] font-medium transition [&::-webkit-details-marker]:hidden">
        <MessageSquareText className="text-cyan size-3.5" />
        <span className="flex-1">Conversation history</span>
        <Badge>{threads.length}</Badge>
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line p-3">{children}</div>
    </details>
  );
}
/** Checks whether syntax highlighting supports a language identifier. */
export function supportedLanguage(language: string) {
  if (supportedLanguages.includes(language as SupportedLanguage))
    return language as SupportedLanguage;
  throw new Error(`Unsupported review language: ${language}`);
}

/** Renders the explanation loader interface. */
export function ExplanationLoader({ unitKind }: { unitKind: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-violet/20 bg-violet/[.045] relative mt-4 overflow-hidden rounded-xl border p-4"
    >
      <div
        aria-hidden="true"
        className="bg-violet/10 absolute inset-x-0 top-0 h-px animate-pulse"
      />
      <div className="flex items-start gap-3">
        <span className="bg-violet/10 grid size-8 shrink-0 place-items-center rounded-full">
          <LoaderCircle className="text-violet size-4 animate-spin" />
        </span>
        <div className="min-w-0">
          <p className="text-cloud text-xs font-medium">
            Analyzing this {unitKind}
          </p>
          <p className="text-mist mt-1 text-[10px] leading-4">
            Reading its logic and dependencies to prepare a focused explanation.
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="mt-4 space-y-2">
        <div className="bg-violet/10 h-1.5 w-full animate-pulse rounded-full" />
        <div className="bg-violet/10 h-1.5 w-[86%] animate-pulse rounded-full [animation-delay:120ms]" />
        <div className="bg-violet/10 h-1.5 w-[62%] animate-pulse rounded-full [animation-delay:240ms]" />
      </div>
    </div>
  );
}

/** Renders file imports as relevance-aware context for the active unit. */
export function UnitImportContext({
  fileSource,
  unitSource,
  language,
  unitId,
  visibleStartLine,
  visibleEndLine,
  resolvingImport,
  onFollow,
}: {
  fileSource: string;
  unitSource: string;
  language: string;
  unitId: string;
  visibleStartLine: number;
  visibleEndLine: number;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  const statements = useMemo(
    () =>
      parseImportStatements(fileSource, language).filter(
        (statement) =>
          statement.endLine < visibleStartLine ||
          statement.startLine > visibleEndLine,
      ),
    [fileSource, language, visibleEndLine, visibleStartLine],
  );
  const usedReferences = useMemo(
    () =>
      new Set(
        statements
          .flatMap(({ references }) => references)
          .filter((reference) => importReferenceIsUsed(reference, unitSource))
          .map((reference) => `${reference.from}:${reference.to}`),
      ),
    [statements, unitSource],
  );
  if (statements.length === 0) return null;

  return (
    <section aria-label="Imports for this unit" className="mb-3">
      {statements.map((statement) =>
        highlightSource(statement.source, language).map((line, lineIndex) => {
          const lineNumber = statement.startLine + lineIndex;
          return (
            <div
              key={`${statement.from}-${lineIndex}`}
              className="group grid grid-cols-[55px_1fr] border-l-2 border-transparent bg-surface-subtle/15 px-4 hover:bg-surface-subtle"
            >
              <span className="text-fog flex items-center justify-end pr-3 text-right opacity-55 select-none group-hover:opacity-80">
                {lineNumber}
              </span>
              <pre className="syntax-code overflow-visible text-cloud/80">
                {line.tokens.length
                  ? line.tokens.map((token, tokenIndex) => {
                      const reference = statement.references.find(
                        (candidate) =>
                          candidate.from - statement.from >= token.from &&
                          candidate.to - statement.from <= token.to,
                      );
                      if (!reference) {
                        return (
                          <span
                            key={`${tokenIndex}-${token.text.length}`}
                            className={cn(
                              token.className,
                              "opacity-55 transition-opacity group-hover:opacity-80",
                            )}
                          >
                            {token.text}
                          </span>
                        );
                      }
                      const referenceKey = `${reference.from}:${reference.to}`;
                      const resolutionKey = `${unitId}:${referenceKey}`;
                      const used = usedReferences.has(referenceKey);
                      return (
                        <button
                          type="button"
                          key={`${tokenIndex}-${token.text.length}`}
                          aria-label={`Open ${reference.local} from ${reference.specifier}`}
                          title={
                            used
                              ? `Used by this unit · open ${reference.specifier}`
                              : `Not used by this unit · open ${reference.specifier}`
                          }
                          disabled={resolvingImport === resolutionKey}
                          onClick={() => onFollow(reference)}
                          className={cn(
                            "decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                            token.className,
                            used
                              ? "text-cyan opacity-100"
                              : "opacity-55 hover:opacity-80",
                            resolvingImport === resolutionKey &&
                              "animate-pulse cursor-wait",
                          )}
                        >
                          {token.text}
                        </button>
                      );
                    })
                  : " "}
              </pre>
            </div>
          );
        }),
      )}
    </section>
  );
}

/** Counts unique display nodes within one hierarchy branch. */
function hierarchyNodeCount(node: ReviewHierarchyNode<ReviewUnit>): number {
  return (
    1 +
    node.children.reduce((total, child) => total + hierarchyNodeCount(child), 0)
  );
}

/** Checks whether a hierarchy branch contains a review unit. */
function hierarchyContains(
  node: ReviewHierarchyNode<ReviewUnit>,
  unitId: string,
): boolean {
  return (
    node.unit.id === unitId ||
    node.children.some((child) => hierarchyContains(child, unitId))
  );
}

/** Renders dependency rows nested beneath a hierarchy concept root. */
function HierarchyDependencyRows({
  nodes,
  level,
  activeUnitId,
  onSelect,
}: {
  nodes: ReviewHierarchyNode<ReviewUnit>[];
  level: number;
  activeUnitId: string;
  onSelect: (index: number) => void;
}) {
  return nodes.map((node) => {
    const active = node.unit.id === activeUnitId;
    const fileName = node.unit.path.split("/").at(-1) ?? node.unit.path;
    return (
      <Fragment key={node.unit.id}>
        <button
          type="button"
          aria-current={active ? "step" : undefined}
          onClick={() => onSelect(node.index)}
          className={cn(
            "group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2 pr-2 text-left transition",
            active ? "bg-cyan/[.075]" : "hover:bg-surface-subtle",
          )}
          style={{ paddingLeft: `${12 + Math.min(level, 8) * 16}px` }}
        >
          {level > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 border-l border-line"
              style={{ left: `${18 + Math.min(level - 1, 7) * 16}px` }}
            />
          )}
          <span
            className={cn(
              "z-10 size-2 shrink-0 rounded-full border",
              node.unit.status === "signed_off"
                ? "border-lime bg-lime"
                : node.unit.status === "waiting"
                  ? "border-cyan bg-cyan/25"
                  : node.unit.status === "changed"
                    ? "border-amber-400 bg-amber-400/30"
                    : "border-line-strong bg-panel",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="text-cloud block truncate font-mono text-[10px]">
              {node.unit.name}
            </span>
            <span className="text-fog mt-0.5 block truncate text-[9px] capitalize">
              {fileName} · {node.unit.kind.replace("_", " ")} · depth{" "}
              {node.unit.depth}
            </span>
          </span>
          <ChevronRight className="text-fog size-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
        </button>
        {node.children.length > 0 && (
          <HierarchyDependencyRows
            nodes={node.children}
            level={level + 1}
            activeUnitId={activeUnitId}
            onSelect={onSelect}
          />
        )}
      </Fragment>
    );
  });
}

/** Renders the compact dependency hierarchy dialog. */
export function ReviewHierarchyDialog({
  roots,
  activeUnitId,
  onSelect,
  onClose,
}: {
  roots: ReviewHierarchyNode<ReviewUnit>[];
  activeUnitId: string;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const activeRoot = roots.find((root) =>
    hierarchyContains(root, activeUnitId),
  );
  const [expandedRoots, setExpandedRoots] = useState(
    () => new Set(activeRoot ? [activeRoot.unit.id] : []),
  );
  useEffect(() => {
    /** Closes the hierarchy dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-hierarchy-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <GitBranch className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="review-hierarchy-title"
                className="text-cloud text-sm font-medium"
              >
                Review hierarchy
              </h2>
              <p className="text-fog mt-1 text-[10px] leading-4">
                {roots.length} coherent concepts. Prerequisites are nested below
                each concept root; review proceeds from the deepest leaf upward.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close review hierarchy"
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 sm:p-4">
          {roots.map((root, conceptIndex) => {
            const expanded = expandedRoots.has(root.unit.id);
            const active = hierarchyContains(root, activeUnitId);
            const fileName = root.unit.path.split("/").at(-1) ?? root.unit.path;
            return (
              <section
                key={root.unit.id}
                className={cn(
                  "overflow-hidden rounded-xl border",
                  active ? "border-cyan/30 bg-cyan/[.025]" : "border-line",
                )}
              >
                <div className="flex items-center gap-1 p-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(root.index);
                      onClose();
                    }}
                    className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition"
                  >
                    <span className="text-cyan grid size-6 shrink-0 place-items-center rounded-md bg-cyan/10 font-mono text-[9px]">
                      {conceptIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-cloud block truncate font-mono text-[11px]">
                        {root.unit.name}
                      </span>
                      <span className="text-fog mt-0.5 block truncate text-[9px]">
                        {fileName} · {hierarchyNodeCount(root)} units
                      </span>
                    </span>
                    {active && (
                      <Badge className="border-cyan/20 bg-cyan/[.07] text-cyan">
                        Current
                      </Badge>
                    )}
                  </button>
                  {root.children.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${root.unit.name} hierarchy`}
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedRoots((current) => {
                          const next = new Set(current);
                          if (next.has(root.unit.id)) next.delete(root.unit.id);
                          else next.add(root.unit.id);
                          return next;
                        })
                      }
                      className="text-mist hover:text-cloud grid size-9 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          !expanded && "-rotate-90",
                        )}
                      />
                    </button>
                  )}
                </div>
                {expanded && root.children.length > 0 && (
                  <div className="border-t border-line/70 px-1.5 py-1.5">
                    <HierarchyDependencyRows
                      nodes={root.children}
                      level={1}
                      activeUnitId={activeUnitId}
                      onSelect={(index) => {
                        onSelect(index);
                        onClose();
                      }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <span>Shared dependencies appear under their first concept.</span>
          <span className="shrink-0">Esc closes</span>
        </footer>
      </div>
    </div>
  );
}
