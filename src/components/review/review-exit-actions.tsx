"use client";

import { ArrowRight, GitPullRequest, LoaderCircle } from "lucide-react";
import type { Ref } from "react";
import { ShortcutHint } from "~/components/command-center";
import { usePendingNavigation } from "~/components/navigation-progress";
import { Button } from "~/components/ui/button";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";

interface ReviewExitActionsProps {
  dashboardShortcut: KeyboardShortcut;
  dismissButtonRef?: Ref<HTMLButtonElement>;
  dismissLabel: string;
  dismissShortcut: KeyboardShortcut;
  nextReviewShortcut: KeyboardShortcut;
  onDashboard: () => void;
  onDismiss: () => void;
  onNextReview?: () => void;
  queueLoading?: boolean;
}

/** Renders the shared navigation actions for a completed review state. */
export function ReviewExitActions({
  dashboardShortcut,
  dismissButtonRef,
  dismissLabel,
  dismissShortcut,
  nextReviewShortcut,
  onDashboard,
  onDismiss,
  onNextReview,
  queueLoading = false,
}: ReviewExitActionsProps) {
  const { pending: navigationPending } = usePendingNavigation();

  return (
    <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center">
      <Button
        ref={dismissButtonRef}
        type="button"
        variant="ghost"
        className="sm:mr-auto"
        onClick={onDismiss}
      >
        {dismissLabel}
        <ShortcutHint shortcut={dismissShortcut} />
      </Button>
      <Button
        type="button"
        variant="secondary"
        loading={navigationPending}
        onClick={onDashboard}
      >
        {!navigationPending && <GitPullRequest className="size-4" />}
        Pull requests
        <ShortcutHint
          shortcut={dashboardShortcut}
          className="hidden sm:inline-flex"
        />
      </Button>
      {onNextReview ? (
        <Button
          type="button"
          loading={navigationPending}
          onClick={onNextReview}
        >
          Review next PR
          {!navigationPending && <ArrowRight className="size-4" />}
          <ShortcutHint
            shortcut={nextReviewShortcut}
            className="hidden sm:inline-flex"
          />
        </Button>
      ) : queueLoading ? (
        <Button type="button" disabled>
          <LoaderCircle className="size-4 animate-spin" />
          Checking review queue…
        </Button>
      ) : null}
    </div>
  );
}
