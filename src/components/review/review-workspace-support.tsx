"use client";

import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Clock3,
  Columns2,
  ExternalLink,
  FileCode2,
  FolderInput,
  GitBranch,
  GripVertical,
  Info,
  LoaderCircle,
  MessageCircleQuestionMark,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
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
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  type ImportReference,
  type ImportStatement,
  importReferenceIsUsed,
  type PairedImportStatement,
  pairImportStatements,
} from "~/lib/import-navigation";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import type {
  IndexedReviewUnit,
  ReviewHierarchyNode,
} from "~/lib/review-navigation";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import {
  compactSideBySideDiff,
  focusedRowRegions,
  focusedRowSpan,
  sideBySideDiff,
  sourceByteOffsetLine,
  sourceEndLine,
  sourceStartLine,
} from "~/lib/side-by-side-diff";
import { isPeekableToken, symbolPeekAttributes } from "~/lib/symbol-peek";
import {
  type HighlightedLine,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { useImportStatements } from "~/lib/tree-sitter-import-navigation";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./provider-comment-body";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

type ProviderConversationThread =
  RouterOutputs["review"]["providerConversations"]["threads"][number];

export const INITIAL_PATH_ITEMS = 10;
export const PATH_PAGE_SIZE = 20;
export const CONTEXT_PAGE_LINES = 20;
/**
 * How long a fetched provider conversation snapshot is treated as current.
 *
 * Reading provider conversations costs a live GitHub, GitLab, or Azure DevOps
 * round trip, so this is the one place that decides how old that view of the
 * conversations may become before the workspace refreshes it in the background.
 */
export const PROVIDER_CONVERSATION_REFRESH_MS = 45_000;
const DIFF_CONTEXT_PAGE_LINES = 20;

export { reviewShortcuts } from "~/lib/review-shortcuts";

/**
 * Reports whether a member no longer needs the reviewer's attention.
 *
 * A unit whose code changed after it was signed off comes back as "changed",
 * so only a standing sign-off counts as read.
 */
function reviewedMember(unit: ReviewUnit) {
  return unit.status === "signed_off";
}

/**
 * Orders a concept's members by what the reviewer still owes.
 *
 * Members are read in dependency order, which the signed-off ones no longer
 * take part in: they hold that order among themselves but sit below the work
 * that remains, so a part-reviewed concept opens on what is left.
 */
export function conceptMembersInReadingOrder<Member extends { status: string }>(
  members: readonly Member[],
) {
  return [...members].sort(
    (left, right) =>
      Number(left.status === "signed_off") -
      Number(right.status === "signed_off"),
  );
}

/** Groups one concept's atomic members into file-sized reading cards. */
export function conceptFileCardsInReadingOrder<Member extends { path: string }>(
  members: readonly Member[],
) {
  const cards: Array<{ path: string; members: Member[] }> = [];
  const cardByPath = new Map<string, (typeof cards)[number]>();
  for (const member of members) {
    const existing = cardByPath.get(member.path);
    if (existing) {
      existing.members.push(member);
      continue;
    }
    const card = { path: member.path, members: [member] };
    cards.push(card);
    cardByPath.set(member.path, card);
  }
  return cards;
}

/** Chooses the member a file card should open for the next review action. */
export function actionableReviewCardMember<Member extends { status: string }>(
  members: readonly Member[],
) {
  return (
    members.find(
      ({ status }) => status !== "signed_off" && status !== "waiting",
    ) ?? members[0]
  );
}

/** Merges the disjoint source ranges reviewed by every unit in one file card. */
export function reviewCardRanges(
  members: readonly ReviewUnit[],
  side: "current" | "previous" = "current",
  previousFileSource?: string | null,
) {
  const ranges = members
    .flatMap((member) => {
      const related = relatedReviewRanges(member, side);
      if (related) return related;
      if (side === "previous") {
        if (!member.previousSource && member.changeType === "added") return [];
        const startLine =
          member.changeType === "deleted"
            ? member.startLine
            : member.previousSource && previousFileSource
              ? sourceByteOffsetLine(
                  previousFileSource,
                  member.previousStartByte,
                  sourceStartLine(
                    previousFileSource,
                    member.previousSource,
                    member.startLine,
                  ),
                )
              : member.startLine;
        return [
          {
            startLine,
            endLine: member.previousSource
              ? sourceEndLine(member.previousSource, startLine)
              : startLine,
          },
        ];
      }
      return member.changeType === "deleted"
        ? []
        : [{ startLine: member.startLine, endLine: member.endLine }];
    })
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Finds the atomic unit that owns a line shown inside a file card. */
export function reviewCardMemberForLine(
  members: readonly ReviewUnit[],
  line: number,
  side: "current" | "previous" = "current",
) {
  return members.find((member) => {
    const ranges = reviewCardRanges([member], side);
    return ranges.some(
      ({ startLine, endLine }) => line >= startLine && line <= endLine,
    );
  });
}

/** Renders one file-card identity while preserving the atomic ledger beneath it. */
export function ReviewFileCardHeader({
  members,
  index,
  count,
  selected,
  actions,
  onSelect,
  itemLabel = "Card",
}: {
  members: readonly ReviewUnit[];
  index: number;
  count: number;
  selected: boolean;
  actions?: ReactNode;
  onSelect?: () => void;
  itemLabel?: "Card" | "File";
}) {
  const first = members[0];
  if (!first) return null;
  const outstanding = members.filter(
    ({ status }) => status !== "signed_off" && status !== "waiting",
  ).length;
  const fullyReviewed = members.every(({ status }) => status === "signed_off");
  const changedLines = members.reduce(
    (total, member) => total + member.changedLineCount,
    0,
  );
  const itemName = itemLabel.toLowerCase();
  const content = (
    <>
      <span className="min-w-0">
        <span className="text-cloud block truncate font-mono text-[10px]">
          {first.path}
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px]">
          Reviewing {members.length} individual{" "}
          {members.length === 1 ? "unit" : "units"} in this {itemName} ·{" "}
          {changedLines} changed lines
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[9px]">
        {actions}
        <span className="text-fog">
          {itemLabel} {index + 1}/{count}
        </span>
        {fullyReviewed && (
          <span className="border-addition/30 bg-addition/10 text-addition flex items-center gap-1 rounded-full border px-2 py-0.5">
            <Check className="size-2.5" aria-hidden />
            Reviewed
          </span>
        )}
        {selected && (
          <span className="border-cyan/25 bg-cyan/10 text-cyan rounded-full border px-2 py-0.5">
            {outstanding > 0
              ? `${outstanding} remaining`
              : fullyReviewed
                ? "Selected"
                : "Waiting"}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-stretch border-b",
        selected
          ? "bg-cyan/[.05] border-cyan/20"
          : fullyReviewed
            ? "border-addition/25"
            : "border-line",
      )}
    >
      {selected ? (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left">
          {content}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Select review ${itemName} for ${first.path}`}
          onClick={onSelect}
          className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left transition"
        >
          {content}
        </button>
      )}
    </div>
  );
}

/** Backwards-compatible name for concept cards; both modes use one file header. */
export const ReviewConceptFileCardHeader = ReviewFileCardHeader;

/** Shows revision provenance and ledger state at one unit's line boundary. */
export function ReviewFileUnitMarker({ member }: { member: ReviewUnit }) {
  return (
    <div className="border-cyan/15 bg-cyan/[.025] mx-4 my-2 ml-[82px] flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 font-sans">
      <span className="text-fog text-[9px] font-semibold tracking-[.12em] uppercase">
        Review unit
      </span>
      <span className="text-cloud min-w-0 flex-1 truncate text-[10px] font-medium">
        {member.name}
      </span>
      {member.revisionState === "new" && (
        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">New</Badge>
      )}
      {member.revisionState === "updated" && (
        <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
          Updated
        </Badge>
      )}
      {member.status === "signed_off" ? (
        <Badge className="border-lime/25 bg-lime/10 text-lime">
          <Check className="size-3" />
          {member.signOffOrigin === "preserved"
            ? "Reviewed earlier"
            : "Reviewed"}
        </Badge>
      ) : member.status === "waiting" ? (
        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
          <Clock3 className="size-3" />
          Waiting
        </Badge>
      ) : (
        <Badge>Not reviewed</Badge>
      )}
    </div>
  );
}

/** Preserves atomic line numbers when a full file is not available yet. */
function ReviewConceptFileCardFallbackMember({
  member,
  onCommentLine,
}: {
  member: ReviewUnit;
  onCommentLine?: (unitId: string, line: number) => void;
}) {
  const lines = useHighlightedSource(member.source, member.language);
  return (
    <div className="border-b border-line/60 last:border-b-0">
      {lines.map((line, lineIndex) => {
        const lineNumber = member.startLine + lineIndex;
        const owner = reviewCardMemberForLine([member], lineNumber);
        return (
          <div
            key={`${member.id}-${lineNumber}`}
            className={cn(
              "group grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle",
              !owner && "bg-surface-subtle/15 opacity-45 hover:opacity-75",
              owner && "border-l-2 border-l-cyan/30 bg-cyan/[.012]",
            )}
          >
            {owner && onCommentLine ? (
              <button
                type="button"
                aria-label={`Comment on line ${lineNumber} of ${member.name}`}
                onClick={() => onCommentLine(member.id, lineNumber)}
                className="hover:text-violet text-fog flex items-start justify-end gap-1.5 pr-3 text-right transition select-none"
              >
                <MessageSquareText className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                <span>{lineNumber}</span>
              </button>
            ) : (
              <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                {lineNumber}
              </span>
            )}
            <pre className="syntax-code overflow-visible text-cloud">
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
            </pre>
          </div>
        );
      })}
    </div>
  );
}

/** Shows every same-file member as one continuous card with dimmed gaps. */
export function ReviewConceptFileCardPreview({
  members,
  index,
  count,
  fileSource,
  onSelect,
  onCommentLine,
  itemLabel = "Card",
}: {
  members: readonly ReviewUnit[];
  index: number;
  count: number;
  fileSource: string;
  onSelect: () => void;
  onCommentLine?: (unitId: string, line: number) => void;
  itemLabel?: "Card" | "File";
}) {
  const ranges = reviewCardRanges(members);
  const startLine = ranges.at(0)?.startLine ?? 1;
  const endLine = ranges.at(-1)?.endLine ?? startLine;
  const source = fileSource
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
  const lines = useHighlightedSource(source, members[0]?.language ?? "text");
  const memberRanges = members.map((member) => ({
    member,
    ranges: reviewCardRanges([member]),
  }));
  return (
    <article className="mx-4 overflow-hidden rounded-xl border border-line bg-surface/30">
      <ReviewConceptFileCardHeader
        members={members}
        index={index}
        count={count}
        selected={false}
        onSelect={onSelect}
        itemLabel={itemLabel}
      />
      <div className="overflow-x-auto py-2">
        {fileSource
          ? lines.map((line, lineIndex) => {
              const lineNumber = startLine + lineIndex;
              const owner = memberRanges.find(({ ranges: ownedRanges }) =>
                ownedRanges.some(
                  ({ startLine: from, endLine: to }) =>
                    lineNumber >= from && lineNumber <= to,
                ),
              )?.member;
              return (
                <div
                  key={`${members[0]?.id}-${lineNumber}`}
                  className={cn(
                    "group grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle",
                    !owner &&
                      "bg-surface-subtle/15 opacity-45 hover:opacity-75",
                    owner && "border-l-2 border-l-cyan/30 bg-cyan/[.012]",
                  )}
                >
                  {owner && onCommentLine ? (
                    <button
                      type="button"
                      aria-label={`Comment on line ${lineNumber} of ${owner.name}`}
                      onClick={() => onCommentLine(owner.id, lineNumber)}
                      className="hover:text-violet text-fog flex items-start justify-end gap-1.5 pr-3 text-right transition select-none"
                    >
                      <MessageSquareText className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      <span>{lineNumber}</span>
                    </button>
                  ) : (
                    <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                      {lineNumber}
                    </span>
                  )}
                  <pre className="syntax-code overflow-visible text-cloud">
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
                  </pre>
                </div>
              );
            })
          : members.map((member) => (
              <ReviewConceptFileCardFallbackMember
                key={member.id}
                member={member}
                onCommentLine={onCommentLine}
              />
            ))}
      </div>
    </article>
  );
}

/** Renders the shared identity and selection treatment for one concept member. */
export function ReviewConceptMemberHeader({
  unit,
  index,
  count,
  selected,
  actions,
  onSelect,
  expanded,
  onToggleExpanded,
}: {
  unit: ReviewUnit;
  index: number;
  count: number;
  selected: boolean;
  actions?: ReactNode;
  onSelect?: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}) {
  const content = (
    <>
      <span className="min-w-0">
        <span className="text-cloud block truncate font-mono text-[10px]">
          {unit.path}
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px]">
          {unit.name} · {unit.changedLineCount} changed lines
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[9px]">
        {actions}
        <span className="text-fog">
          Unit {index + 1}/{count}
        </span>
        {reviewedMember(unit) && (
          // Green, not the accent: the accent is the colour of the sign-off
          // button, and a marker saying "already done" must not wear the same
          // hue as the control asking for the next sign-off.
          <span className="border-addition/30 bg-addition/10 text-addition flex items-center gap-1 rounded-full border px-2 py-0.5">
            <Check className="size-2.5" aria-hidden />
            Reviewed
          </span>
        )}
        {selected && (
          <span className="border-cyan/25 bg-cyan/10 text-cyan rounded-full border px-2 py-0.5">
            Selected
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-stretch border-b",
        selected
          ? "bg-cyan/[.05] border-cyan/20"
          : reviewedMember(unit)
            ? "border-addition/25"
            : "border-line",
      )}
    >
      {onToggleExpanded && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${unit.name}`}
          onClick={onToggleExpanded}
          className="hover:bg-surface-subtle text-fog flex shrink-0 items-center px-2 transition"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
      )}
      {selected ? (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left">
          {content}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Select ${unit.name}`}
          onClick={onSelect}
          className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left transition"
        >
          {content}
        </button>
      )}
    </div>
  );
}

/** Keeps optional file context scoped to the review unit it explains. */
export function ReviewUnitViewOptions({
  importsVisible,
  fullFileVisible,
  importsDisabled = false,
  fullFileDisabled = false,
  onToggleImports,
  onToggleFullFile,
}: {
  importsVisible: boolean;
  fullFileVisible: boolean;
  importsDisabled?: boolean;
  fullFileDisabled?: boolean;
  onToggleImports: () => void;
  onToggleFullFile: () => void;
}) {
  return (
    <span className="flex items-center gap-1 font-sans">
      <button
        type="button"
        aria-pressed={importsVisible}
        aria-label="Show imports for this unit"
        title="Show imports declared elsewhere in this file"
        disabled={importsDisabled}
        onClick={onToggleImports}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-35",
          importsVisible
            ? "border-cyan/35 bg-cyan/10 text-cyan"
            : "border-line text-fog hover:border-cyan/25 hover:text-cyan",
        )}
      >
        <ArrowUpFromLine className="size-3" aria-hidden="true" />
        <span className="hidden xl:inline">Imports</span>
      </button>
      <button
        type="button"
        aria-pressed={fullFileVisible}
        aria-label="Show the full file for this unit"
        title="Show the complete file instead of the focused unit"
        disabled={fullFileDisabled}
        onClick={onToggleFullFile}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-35",
          fullFileVisible
            ? "border-cyan/35 bg-cyan/10 text-cyan"
            : "border-line text-fog hover:border-cyan/25 hover:text-cyan",
        )}
      >
        <FileCode2 className="size-3" aria-hidden="true" />
        <span className="hidden xl:inline">Full file</span>
      </button>
    </span>
  );
}

/** Extracts the stored disjoint ranges for one side of a review concept. */
export function relatedReviewRanges(
  unit: Pick<ReviewUnit, "relatedRanges"> | undefined,
  side: "current" | "previous",
) {
  if (!unit?.relatedRanges?.length) return undefined;
  return unit.relatedRanges.flatMap((range) => {
    const startLine =
      side === "current" ? range.startLine : range.previousStartLine;
    const endLine = side === "current" ? range.endLine : range.previousEndLine;
    return startLine !== undefined && endLine !== undefined
      ? [{ startLine, endLine }]
      : [];
  });
}

/** Tests a line against disjoint ranges or a unit's contiguous bounds. */
export function lineWithinReviewRanges(
  line: number,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  return ranges
    ? ranges.some(
        ({ startLine, endLine }) => line >= startLine && line <= endLine,
      )
    : line >= fallbackStart && line <= fallbackEnd;
}

/**
 * Steps a line picker to the next line a provider comment can anchor to.
 *
 * A disjoint unit prints the lines between its ranges but owns none of them,
 * so moving by one would park the picker on a line that answers a selection
 * with nothing. The current line is held when the scope has nothing further
 * in that direction.
 */
export function nextAnchorableLine(
  current: number,
  direction: -1 | 1,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  scopeStart: number,
  scopeEnd: number,
) {
  for (
    let line = current + direction;
    line >= scopeStart && line <= scopeEnd;
    line += direction
  ) {
    if (lineWithinReviewRanges(line, ranges, scopeStart, scopeEnd)) return line;
  }
  return current;
}

/**
 * Checks whether a member's own line can carry a provider comment.
 *
 * A member card renders the unit's stored source from its first line, so the
 * numbers it prints run past the gaps between disjoint ranges. The provider
 * only anchors a comment inside a range, so the lines in those gaps offer no
 * composer rather than one that fails on publish.
 */
function memberCommentableLine(unit: ReviewUnit, line: number) {
  if (unit.kind === "binary") return false;
  return lineWithinReviewRanges(
    line,
    relatedReviewRanges(
      unit,
      unit.changeType === "deleted" ? "previous" : "current",
    ),
    unit.startLine,
    unit.endLine,
  );
}

/**
 * Renders one member's highlighted source.
 *
 * The highlighter is a hook and cannot be called conditionally, so the body of
 * an open card is its own component: a collapsed member then never mounts it,
 * and never spends a grammar parse — or a slot in the bounded highlight cache
 * — on code nobody is looking at.
 */
function ReviewConceptMemberSource({
  unit,
  onCommentLine,
}: {
  unit: ReviewUnit;
  onCommentLine?: (line: number) => void;
}) {
  const source =
    unit.changeType === "deleted"
      ? (unit.previousSource ?? unit.source)
      : unit.source;
  const lines = useHighlightedSource(source, unit.language);
  return (
    // A member is read in the page's own scroll rather than in a window of its
    // own: a card that scrolls inside a scrolling page hides how much of a
    // concept is left and takes two gestures to read one unit. Only long lines
    // scroll, and only sideways.
    <div className="overflow-x-auto py-2">
      {lines.map((line, lineIndex) => {
        const lineNumber = unit.startLine + lineIndex;
        const commentable =
          Boolean(onCommentLine) && memberCommentableLine(unit, lineNumber);
        return (
          <div
            key={`${unit.id}-${lineIndex}`}
            className="group grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle"
          >
            {commentable ? (
              <button
                type="button"
                aria-label={`Comment on line ${lineNumber} of ${unit.name}`}
                onClick={() => onCommentLine?.(lineNumber)}
                className="hover:text-violet text-fog flex items-start justify-end gap-1.5 pr-3 text-right transition select-none"
              >
                <MessageSquareText className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                <span>{lineNumber}</span>
              </button>
            ) : (
              <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                {lineNumber}
              </span>
            )}
            <pre className="syntax-code overflow-visible text-cloud">
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
            </pre>
          </div>
        );
      })}
    </div>
  );
}

export interface SplitAction {
  disabled?: boolean;
  description?: string;
  label: string;
  onSelect: () => void;
  shortcut: KeyboardShortcut;
}

/** Makes the two source representations explicit instead of hiding them in one icon. */
export function ReviewCodeViewSwitch({
  diffVisible,
  onChange,
}: {
  diffVisible: boolean;
  onChange: (diffVisible: boolean) => void;
}) {
  return (
    <fieldset className="flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface/25 p-0.5">
      <legend className="sr-only">Code view</legend>
      <button
        type="button"
        aria-pressed={!diffVisible}
        aria-label="Focus view"
        title="Focus view: read the pull-request source with supporting imports and surrounding lines"
        onClick={() => onChange(false)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          !diffVisible
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <FileCode2 className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Focus</span>
      </button>
      <button
        type="button"
        aria-pressed={diffVisible}
        aria-label="Diff view"
        title="Diff view: compare the base and pull-request versions line by line"
        onClick={() => onChange(true)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          diffVisible
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <Columns2 className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Diff</span>
      </button>
    </fieldset>
  );
}

export const REVISION_NOTICE_DISMISS_MS = 10_000;

/**
 * Explains a newly loaded pull-request revision and then gets out of the way.
 *
 * The banner has to stay readable, but it is not a decision: after ten seconds
 * the reviewer has either absorbed it or is already in the code. The button
 * shows the remaining seconds so the auto-dismiss is not a surprise.
 */
export function ReviewRevisionLoadedNotice({
  children,
  onAcknowledge,
}: {
  children: ReactNode;
  onAcknowledge: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.ceil(REVISION_NOTICE_DISMISS_MS / 1000),
  );
  const acknowledge = useRef(onAcknowledge);
  acknowledge.current = onAcknowledge;

  useEffect(() => {
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      const remainingMs = REVISION_NOTICE_DISMISS_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        window.clearInterval(tick);
        acknowledge.current();
        return;
      }
      setSecondsLeft(Math.ceil(remainingMs / 1000));
    }, 250);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div
      role="status"
      className="border-cyan/20 bg-cyan/[.045] flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:items-center sm:px-6"
    >
      <RefreshCw className="text-cyan mt-0.5 size-4 shrink-0 sm:mt-0" />
      <div className="min-w-0 flex-1">
        <p className="text-cloud text-xs font-medium">
          New pull-request revision loaded
        </p>
        <p className="text-mist mt-0.5 text-[10px] leading-4">{children}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0 tabular-nums"
        aria-label={`Got it, dismissing in ${secondsLeft} ${secondsLeft === 1 ? "second" : "seconds"}`}
        onClick={() => acknowledge.current()}
      >
        Got it · {secondsLeft}s
      </Button>
    </div>
  );
}

/**
 * Renders one action beside the wider one it belongs to.
 *
 * A review reads one unit at a time and lands on the concept only at the end,
 * so the wide action is wrong to press for most of a concept and right at the
 * end of it. Putting both under one control lets the button advertise the one
 * that fits where the reviewer is standing, while the other stays one click
 * away rather than behind a key nobody has met yet.
 */
export function SplitActionButton({
  primary,
  options,
  className,
  icon,
  label,
  mobileLabel,
  menuLabel,
  pending = false,
  variant = "primary",
}: {
  primary: SplitAction;
  options: SplitAction[];
  className?: string;
  icon: ReactNode;
  label: string;
  mobileLabel: string;
  menuLabel: string;
  pending?: boolean;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  /** Lists the items a keyboard can actually land on. */
  const reachableItems = useCallback(
    () => [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ],
    [],
  );

  // The menu is drawn above the buttons that open it, so it also precedes them
  // in the DOM. Without moving focus into it, opening the menu would leave the
  // reviewer tabbing backwards to reach what they just asked for.
  useEffect(() => {
    if (!open) return;
    reachableItems()[0]?.focus();
  }, [open, reachableItems]);

  /** Closes the menu and hands focus back to the control that opened it. */
  const close = useCallback(() => {
    setOpen(false);
    toggle.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    /** Closes the menu for a pointer that lands outside it. */
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    /** Closes the menu without letting Escape reach the workspace. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [close, open]);

  /** Walks the arrow keys around the items, as a menu is expected to. */
  function moveThroughItems(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = reachableItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current < 0 ? 0 : (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div ref={container} className={cn("relative", className)}>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={moveThroughItems}
          className="border-line bg-panel absolute right-0 bottom-full z-30 mb-2 w-72 overflow-hidden rounded-xl border p-1 shadow-xl"
        >
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              role="menuitem"
              disabled={option.disabled}
              onClick={() => {
                close();
                option.onSelect();
              }}
              className="hover:bg-surface-hover flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="min-w-0">
                <span className="text-cloud block text-xs font-medium">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-fog mt-0.5 block text-[10px] leading-4">
                    {option.description}
                  </span>
                )}
              </span>
              <ShortcutHint shortcut={option.shortcut} className="shrink-0" />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-stretch">
        <Button
          variant={variant}
          className="h-10 gap-2 rounded-r-none whitespace-nowrap px-3 sm:h-11 sm:px-4"
          onClick={primary.onSelect}
          disabled={primary.disabled || pending}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{mobileLabel}</span>
          {!pending && (
            <ShortcutHint
              shortcut={primary.shortcut}
              className="hidden sm:inline-flex"
            />
          )}
        </Button>
        <Button
          ref={toggle}
          variant={variant}
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          className="h-10 rounded-l-none border-l border-l-black/15 px-2 sm:h-11 dark:border-l-white/20"
          onClick={() => setOpen((current) => !current)}
          disabled={pending}
        >
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
}

/** Renders a selectable, syntax-highlighted atomic member without hiding its code. */
export function ReviewConceptMemberPreview({
  unit,
  index,
  count,
  sourceAvailable,
  sourcePending = false,
  onSelect,
  onCommentLine,
}: {
  unit: ReviewUnit;
  index: number;
  count: number;
  sourceAvailable: boolean;
  sourcePending?: boolean;
  onSelect: () => void;
  onCommentLine?: (line: number) => void;
}) {
  // A member already signed off opens closed: its header still says what it
  // is and that it is done, and the code behind it is work the reviewer has
  // finished reading.
  const [expanded, setExpanded] = useState(() => !reviewedMember(unit));
  return (
    <article
      data-review-member-id={unit.id}
      className={cn(
        "mx-4 overflow-hidden rounded-xl border",
        // A read member stays legible but stops competing for attention, so
        // the eye lands on what is left to review.
        reviewedMember(unit)
          ? "border-addition/30 bg-addition/10"
          : "border-line bg-surface/30",
      )}
    >
      <ReviewConceptMemberHeader
        unit={unit}
        index={index}
        count={count}
        selected={false}
        onSelect={onSelect}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((open) => !open)}
      />
      {!expanded ? null : !sourceAvailable && sourcePending ? (
        <div
          role="status"
          aria-label={`Loading source for ${unit.name}`}
          className="space-y-2 px-3 py-4"
        >
          <span className="bg-surface-hover block h-2 w-3/4 animate-pulse rounded-full" />
          <span className="bg-surface-hover block h-2 w-1/2 animate-pulse rounded-full" />
        </div>
      ) : !sourceAvailable ? (
        <p className="px-3 py-4 font-sans text-[10px] text-amber-700 dark:text-amber-200">
          Source unavailable. Concept sign-off is blocked.
        </p>
      ) : unit.kind === "binary" ? (
        <p className="text-mist px-3 py-4 font-sans text-[10px]">
          Binary change · explicit acknowledgement required
        </p>
      ) : (
        <ReviewConceptMemberSource unit={unit} onCommentLine={onCommentLine} />
      )}
    </article>
  );
}

export interface AiQuestionEntry {
  error: string | null;
  id: string;
  jobId?: string;
  progress?: string;
  question: string | null;
  result: {
    summary: string;
    commentProposals?: Array<{
      body: string;
      line: number;
      path: string;
      published?: boolean;
    }>;
  } | null;
  status:
    | "queued"
    | "running"
    | "waiting_for_provider"
    | "streaming"
    | "completed"
    | "failed"
    | "cancelled";
  threadId?: string;
}

export const AI_QUICK_QUESTIONS = [
  {
    code: "Digit1",
    key: "1",
    label: "What does this code do?",
    question:
      "What does this code do, and how does it contribute to the pull request?",
  },
  {
    code: "Digit2",
    key: "2",
    label: "Why was this changed?",
    question:
      "Why was this code changed, and what behavior is different from before?",
  },
  {
    code: "Digit3",
    key: "3",
    label: "What should I review closely?",
    question:
      "What should I pay closest attention to while reviewing this code?",
  },
] as const;

const AI_CONVERSATION_VISIBILITY_KEY = "reviewduck:ai-conversation-visibility";

interface AiConversationVisibility {
  line: number;
  threadId?: string;
}

/** Reads the last explicit visibility state for a unit's AI conversation. */
export function aiConversationVisibility(
  storage: Pick<Storage, "getItem">,
  pullRequestId: string,
  unitId: string,
) {
  try {
    const stored = storage.getItem(
      `${AI_CONVERSATION_VISIBILITY_KEY}:${pullRequestId}`,
    );
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (!Object.hasOwn(value, unitId)) return undefined;
    const visibility = value[unitId];
    if (visibility === null) return null;
    if (
      typeof visibility === "object" &&
      "line" in visibility &&
      typeof visibility.line === "number" &&
      Number.isInteger(visibility.line) &&
      visibility.line > 0 &&
      (!("threadId" in visibility) ||
        visibility.threadId === undefined ||
        typeof visibility.threadId === "string")
    ) {
      return visibility as AiConversationVisibility;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Persists whether and where a unit's AI conversation is open. */
export function rememberAiConversationVisibility(
  storage: Pick<Storage, "getItem" | "setItem">,
  pullRequestId: string,
  unitId: string,
  line: number | null,
  threadId?: string,
) {
  try {
    const key = `${AI_CONVERSATION_VISIBILITY_KEY}:${pullRequestId}`;
    const stored = storage.getItem(key);
    const value = stored
      ? (JSON.parse(stored) as Record<
          string,
          AiConversationVisibility | number | null
        >)
      : {};
    value[unitId] = line === null ? null : { line, threadId };
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}

/** Finds the nearest rendered review line to a vertical pointer coordinate. */
function nearestRenderedReviewLine(
  clientY: number,
  minimumLine: number,
  maximumLine: number,
) {
  let nearest: { distance: number; line: number } | undefined;
  const seen = new Set<number>();
  for (const element of document.querySelectorAll<HTMLElement>(
    '[id^="review-line-"]',
  )) {
    const line = Number(element.id.replace("review-line-", ""));
    if (
      !Number.isInteger(line) ||
      line < minimumLine ||
      line > maximumLine ||
      seen.has(line)
    ) {
      continue;
    }
    seen.add(line);
    const bounds = element.getBoundingClientRect();
    const distance = Math.abs(clientY - (bounds.top + bounds.height / 2));
    if (!nearest || distance < nearest.distance) nearest = { distance, line };
  }
  return nearest?.line;
}

/** Renders a line-anchored AI conversation that can move through review scope. */
export function InlineAiQuestion({
  autoFocus = true,
  canAsk,
  draft,
  entries,
  line,
  maximumLine,
  minimumLine,
  onAsk,
  onChange,
  onClose,
  onDeleteThread,
  onMove,
  onPreview,
  onPublishProposal,
  onStep,
  providerName = "provider",
}: {
  autoFocus?: boolean;
  canAsk: boolean;
  draft: string;
  entries: AiQuestionEntry[];
  line: number;
  maximumLine: number;
  minimumLine: number;
  onAsk: (question?: string) => void;
  onChange: (value: string) => void;
  onClose: () => void;
  onDeleteThread?: (jobIds: string[]) => Promise<void>;
  onMove: (line: number) => void;
  onPreview: (line?: number) => void;
  onPublishProposal?: (input: {
    aiCommentIndex: number;
    aiJobId: string;
    body: string;
    line: number;
  }) => Promise<void>;
  onStep: (direction: -1 | 1) => void;
  providerName?: string;
}) {
  const previewLine = useRef(line);
  const input = useRef<HTMLTextAreaElement>(null);
  const clearDragListeners = useRef<() => void>(() => undefined);
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [publishingProposal, setPublishingProposal] = useState<string>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingThread, setDeletingThread] = useState(false);
  const threadInFlight = entries.some(({ status }) =>
    ["queued", "running", "streaming"].includes(status),
  );
  const proposalSource = useMemo(
    () =>
      [...entries]
        .reverse()
        .find((entry) => (entry.result?.commentProposals?.length ?? 0) > 0),
    [entries],
  );
  const proposals = useMemo(
    () =>
      (proposalSource?.result?.commentProposals ?? []).map(
        (proposal, index) => ({
          ...proposal,
          aiCommentIndex: index,
          aiJobId: proposalSource?.jobId,
          key: `${proposalSource?.jobId ?? proposalSource?.id ?? "question"}:${index}`,
        }),
      ),
    [proposalSource],
  );

  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    setProposalDrafts((current) => {
      const next = { ...current };
      for (const proposal of proposals) {
        if (!(proposal.key in next)) next[proposal.key] = proposal.body;
      }
      return next;
    });
  }, [proposals]);

  /** Publishes one editable structured proposal through the provider workflow. */
  const publishProposal = useCallback(
    async (proposal: (typeof proposals)[number] | undefined) => {
      if (
        !proposal ||
        proposal.published ||
        !proposal.aiJobId ||
        !onPublishProposal ||
        publishingProposal
      ) {
        return;
      }
      const body = (proposalDrafts[proposal.key] ?? proposal.body).trim();
      if (!body) return;
      setPublishingProposal(proposal.key);
      try {
        await onPublishProposal({
          aiCommentIndex: proposal.aiCommentIndex,
          aiJobId: proposal.aiJobId,
          body,
          line: proposal.line,
        });
      } finally {
        setPublishingProposal(undefined);
      }
    },
    [onPublishProposal, proposalDrafts, publishingProposal],
  );

  useEffect(() => {
    /** Handles line movement and explicitly modified quick questions. */
    function handleComposerShortcuts(event: KeyboardEvent) {
      const quickQuestion = AI_QUICK_QUESTIONS.find(
        ({ code }) => code === event.code,
      );
      if (
        quickQuestion &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        (entries.length > 0 || canAsk)
      ) {
        const target = event.target;
        const editingElsewhere =
          target instanceof HTMLElement &&
          (target.matches("input, textarea, select, [contenteditable=true]") ||
            target.isContentEditable) &&
          !target.closest("#inline-ai-question");
        if (editingElsewhere) return;
        event.preventDefault();
        event.stopPropagation();
        if (entries.length === 0) {
          onAsk(quickQuestion.question);
        } else {
          void publishProposal(proposals[Number(quickQuestion.key) - 1]);
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      onStep(event.key === "ArrowUp" ? -1 : 1);
    }

    window.addEventListener("keydown", handleComposerShortcuts, true);
    return () =>
      window.removeEventListener("keydown", handleComposerShortcuts, true);
  }, [canAsk, entries.length, onAsk, onStep, proposals, publishProposal]);

  useEffect(
    () => () => {
      clearDragListeners.current();
    },
    [],
  );

  /** Begins a window-tracked drag so the handle remains responsive off-target. */
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    clearDragListeners.current();
    previewLine.current = line;
    onPreview(line);
    const pointerId = event.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    /** Removes global drag listeners and restores document interaction styles. */
    function cleanupDrag() {
      window.removeEventListener("pointermove", previewDrag, true);
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      clearDragListeners.current = () => undefined;
    }

    /** Previews the closest rendered in-scope line beneath the pointer. */
    function previewDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      const nearest = nearestRenderedReviewLine(
        pointerEvent.clientY,
        minimumLine,
        maximumLine,
      );
      if (nearest === undefined || nearest === previewLine.current) return;
      previewLine.current = nearest;
      onPreview(nearest);
    }

    /** Commits the previewed line after a completed drag. */
    function finishDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      cleanupDrag();
      onPreview(undefined);
      onMove(previewLine.current);
    }

    /** Cancels the gesture without changing the question's anchor. */
    function cancelDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanupDrag();
      onPreview(undefined);
    }

    clearDragListeners.current = cleanupDrag;
    window.addEventListener("pointermove", previewDrag, true);
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", cancelDrag, true);
  }

  return (
    <article
      id="inline-ai-question"
      className="border-violet/25 bg-panel relative mx-4 my-3 ml-[82px] overflow-hidden rounded-xl border font-sans shadow-[0_14px_40px_var(--app-shadow)]"
    >
      <span className="bg-violet absolute inset-y-0 left-0 w-0.5" />
      <header className="flex items-center gap-2 border-b border-violet/15 px-3 py-2">
        <span className="bg-violet/10 text-violet grid size-6 place-items-center rounded-md">
          <Sparkles className="size-3.5" aria-hidden="true" />
        </span>
        <span className="text-cloud text-[10px] font-medium">
          Ask AI about line {line}
        </span>
        <button
          type="button"
          aria-label="Drag AI question to another line"
          title="Drag up or down to focus another in-scope line"
          className="text-fog hover:bg-violet/10 hover:text-violet ml-auto flex touch-none cursor-ns-resize items-center gap-1 rounded-md px-2 py-1 text-[9px] transition"
          onPointerDown={beginDrag}
        >
          <span className="hidden sm:inline">Drag</span>
          <GripVertical className="size-3.5" />
        </button>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Move AI question one line up"
            disabled={line <= minimumLine}
            onClick={() => onStep(-1)}
            className="text-fog hover:text-cloud rounded p-1 transition disabled:opacity-30"
          >
            <ChevronDown className="size-3 rotate-180" />
          </button>
          <button
            type="button"
            aria-label="Move AI question one line down"
            disabled={line >= maximumLine}
            onClick={() => onStep(1)}
            className="text-fog hover:text-cloud rounded p-1 transition disabled:opacity-30"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
        {entries.length > 0 && onDeleteThread && (
          <button
            type="button"
            aria-label="Delete AI conversation"
            title={
              threadInFlight
                ? "Wait for the current answer to finish"
                : "Delete AI conversation"
            }
            disabled={threadInFlight}
            onClick={() => setDeleteDialogOpen(true)}
            className="text-fog hover:bg-red-500/10 hover:text-red-600 rounded p-1 transition disabled:cursor-not-allowed disabled:opacity-30 dark:hover:text-red-300"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Close AI question"
          onClick={onClose}
          className="text-fog hover:text-cloud rounded p-1 transition"
        >
          <X className="size-3.5" />
        </button>
      </header>
      {entries.length > 0 && (
        <div className="grid gap-4 border-b border-violet/15 px-3 py-3">
          {entries.map((entry) => (
            <div key={entry.id} className="grid gap-3">
              <div className="flex justify-end">
                <p className="bg-surface-subtle text-cloud max-w-[88%] rounded-xl rounded-br-sm px-3 py-2 text-[11px] leading-5">
                  {entry.question}
                </p>
              </div>
              <div
                aria-live="polite"
                className="text-mist flex min-w-0 items-start gap-2.5 text-[11px] leading-5"
              >
                <span className="bg-violet/10 text-violet mt-0.5 grid size-6 shrink-0 place-items-center rounded-md">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-cloud text-[10px] font-medium">
                      ReviewDuck AI
                    </span>
                    {entry.status !== "completed" &&
                      entry.status !== "failed" && (
                        <span className="text-violet flex items-center gap-1.5 text-[9px]">
                          <LoaderCircle className="size-2.5 animate-spin" />
                          {entry.progress ?? "Reading review context…"}
                        </span>
                      )}
                  </div>
                  {entry.result?.summary ? (
                    <div className="relative">
                      <ProviderCommentBody
                        body={entry.result.summary}
                        className="mt-0 max-w-none text-[11px] leading-5"
                      />
                      {entry.status === "streaming" && (
                        <>
                          <span
                            aria-hidden="true"
                            className="bg-violet ml-0.5 inline-block h-3.5 w-0.5 animate-pulse align-[-2px]"
                          />
                          <span className="sr-only">AI is writing</span>
                        </>
                      )}
                    </div>
                  ) : entry.status === "failed" ? (
                    <div className="border-red-500/20 bg-red-500/[.045] rounded-lg border px-3 py-2 text-red-700 dark:text-red-200">
                      <p className="font-medium">Answer interrupted</p>
                      <p className="mt-0.5 text-[10px] opacity-85">
                        {entry.error ??
                          "The AI question could not be answered."}
                      </p>
                    </div>
                  ) : (
                    <div className="grid max-w-xl gap-1.5 py-1">
                      <span className="bg-violet/10 h-2 w-[78%] animate-pulse rounded-full" />
                      <span className="bg-violet/[.07] h-2 w-[58%] animate-pulse rounded-full [animation-delay:120ms]" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {proposals.length > 0 && (
        <section
          aria-label="Suggested pull request comments"
          className="grid gap-2 border-b border-violet/15 bg-violet/[.025] px-3 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                Suggested PR comments
              </p>
              <p className="text-fog mt-0.5 text-[9px]">
                ReviewDuck found something concrete enough to raise with the
                author.
              </p>
            </div>
            <Badge>{proposals.length}</Badge>
          </div>
          {proposals.map((proposal, index) => {
            const publishing = publishingProposal === proposal.key;
            const body = proposalDrafts[proposal.key] ?? proposal.body;
            return (
              <article
                key={proposal.key}
                className="border-violet/15 bg-surface/60 rounded-lg border p-2.5"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-cloud text-[10px] font-medium">
                    Comment {index + 1} · line {proposal.line}
                  </p>
                  {index < 3 && !proposal.published && (
                    <ShortcutHint
                      shortcut={[
                        {
                          key: String(index + 1),
                          mod: true,
                          shift: true,
                        },
                      ]}
                    />
                  )}
                </div>
                <textarea
                  aria-label={`Edit suggested PR comment ${index + 1}`}
                  value={body}
                  disabled={proposal.published || publishing}
                  rows={3}
                  onChange={(event) =>
                    setProposalDrafts((current) => ({
                      ...current,
                      [proposal.key]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      void publishProposal(proposal);
                    }
                  }}
                  className="bg-panel text-cloud focus:border-violet/40 w-full resize-y rounded-lg border border-line px-3 py-2 text-[11px] leading-5 outline-none disabled:opacity-65"
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-fog text-[9px]">
                    Editable · posts inline to {providerName}
                  </p>
                  {proposal.published ? (
                    <Badge className="border-lime/20 bg-lime/8 text-lime">
                      Published
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        !proposal.aiJobId ||
                        !onPublishProposal ||
                        !body.trim() ||
                        Boolean(publishingProposal)
                      }
                      onClick={() => void publishProposal(proposal)}
                    >
                      {publishing ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <Send className="size-3" />
                      )}
                      {publishing ? "Posting…" : `Post to ${providerName}`}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAsk && draft.trim()) onAsk();
        }}
      >
        <textarea
          ref={input}
          aria-label={`Ask AI about line ${line}`}
          value={draft}
          rows={2}
          placeholder="Ask a focused question about this code and its role in the pull request…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canAsk && draft.trim()) onAsk();
            }
          }}
          className="bg-surface/70 text-cloud placeholder:text-fog min-h-16 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none transition focus:border-violet/40"
        />
        {entries.length === 0 && (
          <div className="mt-2">
            <p className="text-fog mb-1.5 text-[9px] font-medium">
              Quick questions
            </p>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {AI_QUICK_QUESTIONS.map((quickQuestion) => (
                <button
                  key={quickQuestion.key}
                  type="button"
                  disabled={!canAsk}
                  aria-label={`Quick question ${quickQuestion.key}: ${quickQuestion.label}`}
                  onClick={() => onAsk(quickQuestion.question)}
                  className="border-line bg-surface/40 text-mist hover:border-violet/30 hover:bg-violet/[.06] hover:text-cloud flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[10px] transition disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ShortcutHint
                    shortcut={[
                      { key: quickQuestion.key, mod: true, shift: true },
                    ]}
                    className="shrink-0"
                  />
                  <span className="truncate">{quickQuestion.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-fog text-[9px]">
            ↑ / ↓ move focus · The answer uses this unit and the full PR
            context.
          </p>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!canAsk || !draft.trim()}
          >
            <Send className="size-3" />
            Ask
            <ShortcutHint shortcut={[{ key: "Enter" }]} />
          </Button>
        </div>
      </form>
      {deleteDialogOpen && (
        <ConfirmationDialog
          title="Delete this AI conversation?"
          description={
            <>
              The questions, answers, and unpublished suggestions in this
              line-focused conversation will be permanently deleted. Comments
              already published to {providerName} will remain.
            </>
          }
          confirmLabel="Delete conversation"
          confirmVariant="danger"
          icon={<Trash2 className="size-5" />}
          iconClassName="bg-red-500/10 text-red-600 dark:text-red-300"
          pending={deletingThread}
          pendingLabel={
            <>
              <LoaderCircle className="size-3 animate-spin" />
              Deleting…
            </>
          }
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => {
            if (deletingThread || !onDeleteThread) return;
            setDeletingThread(true);
            void onDeleteThread(
              entries.flatMap(({ jobId }) => (jobId ? [jobId] : [])),
            )
              .then(() => setDeleteDialogOpen(false))
              .catch(() => undefined)
              .finally(() => setDeletingThread(false));
          }}
        />
      )}
    </article>
  );
}

/** Renders reusable syntax-highlighted tokens for static and interactive rows. */
function HighlightedDiffTokens({
  line,
  lineNumber,
}: {
  line: HighlightedLine | undefined;
  lineNumber?: number;
}) {
  return line?.tokens.length
    ? line.tokens.map((token, index) =>
        isPeekableToken(token) ? (
          <span
            key={`${index}-${token.text.length}`}
            {...symbolPeekAttributes(token.text, lineNumber)}
            className={cn(
              "hover:decoration-cyan/45 rounded-sm hover:underline hover:decoration-dotted hover:underline-offset-4",
              token.className,
            )}
          >
            {token.text}
          </span>
        ) : (
          <span
            key={`${index}-${token.text.length}`}
            className={token.className || undefined}
          >
            {token.text}
          </span>
        ),
      )
    : " ";
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
  const pageSize = Math.min(DIFF_CONTEXT_PAGE_LINES, totalRemaining);
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
    renderLineDetails,
  },
  ref,
) {
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
    [
      compactRows,
      focusRange.end,
      focusRange.start,
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
  function selectReviewLine(event: ReactMouseEvent<HTMLElement>, line: number) {
    if (
      event.detail > 0 &&
      typeof window !== "undefined" &&
      window.getSelection()?.isCollapsed === false
    ) {
      return;
    }
    onSelectReviewLine(line);
  }
  const renderedDetailLines = new Set<number>();

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
          const rendersLineDetails =
            reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
          if (rendersLineDetails) renderedDetailLines.add(reviewLine);
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
              <div className="group relative">
                <LineContainer
                  {...(interactive
                    ? {
                        type: "button" as const,
                        "aria-label": `Comment on current line ${reviewLine}`,
                        title: "Comment on this pull-request line",
                        onClick: (event: ReactMouseEvent<HTMLElement>) =>
                          selectReviewLine(event, reviewLine),
                      }
                    : {})}
                  id={
                    !rendersLineDetails
                      ? undefined
                      : `review-line-${reviewLine}`
                  }
                  data-review-scope={isContextRow ? "context" : "unit"}
                  className={cn(
                    // Wide enough to hold the ask affordance that sits over
                    // the gutter's leading edge, a comment icon and a
                    // four-digit line number without crowding any of them.
                    "grid w-full grid-cols-[82px_minmax(0,1fr)] text-left",
                    row.kind === "added"
                      ? "bg-addition/15"
                      : "bg-surface-subtle/20",
                    interactive &&
                      "cursor-pointer transition select-text hover:bg-addition/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    highlightsReviewLine(findingLine, reviewLine) &&
                      FINDING_LINE_HIGHLIGHT,
                    highlightsReviewLine(selectedLine, reviewLine) &&
                      "bg-violet/[.055]",
                    highlightsReviewLine(keyboardLine, reviewLine) &&
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
                  <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                    <HighlightedDiffTokens
                      line={line}
                      lineNumber={lineNumber}
                    />
                  </span>
                </LineContainer>
                {interactive && onAskReviewLine && (
                  <AskAiLineButton
                    className="absolute top-1/2 left-1.5 size-4 -translate-y-1/2"
                    line={reviewLine}
                    onAsk={onAskReviewLine}
                  />
                )}
              </div>
              {rendersLineDetails && renderLineDetails?.(reviewLine)}
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
        const rendersLineDetails =
          reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
        if (rendersLineDetails) renderedDetailLines.add(reviewLine);
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
            {rendersLineDetails && (
              <span
                id={`review-line-${reviewLine}`}
                className="block h-0"
                aria-hidden="true"
              />
            )}
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "group relative hidden grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] sm:grid",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {reviewLine !== undefined && onAskReviewLine && (
                <AskAiLineButton
                  className="bg-panel/90 absolute top-1/2 right-2 z-10 size-5 -translate-y-1/2 rounded-md border border-line shadow-sm"
                  line={reviewLine}
                  onAsk={onAskReviewLine}
                />
              )}
              {previousIsReviewLine ? (
                <button
                  type="button"
                  aria-label={`Comment on deleted line ${reviewLine}`}
                  title="Comment on this deleted pull-request line"
                  onClick={(event) => selectReviewLine(event, reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] bg-red-400/15 text-left transition select-text hover:bg-red-400/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    findingLine === reviewLine && FINDING_LINE_HIGHLIGHT,
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
                        "bg-red-400/15",
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
                      "bg-addition/15",
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
                  aria-label={`Comment on current line ${reviewLine}`}
                  title="Comment on this pull-request line"
                  onClick={(event) => selectReviewLine(event, reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition select-text hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    (row.kind === "added" || row.kind === "modified") &&
                      "bg-addition/15 hover:bg-addition/22",
                    findingLine === reviewLine && FINDING_LINE_HIGHLIGHT,
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
                  <span className="syntax-code min-w-0 cursor-text overflow-visible px-3 whitespace-pre-wrap break-words text-cloud select-text">
                    <HighlightedDiffTokens
                      line={currentLine}
                      lineNumber={currentLineNumber}
                    />
                  </span>
                </button>
              )}
            </div>
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "group relative sm:hidden",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {reviewLine !== undefined && onAskReviewLine && (
                <AskAiLineButton
                  className="bg-panel/90 absolute top-1/2 right-2 z-10 size-5 -translate-y-1/2 rounded-md border border-line shadow-sm"
                  line={reviewLine}
                  onAsk={onAskReviewLine}
                />
              )}
              {row.kind === "unchanged" ? (
                <div
                  className={cn(
                    "grid grid-cols-[42px_42px_minmax(0,1fr)]",
                    highlightsReviewLine(findingLine, reviewLine) &&
                      FINDING_LINE_HIGHLIGHT,
                    highlightsReviewLine(selectedLine, reviewLine) &&
                      "bg-violet/[.055]",
                    highlightsReviewLine(keyboardLine, reviewLine) &&
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
                      onClick={(event) => selectReviewLine(event, reviewLine)}
                      className="group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition select-text hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
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
                    (previousIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on deleted line ${reviewLine}`}
                        title="Comment on this deleted pull-request line"
                        onClick={(event) => selectReviewLine(event, reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/15 text-left transition select-text hover:bg-red-400/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          findingLine === reviewLine && FINDING_LINE_HIGHLIGHT,
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
                    (currentIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on current line ${reviewLine}`}
                        title="Comment on this pull-request line"
                        onClick={(event) => selectReviewLine(event, reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/15 text-left transition select-text hover:bg-addition/22 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          findingLine === reviewLine && FINDING_LINE_HIGHLIGHT,
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
            {rendersLineDetails && renderLineDetails?.(reviewLine)}
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

/** The conversation actions a reviewer may take without leaving ReviewDuck. */
export interface ProviderConversationActions {
  onDeleteComment: (commentExternalId: string) => Promise<unknown>;
  onDeleteThread: () => Promise<unknown>;
  onEditComment: (commentExternalId: string, body: string) => Promise<unknown>;
  onReply: (body: string) => Promise<unknown>;
  onResolve: (resolved: boolean) => Promise<unknown>;
}

/** Renders the provider conversation interface. */
export function ProviderConversation({
  className,
  managing = false,
  newSince,
  onDeleteComment,
  onDeleteThread,
  onEditComment,
  onReply,
  onResolve,
  provider,
  replying,
  thread,
  publishedByReviewDuck,
}: ProviderConversationActions & {
  className?: string;
  managing?: boolean;
  /** Marks comments after this moment as the activity a wait was paused for. */
  newSince?: Date | null;
  provider: WorkspaceData["pullRequest"]["provider"];
  replying: boolean;
  thread: ProviderConversationThread;
  publishedByReviewDuck: boolean;
}) {
  /** Reports whether one comment arrived after the reviewer began waiting. */
  const isNewComment = (createdAt: string) =>
    Boolean(newSince && new Date(createdAt) > newSince);
  // A resolved conversation normally starts collapsed, but the one a wait was
  // paused for holds the answer the reviewer came back to read.
  const hasNewComments = thread.comments.some(({ createdAt }) =>
    isNewComment(createdAt),
  );
  const [expanded, setExpanded] = useState(
    thread.status !== "resolved" || hasNewComments,
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editBody, setEditBody] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<
    { kind: "thread" } | { kind: "comment"; externalId: string }
  >();
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  // `managing` only reaches this component on the render after a mutation
  // starts, so a second activation in the same frame would send twice.
  const inFlight = useRef(false);
  const [resolving, setResolving] = useState(false);
  const resolved = thread.status === "resolved";
  // Deleting a conversation takes every comment in it, so one belonging to
  // someone else puts the whole conversation out of this reviewer's reach.
  const holdsAnotherReviewersComment = thread.comments.some(
    ({ publishedByAnotherReviewer }) => publishedByAnotherReviewer,
  );

  useEffect(() => {
    if (replyOpen) replyInputRef.current?.focus();
  }, [replyOpen]);

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setExpanded(thread.status !== "resolved" || hasNewComments);
    setReplyOpen(false);
  }, [thread.status, hasNewComments]);

  /** Publishes the draft while preserving it if the provider rejects the reply. */
  async function submitReply() {
    const body = replyBody.trim();
    if (!body || replying || inFlight.current) return;
    inFlight.current = true;
    try {
      await onReply(body);
      setReplyBody("");
      setReplyOpen(false);
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    } finally {
      inFlight.current = false;
    }
  }

  /** Saves an edited comment, keeping the draft open if the provider says no. */
  async function submitEdit(commentExternalId: string) {
    const body = editBody.trim();
    if (!body || managing || inFlight.current) return;
    inFlight.current = true;
    try {
      await onEditComment(commentExternalId, body);
      setEditing(undefined);
      setEditBody("");
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    } finally {
      inFlight.current = false;
    }
  }

  /** Resolves or reopens the conversation, leaving the error to the mutation. */
  async function submitResolution(resolve: boolean) {
    if (managing || inFlight.current) return;
    inFlight.current = true;
    setResolving(true);
    try {
      await onResolve(resolve);
    } catch {
      // The mutation owns the user-facing error, and the header keeps showing
      // the resolution the provider still reports.
    } finally {
      inFlight.current = false;
      setResolving(false);
    }
  }

  /** Carries out the deletion the reviewer just confirmed. */
  async function confirmDelete() {
    const target = confirmingDelete;
    if (!target || managing || inFlight.current) return;
    inFlight.current = true;
    try {
      await (target.kind === "thread"
        ? onDeleteThread()
        : onDeleteComment(target.externalId));
      setConfirmingDelete(undefined);
    } catch {
      // The mutation owns the user-facing error; the dialog stays for a retry.
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <article
      className={cn(
        "border-cyan/20 bg-panel mx-4 my-2 ml-[82px] overflow-hidden rounded-xl border font-sans shadow-lg",
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
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={managing}
            aria-label={
              resolved
                ? "Reopen this conversation"
                : "Resolve this conversation"
            }
            title={
              resolved
                ? `Reopen this conversation on ${providerLabel(provider)}`
                : `Resolve this conversation on ${providerLabel(provider)}`
            }
            onClick={() => void submitResolution(!resolved)}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] transition disabled:opacity-50",
              resolved
                ? "text-mist hover:text-cloud hover:bg-surface-subtle"
                : "text-lime hover:bg-lime/10",
            )}
          >
            {resolving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : resolved ? (
              <CircleDot className="size-3.5" />
            ) : (
              <CircleCheck className="size-3.5" />
            )}
            <span className="hidden sm:inline">
              {resolving
                ? resolved
                  ? "Reopening…"
                  : "Resolving…"
                : resolved
                  ? "Reopen"
                  : "Resolve"}
            </span>
          </button>
          <button
            type="button"
            disabled={managing || holdsAnotherReviewersComment}
            aria-label="Delete this conversation"
            title={
              holdsAnotherReviewersComment
                ? "Another reviewer published a comment in this conversation"
                : `Delete this conversation on ${providerLabel(provider)}`
            }
            onClick={() => setConfirmingDelete({ kind: "thread" })}
            className="text-mist grid size-6 place-items-center rounded-md transition hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
          {thread.webUrl && (
            <a
              href={thread.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open this conversation on ${providerLabel(provider)}`}
              className="text-mist hover:text-cloud grid size-6 place-items-center rounded-md transition hover:bg-surface-subtle"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </header>
      {expanded && (
        <>
          <div className="divide-y divide-line">
            {thread.comments.map((comment, index) => (
              <div
                key={comment.externalId}
                className={cn(
                  "group/comment px-4 py-4 sm:px-5",
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
                    <span className="text-cyan text-[8px] font-semibold tracking-wider uppercase">
                      Reply
                    </span>
                  )}
                  {isNewComment(comment.createdAt) && (
                    <span className="border-lime/25 bg-lime/10 text-lime rounded-full border px-1.5 py-px text-[8px] font-semibold tracking-wider uppercase">
                      New
                    </span>
                  )}
                  {/* One workspace connection speaks for every member, so
                      the provider would allow this and only ReviewDuck knows
                      whose words they are. A control the reviewer may not use
                      is not offered at all. */}
                  {!comment.publishedByAnotherReviewer && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        disabled={managing}
                        aria-label={`Edit the comment by ${comment.author}`}
                        title="Edit this comment"
                        onClick={() => {
                          setEditing(comment.externalId);
                          setEditBody(comment.body);
                        }}
                        className="text-mist hover:text-cyan grid size-6 place-items-center rounded-md transition hover:bg-surface-subtle disabled:opacity-50"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        disabled={managing}
                        aria-label={`Delete the comment by ${comment.author}`}
                        title="Delete this comment"
                        onClick={() =>
                          setConfirmingDelete({
                            kind: "comment",
                            externalId: comment.externalId,
                          })
                        }
                        className="text-mist grid size-6 place-items-center rounded-md transition hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  )}
                </div>
                {editing === comment.externalId ? (
                  <div className="mt-2">
                    <textarea
                      ref={editInputRef}
                      aria-label={`Edit the comment by ${comment.author} on ${providerLabel(provider)}`}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(undefined);
                        } else if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          void submitEdit(comment.externalId);
                        }
                      }}
                      rows={3}
                      className="bg-surface text-cloud focus:border-cyan/45 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <span className="text-fog mr-auto flex items-center gap-1 text-[9px]">
                        <ShortcutHint shortcut={reviewShortcuts.postComment} />
                        save · Esc cancels
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={managing}
                        onClick={() => setEditing(undefined)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          managing ||
                          !editBody.trim() ||
                          editBody.trim() === comment.body.trim()
                        }
                        onClick={() => void submitEdit(comment.externalId)}
                      >
                        {managing ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <Check className="size-3" />
                        )}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ProviderCommentBody body={comment.body} />
                )}
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
      {confirmingDelete && (
        <ConfirmationDialog
          confirmLabel="Delete"
          confirmVariant="danger"
          icon={<Trash2 className="text-coral size-5" />}
          title={
            confirmingDelete.kind === "thread"
              ? "Delete this conversation?"
              : "Delete this comment?"
          }
          description={
            confirmingDelete.kind === "thread"
              ? `This removes all ${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"} from ${providerLabel(provider)}. It cannot be undone.`
              : `This removes the comment from ${providerLabel(provider)}. It cannot be undone.`
          }
          pending={managing}
          pendingLabel={
            <>
              <LoaderCircle className="size-3 animate-spin" />
              Deleting…
            </>
          }
          onCancel={() => setConfirmingDelete(undefined)}
          onConfirm={() => void confirmDelete()}
        />
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
export { knownLanguage, supportedLanguage } from "~/lib/syntax-highlighting";

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

/** Renders file imports as relevance-aware context for the focused unit view. */
export function UnitImportContext({
  fileSource,
  previousFileSource,
  unitSource,
  language,
  unitId,
  visibleStartLine,
  visibleEndLine,
  previousVisibleStartLine,
  previousVisibleEndLine,
  resolvingImport,
  continued = false,
  onFollow,
}: {
  fileSource: string;
  previousFileSource?: string;
  unitSource: string;
  language: string;
  unitId: string;
  visibleStartLine: number;
  visibleEndLine: number;
  previousVisibleStartLine?: number;
  previousVisibleEndLine?: number;
  resolvingImport?: string;
  continued?: boolean;
  onFollow: (reference: ImportReference) => void;
}) {
  const currentStatements = useImportStatements(fileSource, language);
  const previousStatements = useImportStatements(
    previousFileSource ?? "",
    language,
  );
  const pairs = useMemo(() => {
    const previousStart = previousVisibleStartLine ?? visibleStartLine;
    const previousEnd = previousVisibleEndLine ?? visibleEndLine;
    return pairImportStatements(previousStatements, currentStatements).filter(
      (pair) => {
        if (pair.kind === "deleted") {
          return (
            pair.previous.endLine < previousStart ||
            pair.previous.startLine > previousEnd
          );
        }
        return (
          pair.current.endLine < visibleStartLine ||
          pair.current.startLine > visibleEndLine
        );
      },
    );
  }, [
    currentStatements,
    previousStatements,
    previousVisibleEndLine,
    previousVisibleStartLine,
    visibleEndLine,
    visibleStartLine,
  ]);
  const usedReferences = useMemo(
    () =>
      new Set(
        currentStatements
          .flatMap(({ references }) => references)
          .filter((reference) => importReferenceIsUsed(reference, unitSource))
          .map((reference) => `${reference.from}:${reference.to}`),
      ),
    [currentStatements, unitSource],
  );
  if (pairs.length === 0) return null;

  return (
    <section
      aria-label="Imports for this unit"
      className={cn(
        "mx-4 -mt-px overflow-hidden border-x border-b border-line bg-surface/35 font-sans",
        continued ? undefined : "mb-3 rounded-b-xl",
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-fog flex items-center gap-2 text-[9px] font-semibold tracking-[.12em] uppercase">
          <ArrowUpFromLine className="text-cyan size-3" aria-hidden="true" />
          Imports
        </span>
        <span className="text-fog shrink-0 text-[9px]">
          Declared outside this unit · used names highlighted
        </span>
      </header>
      {pairs.map((pair) => (
        <ImportContextPair
          key={importPairKey(pair)}
          pair={pair}
          language={language}
          unitId={unitId}
          usedReferences={usedReferences}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      ))}
    </section>
  );
}

/** Stable React key for one paired import context entry. */
function importPairKey(pair: PairedImportStatement) {
  if (pair.kind === "deleted") {
    return `deleted:${pair.previous.from}:${pair.previous.to}`;
  }
  return `${pair.kind}:${pair.current.from}:${pair.current.to}`;
}

/** Renders one import statement, including before/after lines for rewrites. */
function ImportContextPair({
  pair,
  language,
  unitId,
  usedReferences,
  resolvingImport,
  onFollow,
}: {
  pair: PairedImportStatement;
  language: string;
  unitId: string;
  usedReferences: ReadonlySet<string>;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  if (pair.kind === "deleted") {
    return (
      <ImportContextStatement
        statement={pair.previous}
        language={language}
        unitId={unitId}
        tone="deleted"
        usedReferences={usedReferences}
        interactive={false}
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    );
  }
  return (
    <>
      {pair.previous && pair.kind === "modified" && (
        <ImportContextStatement
          statement={pair.previous}
          language={language}
          unitId={unitId}
          tone="deleted"
          usedReferences={usedReferences}
          interactive={false}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      )}
      <ImportContextStatement
        statement={pair.current}
        language={language}
        unitId={unitId}
        tone={pair.kind === "unchanged" ? "context" : "added"}
        usedReferences={usedReferences}
        interactive
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    </>
  );
}

/** Renders a single import statement line block with optional change styling. */
function ImportContextStatement({
  statement,
  language,
  unitId,
  tone,
  usedReferences,
  interactive,
  resolvingImport,
  onFollow,
}: {
  statement: ImportStatement;
  language: string;
  unitId: string;
  tone: "context" | "added" | "deleted";
  usedReferences: ReadonlySet<string>;
  interactive: boolean;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  const highlightedLines = useHighlightedSource(statement.source, language);
  return (
    <>
      {highlightedLines.map((line, lineIndex) => {
        const lineNumber = statement.startLine + lineIndex;
        return (
          <div
            key={`${statement.from}-${tone}-${lineIndex}`}
            className={cn(
              "group grid grid-cols-[55px_1fr] border-l-2 px-4",
              tone === "added" &&
                "border-l-addition/45 bg-addition/15 hover:bg-addition/20",
              tone === "deleted" &&
                "border-l-red-400/45 bg-red-400/15 hover:bg-red-400/20",
              tone === "context" &&
                "border-transparent bg-surface-subtle/15 hover:bg-surface-subtle",
            )}
          >
            <span
              className={cn(
                "flex items-center justify-end pr-3 text-right opacity-55 select-none group-hover:opacity-80",
                tone === "added" && "text-addition opacity-80",
                tone === "deleted" &&
                  "text-red-700 opacity-80 dark:text-red-200",
                tone === "context" && "text-fog",
              )}
            >
              {lineNumber}
            </span>
            <pre
              className={cn(
                "syntax-code overflow-visible text-cloud",
                tone === "deleted" && "line-through opacity-80",
              )}
            >
              {line.tokens.length
                ? line.tokens.map((token, tokenIndex) => {
                    const reference = statement.references.find(
                      (candidate) =>
                        candidate.from - statement.from >= token.from &&
                        candidate.to - statement.from <= token.to,
                    );
                    if (!interactive || !reference) {
                      return (
                        <span
                          key={`${tokenIndex}-${token.text.length}`}
                          {...(isPeekableToken(token)
                            ? symbolPeekAttributes(token.text, lineNumber)
                            : undefined)}
                          className={cn(
                            token.className,
                            tone === "context" &&
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
                        {...symbolPeekAttributes(reference.local, lineNumber)}
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
      })}
    </>
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

/**
 * Lets the reviewer choose which concept the open unit should join.
 *
 * The control this replaces moved the unit to whichever concept happened to
 * come next and wrapped around at the end, so the destination was neither
 * stated nor chosen. Naming every candidate makes the move deliberate.
 */
export function ConceptMoveDialog({
  concepts,
  currentConceptId,
  pending,
  unitName,
  onSelect,
  onClose,
}: {
  concepts: WorkspaceData["concepts"];
  currentConceptId: string;
  pending: boolean;
  unitName: string;
  onSelect: (conceptId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    /** Closes the move dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, pending]);
  const source = concepts.find(({ id }) => id === currentConceptId);
  const destinations = concepts.filter(({ id }) => id !== currentConceptId);
  // A concept with nothing left in it is dropped rather than kept empty, and
  // the reviewer should know that before the last member leaves.
  const emptiesSource = source?.memberIds.length === 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="concept-move-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <FolderInput className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="concept-move-title"
                className="text-cloud text-sm font-medium"
              >
                Move this unit to another concept
              </h2>
              <p className="text-mist mt-1 truncate font-mono text-[11px]">
                {unitName}
              </p>
              {source && (
                <p className="text-fog mt-0.5 truncate text-[10px] leading-4">
                  Now reviewed in {source.title}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close move dialog"
            disabled={pending}
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          <p className="text-fog mb-3 px-1 text-[10px] leading-4">
            Pick where it should be reviewed instead. The code under review does
            not change — only which concept you read it alongside.
          </p>
          <div className="space-y-2">
            {destinations.length === 0 ? (
              <p className="text-mist rounded-xl border border-dashed border-line p-4 text-xs leading-5">
                This review has no other concept to move the unit into. Split a
                concept first, and the pieces become destinations.
              </p>
            ) : (
              destinations.map((concept) => (
                <button
                  key={concept.id}
                  type="button"
                  disabled={pending}
                  onClick={() => onSelect(concept.id)}
                  className="hover:border-cyan/30 hover:bg-cyan/[.03] flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-cloud block truncate text-[11px]">
                      {concept.title}
                    </span>
                    <span className="text-fog mt-0.5 block truncate text-[9px]">
                      {concept.memberIds.length}{" "}
                      {concept.memberIds.length === 1 ? "unit" : "units"} ·{" "}
                      {concept.changedLineCount} changed lines in{" "}
                      {concept.fileCount}{" "}
                      {concept.fileCount === 1 ? "file" : "files"}
                    </span>
                  </span>
                  <ChevronRight className="text-mist size-3.5 shrink-0" />
                </button>
              ))
            )}
          </div>
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <span>
            {emptiesSource
              ? "This is the last unit in its concept, so that concept is removed."
              : "Reordering a concept never removes a unit from the review."}
          </span>
          <span className="shrink-0">{pending ? "Moving…" : "Esc closes"}</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Presents the pull request the reviewer is working through.
 *
 * ReviewDuck deliberately opens on the code rather than on the prose around
 * it, so the author's own account of the change is a click away instead of a
 * trip back to the provider. The body is provider Markdown and is rendered
 * through the same allowlist as every other untrusted provider text.
 */
export function PullRequestDetailsDialog({
  pullRequest,
  onClose,
}: {
  pullRequest: WorkspaceData["pullRequest"];
  onClose: () => void;
}) {
  useEffect(() => {
    /** Closes the details dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const description = pullRequest.description?.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pull-request-details-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <Info className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="pull-request-details-title"
                className="text-cloud text-sm font-medium"
              >
                {pullRequest.title}
              </h2>
              <p className="text-fog mt-1 truncate text-[10px] leading-4">
                {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #
                {pullRequest.number} · {providerLabel(pullRequest.provider)}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close pull request details"
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
          <div className="text-fog flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px]">
            <span className="text-mist">{pullRequest.authorLogin}</span>
            <span
              role="img"
              aria-label={`${pullRequest.sourceBranch} into ${pullRequest.targetBranch}`}
              className="border-line bg-surface-subtle text-mist inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono"
            >
              <GitBranch className="text-cyan size-3" aria-hidden="true" />
              <span className="truncate">{pullRequest.sourceBranch}</span>
              <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{pullRequest.targetBranch}</span>
            </span>
          </div>
          {description ? (
            <ProviderCommentBody
              body={description}
              className="mt-4 max-w-none"
            />
          ) : (
            <p className="text-mist mt-4 rounded-xl border border-dashed border-line p-4 text-xs leading-5">
              This pull request has no description on{" "}
              {providerLabel(pullRequest.provider)}.
            </p>
          )}
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <a
            href={pullRequest.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan inline-flex items-center gap-1.5 transition hover:underline"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            Open on {providerLabel(pullRequest.provider)}
          </a>
          <span className="shrink-0">Esc closes</span>
        </footer>
      </div>
    </div>
  );
}
