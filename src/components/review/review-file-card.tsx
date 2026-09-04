"use client";

import {
  Check,
  ChevronRight,
  Clock3,
  Copy,
  LoaderCircle,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { formatReviewSourceBytes } from "~/lib/review-source-display";
import {
  sourceByteOffsetLine,
  sourceEndLine,
  sourceStartLine,
} from "~/lib/side-by-side-diff";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type ReviewUnit = RouterOutputs["review"]["workspace"]["units"][number];

type ReviewCardMemberState = {
  revisionState?: string;
  status: string;
};

/** Signed-off units start compact; a reviewer can still reopen any of them. */
export function reviewUnitStartsCollapsed(member: ReviewCardMemberState) {
  return member.status === "signed_off";
}

/**
 * Reports whether a file-card member still needs the reviewer's attention.
 *
 * Standing sign-off is done. Waiting is paused, not owed. A unit that
 * appeared or changed after a revision arrives as pending or changed, so it
 * stays outstanding until it has its own sign-off.
 */
function outstandingReviewCardMember(member: ReviewCardMemberState) {
  return member.status !== "signed_off" && member.status !== "waiting";
}

/** Reports whether every atomic unit in a file card has been signed off. */
export function reviewedFileCard(members: readonly ReviewCardMemberState[]) {
  return members.length > 0 && !members.some(outstandingReviewCardMember);
}

/** Chooses the member a file card should open for the next review action. */
export function actionableReviewCardMember<
  Member extends ReviewCardMemberState,
>(members: readonly Member[]) {
  return members.find(outstandingReviewCardMember) ?? members[0];
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

/**
 * Copies a card-title file path without leaving the review.
 *
 * The path is truncated in the title, so a check replaces the icon once the
 * clipboard has it and a toast is not needed to confirm the click.
 */
export function CopyReviewPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** Puts the file path on the clipboard. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
    } catch {
      toast.error("Could not copy the file path");
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? "File path copied" : "Copy file path"}
      title={copied ? "Copied" : "Copy file path"}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      className="text-fog hover:text-mist grid size-5 shrink-0 place-items-center rounded transition hover:bg-surface-subtle"
    >
      {copied ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
    </button>
  );
}

/** Path, copy control, and meta for a card title that must stay selectable. */
export function ReviewCardPathTitle({
  meta,
  onSelect,
  path,
  selectLabel,
  selected,
  subtitle,
}: {
  meta: ReactNode;
  onSelect?: () => void;
  path: string;
  selectLabel: string;
  selected: boolean;
  subtitle: ReactNode;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left">
      {!selected && (
        <button
          type="button"
          aria-label={selectLabel}
          onClick={onSelect}
          className="hover:bg-surface-subtle absolute inset-0 transition"
        />
      )}
      <span
        className={cn(
          "relative z-10 min-w-0",
          !selected && "pointer-events-none",
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-cloud min-w-0 truncate font-mono text-[10px]">
            {path}
          </span>
          <span className="pointer-events-auto">
            <CopyReviewPathButton path={path} />
          </span>
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px]">
          {subtitle}
        </span>
      </span>
      <span
        className={cn(
          "relative z-10 flex shrink-0 items-center gap-2 text-[9px]",
          !selected && "pointer-events-none",
        )}
      >
        {meta}
      </span>
    </div>
  );
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
  expanded,
  onToggleExpanded,
  sourceBytes,
  onResumeWaiting,
}: {
  members: readonly ReviewUnit[];
  index: number;
  count: number;
  selected: boolean;
  actions?: ReactNode;
  onSelect?: () => void;
  itemLabel?: "Card" | "File";
  expanded?: boolean;
  onToggleExpanded?: () => void;
  sourceBytes?: number;
  onResumeWaiting?: () => void;
}) {
  const first = members[0];
  if (!first) return null;
  const outstanding = members.filter(outstandingReviewCardMember).length;
  const waitingCount = members.filter(
    (member) => member.status === "waiting",
  ).length;
  const fullyReviewed = reviewedFileCard(members) && waitingCount === 0;
  const changedLines = members.reduce(
    (total, member) => total + member.changedLineCount,
    0,
  );
  const itemName = itemLabel.toLowerCase();
  const fileName = first.path.split("/").at(-1) ?? first.path;
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
      {onToggleExpanded && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${fileName}`}
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
      <ReviewCardPathTitle
        path={first.path}
        selected={selected}
        onSelect={onSelect}
        selectLabel={`Select review ${itemName} for ${first.path}`}
        subtitle={
          <>
            Reviewing {members.length} individual{" "}
            {members.length === 1 ? "unit" : "units"} in this {itemName} ·{" "}
            {changedLines} changed lines
            {sourceBytes ? ` · ${formatReviewSourceBytes(sourceBytes)}` : null}
          </>
        }
        meta={
          <>
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
            {selected &&
              (outstanding > 0 ? (
                <span className="border-cyan/25 bg-cyan/10 text-cyan rounded-full border px-2 py-0.5">
                  {outstanding} remaining
                </span>
              ) : fullyReviewed ? (
                <span className="border-cyan/25 bg-cyan/10 text-cyan rounded-full border px-2 py-0.5">
                  Selected
                </span>
              ) : onResumeWaiting ? (
                <button
                  type="button"
                  aria-label="Resume waiting on this file"
                  title="Take back the wait and return this file to the review path"
                  onClick={onResumeWaiting}
                  className="border-cyan/25 bg-cyan/10 text-cyan hover:bg-cyan/15 flex items-center gap-1 rounded-full border px-2 py-0.5 transition"
                >
                  <Clock3 className="size-2.5" aria-hidden />
                  Waiting
                </button>
              ) : (
                <span className="border-cyan/25 bg-cyan/10 text-cyan flex items-center gap-1 rounded-full border px-2 py-0.5">
                  <Clock3 className="size-2.5" aria-hidden />
                  Waiting
                </span>
              ))}
          </>
        }
      />
    </div>
  );
}

/**
 * Labels one file-mode unit as a section in the source, not a separate card.
 *
 * A rule carrying the unit name and its line span makes each banner an
 * opener for the code that follows rather than a closer for the code above.
 */
export function ReviewFileUnitMarker({
  collapsed = false,
  member,
  onToggleReview,
  onStopWaiting,
  onToggleCollapsed,
  reviewActionDisabled = false,
  reviewActionPending = false,
}: {
  collapsed?: boolean;
  member: ReviewUnit;
  onToggleReview?: () => void;
  onStopWaiting?: () => void;
  onToggleCollapsed?: () => void;
  reviewActionDisabled?: boolean;
  reviewActionPending?: boolean;
}) {
  const lineLabel =
    member.endLine > member.startLine
      ? `L${member.startLine}–${member.endLine}`
      : `L${member.startLine}`;
  return (
    <div
      data-review-unit-start={member.id}
      className="my-2 flex items-center gap-2 px-4 font-sans"
    >
      <span className="bg-cyan/45 h-px w-5 shrink-0" />
      {onToggleCollapsed ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${member.name}`}
          title={`${collapsed ? "Expand" : "Collapse"} this review unit`}
          onClick={onToggleCollapsed}
          className="text-cloud hover:text-cyan flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 transition hover:bg-cyan/[.06]"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate text-[10px] font-medium">
            {member.name}
          </span>
          <span className="text-fog shrink-0 font-mono text-[9px]">
            {lineLabel}
          </span>
        </button>
      ) : (
        <>
          <span className="text-cloud min-w-0 truncate text-[10px] font-medium">
            {member.name}
          </span>
          <span className="text-fog shrink-0 font-mono text-[9px]">
            {lineLabel}
          </span>
        </>
      )}
      <span className="h-px min-w-3 flex-1 bg-line" />
      {member.revisionState === "new" && (
        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">New</Badge>
      )}
      {member.revisionState === "updated" && (
        <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
          Updated
        </Badge>
      )}
      {onToggleReview && (
        <button
          type="button"
          aria-label={
            reviewActionPending
              ? `Saving review for ${member.name}`
              : member.status === "signed_off"
                ? `Mark ${member.name} as not reviewed`
                : `Sign off ${member.name}`
          }
          title={
            member.status === "signed_off"
              ? "Mark this unit as not reviewed"
              : member.status === "waiting"
                ? "Resume this unit before signing it off"
                : "Sign off this unit"
          }
          disabled={reviewActionDisabled || reviewActionPending}
          onClick={onToggleReview}
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md border border-line text-fog transition disabled:cursor-not-allowed disabled:opacity-45",
            member.status === "signed_off"
              ? "hover:border-coral/30 hover:bg-coral/[.07] hover:text-coral"
              : "hover:border-lime/30 hover:bg-lime/[.07] hover:text-lime",
          )}
        >
          {reviewActionPending ? (
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
          ) : member.status === "signed_off" ? (
            <Undo2 className="size-3" aria-hidden />
          ) : (
            <Check className="size-3" aria-hidden />
          )}
        </button>
      )}
      {member.status === "signed_off" ? (
        <Badge className="border-lime/25 bg-lime/10 text-lime">
          <Check className="size-3" />
          {member.signOffOrigin === "preserved"
            ? "Reviewed earlier"
            : "Reviewed"}
        </Badge>
      ) : member.status === "waiting" ? (
        onStopWaiting ? (
          <button
            type="button"
            aria-label={`Resume waiting on ${member.name}`}
            title="Take back the wait and return this unit to the review path"
            onClick={onStopWaiting}
            className="border-cyan/25 bg-cyan/10 text-cyan hover:bg-cyan/15 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition"
          >
            <Clock3 className="size-3" />
            Waiting
          </button>
        ) : (
          <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
            <Clock3 className="size-3" />
            Waiting
          </Badge>
        )
      ) : (
        <Badge>Not reviewed</Badge>
      )}
    </div>
  );
}
