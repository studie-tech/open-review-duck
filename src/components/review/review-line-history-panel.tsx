"use client";

import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  commitEffectLabels,
  type LineHistoryCommit,
  type LineHistorySelection,
} from "~/lib/line-commit-history";
import { formatRelativeTime, useRelativeClock } from "~/lib/relative-time";
import { cn } from "~/lib/utils";

/** Commit list for the lines the reviewer has selected in a diff. */
export interface LineHistoryView {
  status: "idle" | "loading" | "error" | "ready";
  commits: LineHistoryCommit[];
  truncated: boolean;
  unmapped: boolean;
  onRequest: () => void;
}

/** Counts commits the way the selection chip reads them aloud. */
function commitCountLabel(count: number) {
  return count === 1 ? "1 commit" : `${count} commits`;
}

/** Explains why line numbers are missing from an otherwise ready history. */
function historyNote(history: LineHistoryView) {
  if (history.truncated) {
    return "This file changed in more commits than can be mapped onto lines.";
  }
  if (history.unmapped) {
    return "Some commits could not be mapped onto individual lines.";
  }
  return "Commits in this pull request.";
}

/** Picks the swatch that matches how a commit meets the selection. */
function commitSwatch(labels: readonly string[]) {
  const removed = labels.some((label) => label.startsWith("Removed"));
  const added = labels.some((label) => label.startsWith("Added"));
  if (removed && !added) return "bg-coral";
  if (added && !removed) return "bg-addition";
  return "bg-cyan";
}

/**
 * Shows the commits for a selected line range without a permanent panel.
 *
 * The chip sits on the selection. Opening it lists subjects and bodies, and
 * hovering a commit reports that commit back so the diff can light its lines.
 */
export function LineHistoryControl({
  history,
  selection,
  commits,
  open,
  onOpenChange,
  onHoverCommit,
  onClear,
}: {
  history: LineHistoryView;
  selection: LineHistorySelection;
  commits: readonly LineHistoryCommit[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onHoverCommit: (sha: string | undefined) => void;
  onClear: () => void;
}) {
  const [fetchedAt] = useState(() => Date.now());
  const now = useRelativeClock(fetchedAt);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const loading = history.status === "idle" || history.status === "loading";
  const contentKey = `${history.status}:${commits.length}`;
  const label =
    history.status === "error"
      ? "Commits unavailable"
      : loading
        ? "Looking up commits"
        : commitCountLabel(commits.length);

  useLayoutEffect(() => {
    if (!open) return;
    /** Pins the commit list to the chip, inside the viewport. */
    const place = () => {
      const chip = buttonRef.current?.getBoundingClientRect();
      if (!chip || contentKey.length === 0) return;
      const width = 352;
      const margin = 12;
      const left = Math.min(
        Math.max(margin, chip.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const below = chip.bottom + 8;
      const panelHeight = panelRef.current?.offsetHeight ?? 280;
      const top =
        below + panelHeight > window.innerHeight - margin
          ? Math.max(margin, chip.top - panelHeight - 8)
          : below;
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [contentKey, open]);

  useEffect(() => {
    if (!open) return;
    /** Closes the list when the pointer lands outside it and the chip. */
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () =>
      document.removeEventListener("pointerdown", closeOnPointerDown);
  }, [onOpenChange, open]);

  return (
    <div
      data-history-control=""
      className="absolute top-full left-16 z-20 -translate-y-1/2"
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-label={loading ? "Looking up commits" : `Show ${label}`}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "inline-flex h-[22px] items-center gap-1.5 rounded-full border bg-panel px-2 font-sans text-[11px] font-semibold text-cyan shadow-[0_8px_22px_rgba(0,0,0,0.45)]",
          open ? "border-cyan/50 bg-[#152026]" : "border-line",
        )}
      >
        <GitCommitHorizontal className="size-3" aria-hidden="true" />
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-labelledby={titleId}
            className="fixed z-50 w-[22rem] overflow-hidden rounded-xl border border-line bg-panel shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
            style={position ?? { top: 0, left: 0, visibility: "hidden" }}
          >
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2.5">
              <strong id={titleId} className="text-cloud text-xs font-semibold">
                {loading ? "Selected lines" : commitCountLabel(commits.length)}
              </strong>
              <span className="text-fog text-[10px]">
                {historyNote(history)}
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {history.status === "error" ? (
                <p className="text-mist px-3 py-3 text-xs leading-5">
                  Commit history for this file could not be loaded.
                </p>
              ) : loading ? (
                <p className="text-mist px-3 py-3 text-xs leading-5">
                  Looking up the commits that changed these lines.
                </p>
              ) : commits.length === 0 ? (
                <p className="text-mist px-3 py-3 text-xs leading-5">
                  No commit in this pull request changed these lines.
                </p>
              ) : (
                commits.map((commit) => {
                  const labels = commitEffectLabels(commit, selection);
                  const authoredAt = new Date(commit.authoredAt);
                  const when = Number.isNaN(authoredAt.getTime())
                    ? undefined
                    : formatRelativeTime(authoredAt, now);
                  const Row = commit.url ? "a" : "div";
                  return (
                    <Row
                      key={commit.sha}
                      {...(commit.url
                        ? {
                            href: commit.url,
                            target: "_blank",
                            rel: "noreferrer",
                          }
                        : {})}
                      className="hover:bg-surface-subtle/80 grid grid-cols-[8px_minmax(0,1fr)] gap-2 border-t border-line/80 px-3 py-2.5 first:border-t-0"
                      onMouseEnter={() => onHoverCommit(commit.sha)}
                      onMouseLeave={() => onHoverCommit(undefined)}
                      onFocus={() => onHoverCommit(commit.sha)}
                      onBlur={() => onHoverCommit(undefined)}
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-2 rounded-full",
                          commitSwatch(labels),
                        )}
                      />
                      <span className="min-w-0">
                        <span className="text-fog flex items-center gap-2 font-mono text-[10px]">
                          <span className="text-mist">{commit.shortSha}</span>
                          <span className="truncate">{commit.author}</span>
                          {when ? (
                            <span className="ml-auto font-sans">{when}</span>
                          ) : null}
                        </span>
                        <span className="text-cloud mt-0.5 block text-[12.5px] leading-snug font-medium">
                          {commit.subject || "Empty commit message"}
                        </span>
                        {commit.body ? (
                          <span className="text-mist mt-0.5 block text-[11px] leading-snug">
                            {commit.body}
                          </span>
                        ) : null}
                        {labels.map((effect) => (
                          <span
                            key={effect}
                            className="text-fog mt-1 block text-[10px]"
                          >
                            {effect}
                          </span>
                        ))}
                      </span>
                    </Row>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line px-3 py-1.5">
              <span className="text-fog text-[10px]">
                Shift-click or drag line numbers to change the range.
              </span>
              <button
                type="button"
                onClick={onClear}
                className="text-cyan text-[10px] font-medium"
              >
                Clear
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
