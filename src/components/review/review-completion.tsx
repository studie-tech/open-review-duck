"use client";

import {
  ArrowRight,
  Check,
  CheckCheck,
  GitPullRequest,
  LayoutDashboard,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { ShortcutHint } from "~/components/command-center";
import { Button } from "~/components/ui/button";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";

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

/** Presents a completed review as a clear end state with useful next actions. */
export function ReviewCompletion({
  completedFiles,
  completedUnits,
  dashboardShortcut,
  dismissShortcut,
  nextReview,
  nextReviewShortcut,
  providerReview,
  queueLoading,
  onDashboard,
  onDismiss,
  onNextReview,
}: ReviewCompletionProps) {
  const { dialogRef, initialFocusRef } = useReviewDialogFocus();
  const nextReviewProgress = nextReview
    ? Math.round((nextReview.signedUnits / nextReview.totalUnits) * 100)
    : 0;

  return (
    <div className="bg-ink/90 absolute inset-0 z-30 grid place-items-center overflow-y-auto p-4 font-sans backdrop-blur-[3px] sm:p-8">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-completion-title"
        aria-describedby="review-completion-description"
        tabIndex={-1}
        className="bg-panel relative my-auto w-full max-w-3xl overflow-hidden rounded-3xl border border-line-strong shadow-[0_28px_100px_var(--app-shadow)]"
      >
        <div
          aria-hidden="true"
          className="from-lime/12 via-cyan/[.035] absolute inset-x-0 top-0 h-48 bg-gradient-to-b to-transparent"
        />
        <button
          ref={initialFocusRef}
          type="button"
          aria-label="Keep completed review open"
          title="Keep completed review open (Escape)"
          onClick={onDismiss}
          className="text-mist hover:text-cloud hover:bg-surface-subtle absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full border border-transparent transition hover:border-line"
        >
          <X className="size-4" />
        </button>

        <div className="relative px-5 pt-8 pb-5 sm:px-8 sm:pt-10">
          <div className="border-lime/25 bg-lime/10 text-lime grid size-14 place-items-center rounded-2xl border shadow-[0_10px_36px_var(--app-shadow)]">
            <CheckCheck className="size-7" strokeWidth={1.8} />
          </div>
          <p className="text-lime mt-6 flex items-center gap-2 text-[10px] font-semibold tracking-[.18em] uppercase">
            <Sparkles className="size-3.5" />
            Review finished
          </p>
          <h2
            id="review-completion-title"
            className="font-editorial mt-2 text-3xl font-medium tracking-[-.035em] text-cloud sm:text-4xl"
          >
            Review complete.
          </h2>
          <p
            id="review-completion-description"
            className="text-mist mt-3 max-w-xl text-sm leading-6"
          >
            You made it through every review unit. Your sign-offs are saved and
            this pull request is fully reviewed at its current revision.
          </p>

          <dl className="mt-7 grid grid-cols-3 overflow-hidden rounded-2xl border border-line bg-surface/55">
            <div className="border-r border-line px-3 py-4 text-center sm:px-5">
              <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                Units
              </dt>
              <dd className="mt-1 font-mono text-lg text-cloud">
                {completedUnits}
              </dd>
            </div>
            <div className="border-r border-line px-3 py-4 text-center sm:px-5">
              <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                Files
              </dt>
              <dd className="mt-1 font-mono text-lg text-cloud">
                {completedFiles}
              </dd>
            </div>
            <div className="px-3 py-4 text-center sm:px-5">
              <dt className="text-fog text-[9px] tracking-[.14em] uppercase">
                Progress
              </dt>
              <dd className="text-lime mt-1 font-mono text-lg">100%</dd>
            </div>
          </dl>
        </div>

        <div className="relative border-t border-line bg-surface/35 px-5 py-5 sm:px-8 sm:py-6">
          <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1.45fr)_minmax(14rem,.75fr)]">
            {providerReview}

            {nextReview ? (
              <div>
                <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
                  Ready next
                </p>
                <button
                  type="button"
                  onClick={onNextReview}
                  className="hover:border-cyan/25 hover:bg-cyan/[.035] mt-2 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel/70 p-4 text-left transition"
                >
                  <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
                    <GitPullRequest className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-cloud">
                      {nextReview.title}
                    </span>
                    <span className="text-fog mt-1 block truncate text-[10px]">
                      {nextReview.repositoryOwner}/{nextReview.repositoryName} #
                      {nextReview.number} · {nextReview.signedUnits}/
                      {nextReview.totalUnits} reviewed
                    </span>
                    <span className="bg-surface-subtle mt-2 block h-1 overflow-hidden rounded-full">
                      <span
                        className="bg-cyan block h-full rounded-full"
                        style={{ width: `${nextReviewProgress}%` }}
                      />
                    </span>
                  </span>
                  <ArrowRight className="text-mist size-4 shrink-0" />
                </button>
              </div>
            ) : queueLoading ? (
              <div
                role="status"
                className="text-mist flex h-full min-h-[74px] items-center justify-center rounded-2xl border border-dashed border-line px-4 text-center text-xs"
              >
                Checking your review queue…
              </div>
            ) : (
              <div className="flex h-full min-h-[74px] items-center gap-3 rounded-2xl border border-lime/15 bg-lime/[.035] p-4">
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

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="ghost"
              className="sm:mr-auto"
              onClick={onDismiss}
            >
              Keep review open
              <ShortcutHint shortcut={dismissShortcut} />
            </Button>
            <Button type="button" variant="secondary" onClick={onDashboard}>
              <LayoutDashboard className="size-4" />
              Dashboard
              <ShortcutHint
                shortcut={dashboardShortcut}
                className="hidden sm:inline-flex"
              />
            </Button>
            {nextReview && (
              <Button type="button" onClick={onNextReview}>
                Review next PR
                <ArrowRight className="size-4" />
                <ShortcutHint
                  shortcut={nextReviewShortcut}
                  className="hidden sm:inline-flex"
                />
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
