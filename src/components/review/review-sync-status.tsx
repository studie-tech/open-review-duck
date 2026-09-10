"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { formatShortcut } from "~/lib/keyboard-shortcuts";
import { providerLabel } from "~/lib/provider-labels";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { cn } from "~/lib/utils";

/** How often the workspace asks the provider whether the pull-request head moved. */
export const REVIEW_REVISION_PROBE_MS = 20_000;

export type ReviewSyncStatus =
  | "error"
  | "idle"
  | "loading"
  | "ready"
  | "syncing";

/**
 * Chooses the header sync-status the reviewer should see.
 *
 * Loading and syncing outrank a ready revision so an in-flight fetch is
 * never mistaken for a clickable "load" state. Background probes stay
 * idle: flashing a spinner every twenty seconds would be noise.
 */
export function reviewSyncStatus(input: {
  loadingChanges: boolean;
  probeFailed: boolean;
  syncing: boolean;
  updateAvailable: boolean;
}): ReviewSyncStatus {
  if (input.loadingChanges) return "loading";
  if (input.syncing) return "syncing";
  if (input.updateAvailable) return "ready";
  if (input.probeFailed) return "error";
  return "idle";
}

/**
 * Reports whether a stale probe should queue a background sync.
 *
 * One remote revision is queued at most once. A later head, or a manual
 * retry after failure, can queue again.
 */
export function shouldAutoSyncReviewRevision(input: {
  attemptedHeadSha?: string;
  busy: boolean;
  current: boolean;
  remoteHeadSha?: string;
}) {
  if (input.busy || input.current || !input.remoteHeadSha) return false;
  return input.attemptedHeadSha !== input.remoteHeadSha;
}

/** Names the current sync-status for assistive text and the command palette. */
export function reviewSyncStatusLabel(status: ReviewSyncStatus) {
  switch (status) {
    case "loading":
      return "Loading new revision";
    case "syncing":
      return "Syncing new commits";
    case "ready":
      return "New revision ready";
    case "error":
      return "Could not check for updates";
    case "idle":
      return "Pull request is up to date";
  }
}

/** Explains what the status icon will do if the reviewer activates it. */
export function reviewSyncStatusTitle(input: {
  provider: string;
  status: ReviewSyncStatus;
}) {
  const provider = providerLabel(input.provider);
  const refresh = formatShortcut(reviewShortcuts.refresh).join(" then ");
  const load = formatShortcut(reviewShortcuts.loadChanges).join(" then ");
  switch (input.status) {
    case "loading":
      return "Loading the new review revision";
    case "syncing":
      return `Syncing the latest ${provider} commits`;
    case "ready":
      return `Load the synced code changes (${load})`;
    case "error":
      return `Could not reach ${provider}. Click to try again (${refresh})`;
    case "idle":
      return `${provider} is watched for new commits. Click to check now (${refresh})`;
  }
}

/** Icon-only pull-request sync control that reports background work. */
export function ReviewSyncStatusButton({
  onClick,
  provider,
  status,
}: {
  onClick: () => void;
  provider: string;
  status: ReviewSyncStatus;
}) {
  const label = reviewSyncStatusLabel(status);
  const busy = status === "syncing" || status === "loading";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={label}
      title={reviewSyncStatusTitle({ provider, status })}
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-full transition",
        status === "ready"
          ? "text-cyan hover:bg-cyan/10"
          : status === "error"
            ? "text-coral hover:bg-coral/10"
            : "text-mist hover:text-cloud hover:bg-surface-subtle",
        busy && "cursor-wait",
      )}
    >
      {busy ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      {status === "ready" && (
        <span
          aria-hidden="true"
          className="bg-cyan absolute top-1.5 right-1.5 size-1.5 rounded-full"
        />
      )}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}
