"use client";

import {
  ArrowRight,
  Check,
  CheckCheck,
  GitPullRequest,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { usePendingNavigation } from "~/components/navigation-progress";
import { Spinner } from "~/components/ui/spinner";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import { ReviewExitActions } from "./review-exit-actions";

export interface ReviewCompletionCandidate {
  id: string;
  number: number;
  repositoryName: string;
  repositoryOwner: string;
  signedUnits: number;
  queueState?: "active" | "removed";
  state?: "open" | "draft" | "merged" | "closed";
  title: string;
  totalUnits: number;
}

interface ReviewCompletionProps {
  completedFiles: number;
  completedUnits: number;
  dashboardShortcut: KeyboardShortcut;
  dismissShortcut: KeyboardShortcut;
  nextReview?: ReviewCompletionCandidate;
  nextReviewShortcut: KeyboardShortcut;
  lifecycle?: ReactNode;
  providerReview: ReactNode;
  queueLoading: boolean;
  onDashboard: () => void;
  onDismiss: () => void;
  onNextReview: () => void;
}

const reviewDialogFocusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** Returns controls that can participate in a completion dialog's tab order. */
function reviewDialogControls(dialog: HTMLElement) {
  return [
    ...dialog.querySelectorAll<HTMLElement>(reviewDialogFocusableSelector),
  ];
}

/** Keeps focus inside a review completion overlay and restores it on close. */
export function useReviewDialogFocus() {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mountedDialog = dialogRef.current;
    if (!mountedDialog) return;
    const dialog: HTMLElement = mountedDialog;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;

    /** Focuses the preferred dismiss action, falling back inside the dialog. */
    function focusInitialControl() {
      const target =
        initialFocusRef.current ?? reviewDialogControls(dialog)[0] ?? dialog;
      target.focus();
    }

    /** Wraps Tab and Shift+Tab at the dialog boundaries. */
    function trapTab(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const controls = reviewDialogControls(dialog);
      const first = controls[0] ?? dialog;
      const last = controls.at(-1) ?? dialog;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    }

    /** Redirects programmatic or pointer focus that lands behind the overlay. */
    function containFocus(event: FocusEvent) {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        focusInitialControl();
      }
    }

    document.addEventListener("keydown", trapTab, true);
    document.addEventListener("focusin", containFocus, true);
    focusInitialControl();

    return () => {
      document.removeEventListener("keydown", trapTab, true);
      document.removeEventListener("focusin", containFocus, true);
      previousFocus?.focus();
    };
  }, []);

  return { dialogRef, initialFocusRef };
}

/** Selects the first ready, unfinished pull request after a review completes. */
export function findNextReview<T extends ReviewCompletionCandidate>(
  pullRequests: T[] | undefined,
  currentPullRequestId: string,
) {
  return pullRequests?.find(
    (pullRequest) =>
      pullRequest.id !== currentPullRequestId &&
      (pullRequest.queueState ?? "active") === "active" &&
      ["open", "draft"].includes(pullRequest.state ?? "open") &&
      pullRequest.totalUnits > 0 &&
      pullRequest.signedUnits < pullRequest.totalUnits,
  );
}

/** Presents a completed review as a full-pane workspace page with useful next actions. */
export function ReviewCompletion({
  completedFiles,
  completedUnits,
  dashboardShortcut,
  dismissShortcut,
  nextReview,
  nextReviewShortcut,
  lifecycle,
  providerReview,
  queueLoading,
  onDashboard,
  onDismiss,
  onNextReview,
}: ReviewCompletionProps) {
  const { dialogRef, initialFocusRef } = useReviewDialogFocus();
  const { pending: navigationPending } = usePendingNavigation();
  const nextReviewProgress = nextReview
    ? Math.round((nextReview.signedUnits / nextReview.totalUnits) * 100)
    : 0;

  return (
    <div className="bg-code absolute inset-0 z-30 flex min-h-0 flex-col font-sans">
      <section
        ref={dialogRef}
        aria-labelledby="review-completion-title"
        aria-describedby="review-completion-description"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="from-lime/10 via-code to-code pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b" />
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="w-full px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
            <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0 max-w-2xl">
                <span className="border-lime/25 bg-lime/10 text-lime grid size-12 place-items-center rounded-2xl border shadow-[0_10px_36px_var(--app-shadow)] sm:size-14">
                  <CheckCheck className="size-6 sm:size-7" strokeWidth={1.8} />
                </span>

                <p className="text-lime mt-5 flex items-center gap-2 text-[10px] font-semibold tracking-[.18em] uppercase sm:mt-6">
                  <Sparkles className="size-3.5" />
                  Review finished
                </p>
                <h2
                  id="review-completion-title"
                  className="font-editorial mt-2 text-3xl font-medium tracking-[-.035em] text-cloud sm:text-4xl lg:text-5xl"
                >
                  Review complete.
                </h2>
                <p
                  id="review-completion-description"
                  className="text-mist mt-3 text-sm leading-6"
                >
                  You made it through every review unit. Your sign-offs are
                  saved and this pull request is fully reviewed at its current
                  revision. Check the pipelines, merge when they are ready, or
                  continue to the next pull request.
                </p>
              </div>

              <dl className="grid w-full grid-cols-3 gap-2 sm:gap-3 xl:w-[min(100%,32rem)] xl:shrink-0">
                <div className="rounded-2xl border border-line bg-surface/55 px-3 py-4 text-center sm:px-5 sm:py-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Units
                  </dt>
                  <dd className="mt-1 font-mono text-lg text-cloud sm:text-xl">
                    {completedUnits}
                  </dd>
                </div>
                <div className="rounded-2xl border border-line bg-surface/55 px-3 py-4 text-center sm:px-5 sm:py-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Files
                  </dt>
                  <dd className="mt-1 font-mono text-lg text-cloud sm:text-xl">
                    {completedFiles}
                  </dd>
                </div>
                <div className="rounded-2xl border border-lime/20 bg-lime/[.06] px-3 py-4 text-center sm:px-5 sm:py-5">
                  <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                    Progress
                  </dt>
                  <dd className="text-lime mt-1 font-mono text-lg sm:text-xl">
                    100%
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,24rem)] lg:items-start xl:mt-10 xl:gap-6">
              {lifecycle}
              <div className="space-y-4">
                {providerReview}

                {nextReview ? (
                  <div>
                    <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
                      Ready next
                    </p>
                    <button
                      type="button"
                      disabled={navigationPending}
                      aria-busy={navigationPending || undefined}
                      onClick={onNextReview}
                      className="hover:border-cyan/25 hover:bg-cyan/[.035] mt-2 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel/70 p-4 text-left transition disabled:pointer-events-none"
                    >
                      <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
                        <GitPullRequest className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-cloud">
                          {nextReview.title}
                        </span>
                        <span className="text-fog mt-1 block truncate text-[10px]">
                          {nextReview.repositoryOwner}/
                          {nextReview.repositoryName} #{nextReview.number} ·{" "}
                          {nextReview.signedUnits}/{nextReview.totalUnits}{" "}
                          reviewed
                        </span>
                        <span className="bg-surface-subtle mt-2 block h-1 overflow-hidden rounded-full">
                          <span
                            className="bg-cyan block h-full rounded-full"
                            style={{ width: `${nextReviewProgress}%` }}
                          />
                        </span>
                      </span>
                      {navigationPending ? (
                        <Spinner className="text-mist size-4 shrink-0" />
                      ) : (
                        <ArrowRight className="text-mist size-4 shrink-0" />
                      )}
                    </button>
                  </div>
                ) : queueLoading ? (
                  <div
                    role="status"
                    className="text-mist flex min-h-[74px] items-center justify-center rounded-2xl border border-dashed border-line px-4 text-center text-xs"
                  >
                    Checking your review queue…
                  </div>
                ) : (
                  <div className="flex min-h-[74px] items-center gap-3 rounded-2xl border border-lime/15 bg-lime/[.035] p-4">
                    <span className="bg-lime/10 text-lime grid size-10 shrink-0 place-items-center rounded-xl">
                      <Check className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-cloud">
                        Your review queue is clear
                      </span>
                      <span className="text-mist mt-1 block text-[10px] leading-4">
                        There are no other prepared pull requests waiting for
                        review.
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="relative shrink-0 border-t border-line bg-panel/90 px-4 py-3 backdrop-blur-sm sm:px-6 sm:py-4 lg:px-8">
          <ReviewExitActions
            dashboardShortcut={dashboardShortcut}
            dismissButtonRef={initialFocusRef}
            dismissLabel="Browse reviewed files"
            dismissShortcut={dismissShortcut}
            nextReviewShortcut={nextReviewShortcut}
            onDashboard={onDashboard}
            onDismiss={onDismiss}
            onNextReview={nextReview ? onNextReview : undefined}
          />
        </div>
      </section>
    </div>
  );
}
