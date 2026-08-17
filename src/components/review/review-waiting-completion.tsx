"use client";

import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  LayoutDashboard,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  type ReviewCompletionCandidate,
  useReviewDialogFocus,
} from "./review-completion";

export interface WaitingReviewConcept {
  commentCount: number;
  id: string;
  latestComment?: {
    author: string;
    body: string;
  };
  paths: string[];
  threadCount: number;
  title: string;
  unitIds: string[];
  waitingSince: Date | null;
}

interface ReviewWaitingCompletionProps {
  concepts: WaitingReviewConcept[];
  nextReview?: ReviewCompletionCandidate;
  providerName: string;
  queueLoading: boolean;
  releasingConceptId?: string;
  reviewedConcepts: number;
  totalConcepts: number;
  onDashboard: () => void;
  onDismiss: () => void;
  onNextReview: () => void;
  onOpenConcept: (conceptId: string) => void;
  onStopWaiting: (conceptId: string) => void;
}

/** Narrows a large waiting room by its concept, files, or latest conversation. */
export function filterWaitingReviewConcepts(
  concepts: WaitingReviewConcept[],
  search: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return concepts;
  return concepts.filter((concept) =>
    [
      concept.title,
      ...concept.paths,
      concept.latestComment?.author ?? "",
      concept.latestComment?.body ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

/** Orders long waiting sets by the concept that has been paused the longest. */
export function orderWaitingReviewConcepts(concepts: WaitingReviewConcept[]) {
  return [...concepts].sort((left, right) => {
    const leftTime = left.waitingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.waitingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime || left.title.localeCompare(right.title);
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
  concepts,
  nextReview,
  providerName,
  queueLoading,
  releasingConceptId,
  reviewedConcepts,
  totalConcepts,
  onDashboard,
  onDismiss,
  onNextReview,
  onOpenConcept,
  onStopWaiting,
}: ReviewWaitingCompletionProps) {
  const { dialogRef, initialFocusRef } = useReviewDialogFocus();
  const [waitingRoomOpen, setWaitingRoomOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ordered = useMemo(
    () => orderWaitingReviewConcepts(concepts),
    [concepts],
  );
  const filtered = useMemo(
    () => filterWaitingReviewConcepts(ordered, search),
    [ordered, search],
  );
  const oldest = ordered[0];
  const waitingLabel = `${concepts.length} ${concepts.length === 1 ? "concept" : "concepts"}`;

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
                These concepts return to the review path automatically when
                their {providerName} conversations or code change.
              </p>
              <label className="border-line-strong bg-surface mt-5 flex h-10 items-center gap-2 rounded-xl border px-3">
                <Search className="text-fog size-3.5" aria-hidden="true" />
                <span className="sr-only">Find a waiting concept</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find a concept, file, or conversation…"
                  className="text-cloud placeholder:text-fog min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
                {search.trim() && (
                  <span className="text-fog text-[9px]">
                    {filtered.length}/{concepts.length}
                  </span>
                )}
              </label>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
              {filtered.length > 0 ? (
                <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface/35">
                  {filtered.map((concept) => (
                    <article
                      key={concept.id}
                      className="hover:bg-surface-hover/45 px-4 py-4 transition sm:px-5"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                        <button
                          type="button"
                          onClick={() => onOpenConcept(concept.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-2">
                            <Clock3 className="text-cyan size-3.5 shrink-0" />
                            <span className="truncate text-sm font-medium text-cloud">
                              {concept.title}
                            </span>
                          </span>
                          <span className="text-fog mt-1.5 block truncate pl-5.5 font-mono text-[9px]">
                            {concept.paths.join(" · ")}
                          </span>
                          <span className="text-mist mt-1 block pl-5.5 text-[9px]">
                            <time
                              dateTime={
                                concept.waitingSince?.toISOString() ?? undefined
                              }
                              suppressHydrationWarning
                            >
                              {waitingTimestamp(concept.waitingSince)}
                            </time>
                            {concept.threadCount > 0 && (
                              <>
                                {" "}
                                · {concept.threadCount}{" "}
                                {concept.threadCount === 1
                                  ? "conversation"
                                  : "conversations"}
                              </>
                            )}
                            {concept.commentCount > 0 && (
                              <>
                                {" "}
                                · {concept.commentCount}{" "}
                                {concept.commentCount === 1
                                  ? "comment"
                                  : "comments"}
                              </>
                            )}
                          </span>
                          {concept.latestComment && (
                            <span className="border-cyan/25 text-mist mt-2 block line-clamp-2 border-l-2 pl-3 text-[10px] leading-4">
                              <span className="text-cloud font-medium">
                                {concept.latestComment.author}:
                              </span>{" "}
                              {concept.latestComment.body}
                            </span>
                          )}
                        </button>
                        <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onOpenConcept(concept.id)}
                          >
                            Open
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={Boolean(releasingConceptId)}
                            onClick={() => onStopWaiting(concept.id)}
                          >
                            {releasingConceptId === concept.id ? (
                              <LoaderCircle className="size-3.5 animate-spin" />
                            ) : (
                              <Clock3 className="size-3.5" />
                            )}
                            {releasingConceptId === concept.id
                              ? "Resuming…"
                              : "Stop waiting"}
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="text-mist grid min-h-40 place-items-center rounded-2xl border border-dashed border-line px-5 text-center text-xs">
                  No waiting concepts match “{search.trim()}”.
                </div>
              )}
            </div>

            <footer className="relative flex shrink-0 flex-col-reverse gap-2 border-t border-line bg-surface/35 px-5 py-4 sm:flex-row sm:items-center sm:px-8">
              <Button type="button" variant="ghost" onClick={onDismiss}>
                Keep review open
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="sm:ml-auto"
                onClick={onDashboard}
              >
                <LayoutDashboard className="size-4" />
                Dashboard
              </Button>
              {nextReview && (
                <Button type="button" onClick={onNextReview}>
                  Review next PR
                  <ArrowRight className="size-4" />
                </Button>
              )}
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
                You reviewed {reviewedConcepts} of {totalConcepts} concepts. The
                remaining {waitingLabel} will return automatically when their{" "}
                {providerName} conversations or code change.
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
                    {concepts.length}
                  </dd>
                </div>
                <div className="px-3 py-4 text-center sm:px-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Ready now
                  </dt>
                  <dd className="mt-1 font-mono text-lg text-cloud">0</dd>
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
                    {oldest
                      ? `${oldest.title} has been waiting longest`
                      : "See what this review is waiting on"}
                  </span>
                </span>
                <ArrowRight className="text-cyan size-4 shrink-0" />
              </button>
            </div>

            <footer className="relative flex flex-col-reverse gap-2 border-t border-line bg-surface/35 px-5 py-5 sm:flex-row sm:items-center sm:px-8">
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={onDismiss}
              >
                Keep review open
              </Button>
              <Button type="button" variant="secondary" onClick={onDashboard}>
                <LayoutDashboard className="size-4" />
                Dashboard
              </Button>
              {nextReview ? (
                <Button type="button" onClick={onNextReview}>
                  Review next PR
                  <ArrowRight className="size-4" />
                </Button>
              ) : queueLoading ? (
                <Button type="button" disabled>
                  <LoaderCircle className="size-4 animate-spin" />
                  Checking review queue…
                </Button>
              ) : null}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
