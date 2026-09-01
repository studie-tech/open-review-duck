"use client";

import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  MessageSquareText,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import {
  type ReviewCompletionCandidate,
  useReviewDialogFocus,
} from "./review-completion";
import { ReviewExitActions } from "./review-exit-actions";

export interface WaitingReviewUnit {
  answered: boolean;
  commentCount: number;
  conceptTitle?: string;
  id: string;
  latestComment?: {
    author: string;
    body: string;
  };
  path: string;
  threadCount: number;
  title: string;
  waitingSince: Date | null;
}

interface ReviewWaitingCompletionProps {
  dashboardShortcut: KeyboardShortcut;
  dismissShortcut: KeyboardShortcut;
  nextReview?: ReviewCompletionCandidate;
  nextReviewShortcut: KeyboardShortcut;
  providerName: string;
  queueLoading: boolean;
  reviewedConcepts: number;
  totalConcepts: number;
  units: WaitingReviewUnit[];
  onDashboard: () => void;
  onDismiss: () => void;
  onNextReview: () => void;
  onOpenUnit: (unitId: string) => void;
  onStopWaiting: (unitId: string) => void;
}

/** Narrows a large waiting room by its unit, file, concept, or conversation. */
export function filterWaitingReviewUnits(
  units: WaitingReviewUnit[],
  search: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return units;
  return units.filter((unit) =>
    [
      unit.title,
      unit.path,
      unit.conceptTitle ?? "",
      unit.latestComment?.author ?? "",
      unit.latestComment?.body ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

/** Orders answered units first, then the unit paused the longest. */
export function orderWaitingReviewUnits(units: WaitingReviewUnit[]) {
  return [...units].sort((left, right) => {
    const leftTime = left.waitingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.waitingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return (
      Number(right.answered) - Number(left.answered) ||
      leftTime - rightTime ||
      left.title.localeCompare(right.title)
    );
  });
}

let waitFormatter: Intl.DateTimeFormat | undefined;

/** Formats a wait start while allowing the browser to use the reviewer's locale. */
function waitingTimestamp(value: Date | null) {
  if (!value) return "Waiting for provider activity";
  waitFormatter ??= new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Waiting since ${waitFormatter.format(value)}`;
}

/** Shows the distinct end state where all available work is done but waits remain. */
export function ReviewWaitingCompletion({
  dashboardShortcut,
  dismissShortcut,
  nextReview,
  nextReviewShortcut,
  providerName,
  queueLoading,
  reviewedConcepts,
  totalConcepts,
  units,
  onDashboard,
  onDismiss,
  onNextReview,
  onOpenUnit,
  onStopWaiting,
}: ReviewWaitingCompletionProps) {
  const { dialogRef, initialFocusRef } = useReviewDialogFocus();
  const [waitingRoomOpen, setWaitingRoomOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ordered = useMemo(() => orderWaitingReviewUnits(units), [units]);
  const filtered = useMemo(
    () => filterWaitingReviewUnits(ordered, search),
    [ordered, search],
  );
  const oldest = ordered[0];
  const waitingLabel = `${units.length} ${units.length === 1 ? "unit" : "units"}`;
  const answeredCount = units.filter(({ answered }) => answered).length;

  return (
    <div className="bg-ink/90 absolute inset-0 z-30 grid place-items-center overflow-y-auto p-4 font-sans backdrop-blur-[3px] sm:p-8">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-waiting-title"
        aria-describedby="review-waiting-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
        className="bg-panel relative my-auto flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-line-strong shadow-[0_28px_100px_var(--app-shadow)]"
      >
        <div
          aria-hidden="true"
          className="from-cyan/10 via-cyan/[.025] absolute inset-x-0 top-0 h-48 bg-gradient-to-b to-transparent"
        />
        <button
          ref={initialFocusRef}
          type="button"
          aria-label="Close waiting dialog and keep review open"
          title="Keep review open (Escape)"
          onClick={onDismiss}
          className="text-mist hover:text-cloud hover:bg-surface-subtle absolute top-4 right-4 z-20 grid size-9 place-items-center rounded-full border border-transparent transition hover:border-line"
        >
          <X className="size-4" />
        </button>

        {waitingRoomOpen ? (
          <>
            <header className="relative shrink-0 border-b border-line px-5 pt-7 pb-5 sm:px-8">
              <button
                type="button"
                onClick={() => {
                  setWaitingRoomOpen(false);
                  setSearch("");
                }}
                className="text-mist hover:text-cloud mb-5 flex items-center gap-1.5 text-[10px] transition"
              >
                <ArrowLeft className="size-3.5" />
                Back to summary
              </button>
              <p className="text-cyan text-[10px] font-semibold tracking-[.18em] uppercase">
                Waiting room
              </p>
              <h2
                id="review-waiting-title"
                className="font-editorial mt-2 pr-10 text-3xl font-medium tracking-[-.035em] text-cloud"
              >
                {waitingLabel} waiting for response
              </h2>
              <p
                id="review-waiting-description"
                className="text-mist mt-2 max-w-2xl text-sm leading-6"
              >
                These units return to the review path automatically when their{" "}
                {providerName} conversations or code change.
              </p>
              <label className="border-line-strong bg-surface mt-5 flex h-10 items-center gap-2 rounded-xl border px-3">
                <Search className="text-fog size-3.5" aria-hidden="true" />
                <span className="sr-only">Find a waiting unit</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find a unit, file, or conversation…"
                  className="text-cloud placeholder:text-fog min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
                {search.trim() && (
                  <span className="text-fog text-[9px]">
                    {filtered.length}/{units.length}
                  </span>
                )}
              </label>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
              {filtered.length > 0 ? (
                <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface/35">
                  {filtered.map((unit) => (
                    <article
                      key={unit.id}
                      className="hover:bg-surface-hover/45 px-4 py-4 transition sm:px-5"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                        <button
                          type="button"
                          onClick={() => onOpenUnit(unit.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-2">
                            {unit.answered ? (
                              <MessageSquareText className="text-lime size-3.5 shrink-0" />
                            ) : (
                              <Clock3 className="text-cyan size-3.5 shrink-0" />
                            )}
                            <span className="truncate text-sm font-medium text-cloud">
                              {unit.title}
                            </span>
                            {unit.answered && (
                              <span className="border-lime/25 bg-lime/10 text-lime shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold tracking-wider uppercase">
                                Response received
                              </span>
                            )}
                          </span>
                          <span className="text-fog mt-1.5 block truncate pl-5.5 font-mono text-[9px]">
                            {unit.path}
                            {unit.conceptTitle ? ` · ${unit.conceptTitle}` : ""}
                          </span>
                          <span className="text-mist mt-1 block pl-5.5 text-[9px]">
                            <time
                              dateTime={
                                unit.waitingSince?.toISOString() ?? undefined
                              }
                              suppressHydrationWarning
                            >
                              {waitingTimestamp(unit.waitingSince)}
                            </time>
                            {unit.threadCount > 0 && (
                              <>
                                {" "}
                                · {unit.threadCount}{" "}
                                {unit.threadCount === 1
                                  ? "conversation"
                                  : "conversations"}
                              </>
                            )}
                            {unit.commentCount > 0 && (
                              <>
                                {" "}
                                · {unit.commentCount}{" "}
                                {unit.commentCount === 1
                                  ? "comment"
                                  : "comments"}
                              </>
                            )}
                          </span>
                          {unit.latestComment && (
                            <span className="border-cyan/25 text-mist mt-2 block line-clamp-2 border-l-2 pl-3 text-[10px] leading-4">
                              <span className="text-cloud font-medium">
                                {unit.latestComment.author}:
                              </span>{" "}
                              {unit.latestComment.body}
                            </span>
                          )}
                        </button>
                        <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onOpenUnit(unit.id)}
                          >
                            Open
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={unit.answered ? "primary" : "secondary"}
                            onClick={() => onStopWaiting(unit.id)}
                          >
                            {unit.answered ? (
                              <MessageSquareText className="size-3.5" />
                            ) : (
                              <Clock3 className="size-3.5" />
                            )}
                            {unit.answered ? "Resume review" : "Stop waiting"}
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="text-mist grid min-h-40 place-items-center rounded-2xl border border-dashed border-line px-5 text-center text-xs">
                  No waiting units match “{search.trim()}”.
                </div>
              )}
            </div>

            <footer className="relative shrink-0 border-t border-line bg-surface/35 px-5 py-4 sm:px-8">
              <ReviewExitActions
                dashboardShortcut={dashboardShortcut}
                dismissLabel="Keep review open"
                dismissShortcut={dismissShortcut}
                nextReviewShortcut={nextReviewShortcut}
                onDashboard={onDashboard}
                onDismiss={onDismiss}
                onNextReview={nextReview ? onNextReview : undefined}
              />
            </footer>
          </>
        ) : (
          <>
            <div className="relative px-5 pt-8 pb-5 sm:px-8 sm:pt-10">
              <div className="border-cyan/25 bg-cyan/10 text-cyan grid size-14 place-items-center rounded-2xl border shadow-[0_10px_36px_var(--app-shadow)]">
                <Clock3 className="size-7" strokeWidth={1.8} />
              </div>
              <p className="text-cyan mt-6 text-[10px] font-semibold tracking-[.18em] uppercase">
                Review pass complete
              </p>
              <h2
                id="review-waiting-title"
                className="font-editorial mt-2 text-3xl font-medium tracking-[-.035em] text-cloud sm:text-4xl"
              >
                You’re caught up.
              </h2>
              <p
                id="review-waiting-description"
                className="text-mist mt-3 max-w-2xl text-sm leading-6"
              >
                You reviewed {reviewedConcepts} of {totalConcepts} concepts.{" "}
                {answeredCount > 0
                  ? `${answeredCount} of the ${waitingLabel} you were waiting on ${
                      answeredCount === 1 ? "has" : "have"
                    } a response ready to review; the rest return automatically when their ${providerName} conversations or code change.`
                  : `The remaining ${waitingLabel} will return automatically when their ${providerName} conversations or code change.`}
              </p>

              <dl className="mt-7 grid grid-cols-3 overflow-hidden rounded-2xl border border-line bg-surface/55">
                <div className="border-r border-line px-3 py-4 text-center sm:px-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Reviewed
                  </dt>
                  <dd className="mt-1 font-mono text-lg text-cloud">
                    {reviewedConcepts}
                  </dd>
                </div>
                <div className="border-r border-line px-3 py-4 text-center sm:px-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Waiting
                  </dt>
                  <dd className="text-cyan mt-1 font-mono text-lg">
                    {units.length}
                  </dd>
                </div>
                <div className="px-3 py-4 text-center sm:px-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Ready now
                  </dt>
                  <dd
                    className={`mt-1 font-mono text-lg ${
                      answeredCount > 0 ? "text-lime" : "text-cloud"
                    }`}
                  >
                    {answeredCount}
                  </dd>
                </div>
              </dl>

              <button
                type="button"
                onClick={() => setWaitingRoomOpen(true)}
                className="hover:border-cyan/25 hover:bg-cyan/[.035] mt-5 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel/70 p-4 text-left transition"
              >
                <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
                  <Clock3 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-cloud">
                    View {waitingLabel}
                  </span>
                  <span className="text-mist mt-1 block truncate text-[10px]">
                    {answeredCount > 0
                      ? `${answeredCount} ${answeredCount === 1 ? "response is" : "responses are"} ready to review`
                      : oldest
                        ? `${oldest.title} has been waiting longest`
                        : "See what this review is waiting on"}
                  </span>
                </span>
                <ArrowRight className="text-cyan size-4 shrink-0" />
              </button>
            </div>

            <footer className="relative border-t border-line bg-surface/35 px-5 py-5 sm:px-8">
              <ReviewExitActions
                dashboardShortcut={dashboardShortcut}
                dismissLabel="Keep review open"
                dismissShortcut={dismissShortcut}
                nextReviewShortcut={nextReviewShortcut}
                onDashboard={onDashboard}
                onDismiss={onDismiss}
                onNextReview={nextReview ? onNextReview : undefined}
                queueLoading={queueLoading}
              />
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
