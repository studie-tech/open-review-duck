"use client";

import { CircleAlert, GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { SyncProgressMeter } from "~/components/review/sync-progress-meter";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import { providerLabel } from "~/lib/provider-labels";
import { syncProgressLabel } from "~/lib/sync-progress";
import type { RouterOutputs } from "~/trpc/react";

type ActiveSyncs = RouterOutputs["review"]["activeSyncs"];
type FailedSyncs = RouterOutputs["review"]["recentSyncFailures"];

/** Renders preparation progress and failures as first-class inbox entries. */
export function ReviewPreparationList({
  failedSyncs,
  onRetry,
  retryingKey,
  synchronizing,
}: {
  failedSyncs: FailedSyncs;
  onRetry: (sync: FailedSyncs[number]) => void;
  retryingKey?: string;
  synchronizing: ActiveSyncs;
}) {
  if (failedSyncs.length + synchronizing.length === 0) return null;

  return (
    <section
      aria-label="Review preparation status"
      aria-live="polite"
      className="overflow-hidden rounded-2xl border border-line"
    >
      {failedSyncs.length > 0 && (
        <PreparationGroupHeading
          count={failedSyncs.length}
          description="Fix the connection or retry the preparation"
          label="Preparation needs attention"
          tone="failure"
        />
      )}
      {failedSyncs.map((sync) => {
        const key = `${sync.repositoryId}:${sync.pullRequestNumber}`;
        const retrying = retryingKey === key;
        return (
          <article
            key={sync.id}
            className="border-coral/15 bg-coral/[.035] flex border-b border-line last:border-b-0"
          >
            <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 p-4 sm:flex sm:gap-4 sm:p-5">
              <span className="text-coral bg-coral/10 grid size-9 shrink-0 place-items-center rounded-xl sm:size-10">
                <CircleAlert className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <PreparationIdentity sync={sync} />
                <p className="mt-1.5 text-sm leading-5 font-medium">
                  {sync.title ?? `Pull request #${sync.pullRequestNumber}`}
                </p>
                <p className="text-mist mt-1 text-[11px] leading-5">
                  Failed at {sync.progress}% while{" "}
                  {syncProgressLabel("running", sync.progress).toLowerCase()}.{" "}
                  {sync.message}{" "}
                  <Link
                    href="/settings/providers"
                    className="text-coral inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    Review connection
                    <LinkPendingSpinner className="size-3" />
                  </Link>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-start border-l border-line px-2 pt-4 sm:items-center sm:px-3 sm:pt-0">
              <Button
                aria-label="Retry"
                size="sm"
                variant="secondary"
                disabled={retrying}
                onClick={() => onRetry(sync)}
              >
                <RefreshCw
                  className={retrying ? "size-3.5 animate-spin" : "size-3.5"}
                />
                <span className="hidden sm:inline">Retry</span>
                <span className="sr-only sm:hidden">Retry</span>
              </Button>
            </div>
          </article>
        );
      })}

      {synchronizing.length > 0 && (
        <PreparationGroupHeading
          count={synchronizing.length}
          description="Reviews appear here automatically when ready"
          label="Preparing for review"
          tone="progress"
        />
      )}
      {synchronizing.map((sync) => (
        <article
          key={sync.id}
          className="bg-surface/70 flex border-b border-line last:border-b-0"
        >
          <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 p-4 sm:flex sm:items-center sm:gap-4 sm:p-5">
            <span className="text-cyan bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl sm:size-10">
              {sync.status === "queued" ? (
                <GitPullRequest className="size-4" />
              ) : (
                <Loader2 className="size-4 animate-spin" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <PreparationIdentity sync={sync} />
              <p className="mt-1.5 truncate text-sm leading-5 font-medium">
                {sync.title ?? `Pull request #${sync.pullRequestNumber}`}
              </p>
            </div>
            <div className="col-start-2 min-w-0 sm:ml-auto sm:w-72 sm:shrink-0">
              <SyncProgressMeter
                label={`${sync.repositoryOwner}/${sync.repositoryName} #${sync.pullRequestNumber} synchronization progress`}
                progress={sync.progress}
                status={sync.status}
              />
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

/** Renders the familiar provider and repository identity for a status row. */
function PreparationIdentity({
  sync,
}: {
  sync: ActiveSyncs[number] | FailedSyncs[number];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge>{providerLabel(sync.provider)}</Badge>
      <span className="text-fog truncate text-xs">
        {sync.repositoryOwner}/{sync.repositoryName} #{sync.pullRequestNumber}
      </span>
    </div>
  );
}

/** Labels one preparation state using the inbox's existing group anatomy. */
function PreparationGroupHeading({
  count,
  description,
  label,
  tone,
}: {
  count: number;
  description: string;
  label: string;
  tone: "failure" | "progress";
}) {
  return (
    <div className="bg-surface-subtle/65 flex items-center gap-3 border-b border-line px-5 py-3">
      <span
        aria-hidden="true"
        className={
          tone === "failure"
            ? "bg-coral size-1.5 rounded-full"
            : "bg-cyan size-1.5 rounded-full"
        }
      />
      <div className="min-w-0 flex-1">
        <h3 className="block text-[11px] font-semibold tracking-[.08em] uppercase">
          {label}
        </h3>
        <span className="text-fog mt-0.5 hidden text-[10px] sm:block">
          {description}
        </span>
      </div>
      <span className="text-fog text-[10px] tabular-nums">{count}</span>
    </div>
  );
}
