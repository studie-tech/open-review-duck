"use client";

import {
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  WandSparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DashboardSyncPanel } from "~/components/dashboard/dashboard-panels";
import { SyncProgressMeter } from "~/components/review/sync-progress-meter";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import { followActiveReviewJobs } from "~/lib/sync-progress";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import {
  type ImportedRepository,
  type IntakeMode,
  providerLabel,
} from "./provider-common";

const intakeOptions: Array<{
  mode: IntakeMode;
  title: string;
  description: string;
  icon: typeof GitPullRequest;
}> = [
  {
    mode: "manual",
    title: "Manual",
    description: "You choose which pull requests to prepare for review.",
    icon: GitPullRequest,
  },
  {
    mode: "assigned",
    title: "Assigned to me",
    description: "Prepare PRs where this account is a reviewer or assignee.",
    icon: Users,
  },
  {
    mode: "all",
    title: "Every open PR",
    description:
      "Prepare every new or updated pull request in this repository.",
    icon: WandSparkles,
  },
];

/** Renders the console detail pane for one imported repository. */
export function RepositoryDetail({
  intakeUpdatePending,
  onReconcile,
  onRemove,
  onRequestIntakeChange,
  reconcilePending,
  repository,
}: {
  intakeUpdatePending: boolean;
  onReconcile: () => void;
  onRemove: () => void;
  onRequestIntakeChange: (mode: IntakeMode) => void;
  reconcilePending: boolean;
  repository: ImportedRepository;
}) {
  const manual = repository.reviewIntakeMode === "manual";
  const openPullRequests = api.provider.listOpenPullRequests.useQuery(
    { repositoryId: repository.id },
    {
      enabled: manual,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const utils = api.useUtils();
  const [heldNumbers, setHeldNumbers] = useState<Set<number>>(new Set());
  const activeSyncs = api.review.activeSyncs.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: followActiveReviewJobs,
  });
  const queuedReviews = api.review.dashboard.useQuery(undefined, {
    enabled: manual,
    refetchOnWindowFocus: true,
  });
  const failedSyncs = api.review.recentSyncFailures.useQuery(undefined, {
    enabled: manual,
    refetchOnWindowFocus: true,
  });
  const hadActiveSync = useRef(false);
  const synchronizing = useMemo(
    () =>
      (activeSyncs.data ?? []).filter(
        (sync) => sync.repositoryId === repository.id,
      ),
    [activeSyncs.data, repository.id],
  );
  const queuedByNumber = useMemo(() => {
    const items = new Map<
      number,
      { id: string; queueState: "active" | "removed" | string }
    >();
    for (const review of queuedReviews.data ?? []) {
      if (
        review.repositoryOwner !== repository.owner ||
        review.repositoryName !== repository.name
      ) {
        continue;
      }
      items.set(review.number, {
        id: review.id,
        queueState: review.queueState,
      });
    }
    return items;
  }, [queuedReviews.data, repository.name, repository.owner]);
  const failedByNumber = useMemo(() => {
    const items = new Map<number, { message: string }>();
    for (const sync of failedSyncs.data ?? []) {
      if (sync.repositoryId !== repository.id) continue;
      items.set(sync.pullRequestNumber, { message: sync.message });
    }
    return items;
  }, [failedSyncs.data, repository.id]);
  const syncPullRequest = api.review.sync.useMutation({
    onMutate: (input) =>
      setHeldNumbers((current) => new Set(current).add(input.number)),
    onSuccess: (_result, input) => {
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.recentSyncFailures.invalidate(),
        utils.provider.listUnimportedPullRequests.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
      ]);
      toast.success("Review synchronization queued", {
        description: `${repository.owner}/${repository.name} #${input.number} is being prepared in the background.`,
      });
    },
    onError: (error, input) => {
      setHeldNumbers((current) => {
        const next = new Set(current);
        next.delete(input.number);
        return next;
      });
      toast.error("Could not prepare review", {
        description: error.message,
      });
    },
  });

  useEffect(() => {
    setHeldNumbers((current) => {
      if (current.size === 0) return current;
      const next = new Set<number>();
      for (const number of current) {
        if (!queuedByNumber.has(number) && !failedByNumber.has(number)) {
          next.add(number);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [failedByNumber, queuedByNumber]);

  useEffect(() => {
    const hasActiveSync = synchronizing.length > 0;
    if (hadActiveSync.current && !hasActiveSync) {
      void queuedReviews.refetch();
      void failedSyncs.refetch();
    }
    hadActiveSync.current = hasActiveSync;
  }, [failedSyncs, queuedReviews, synchronizing.length]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-fog truncate text-xs">
            {repository.connectionName} · {providerLabel(repository.provider)}
          </p>
          <h2 className="mt-2 truncate text-2xl font-medium tracking-[-.02em]">
            <span className="text-mist">{repository.owner}/</span>
            {repository.name}
          </h2>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="secondary">
            <a href={repository.webUrl} target="_blank" rel="noreferrer">
              Open on {providerLabel(repository.provider)}
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            className="hover:bg-red-400/10 hover:text-red-700 dark:hover:text-red-200"
          >
            <Trash2 className="size-3.5" /> Remove
          </Button>
        </div>
      </div>

      <section className="bg-surface/70 rounded-2xl border border-line p-5">
        <h3 className="text-sm font-medium">Pull-request intake</h3>
        <p className="text-mist mt-0.5 text-xs">
          Choose how this repository enters your review queue.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {intakeOptions.map((option) => {
            const active = repository.reviewIntakeMode === option.mode;
            const unsupported =
              option.mode === "assigned" &&
              repository.provider === "github" &&
              repository.credentialKind === "github_app";
            const Icon = option.icon;
            return (
              <button
                type="button"
                key={option.mode}
                disabled={unsupported || intakeUpdatePending}
                onClick={() => {
                  if (!active) onRequestIntakeChange(option.mode);
                }}
                className={cn(
                  "rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-45",
                  active
                    ? "border-cyan/35 bg-cyan/[.055]"
                    : "border-line bg-surface-subtle hover:border-line-strong",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={cn(
                      "grid size-8 place-items-center rounded-lg",
                      active ? "bg-cyan/10 text-cyan" : "bg-surface text-mist",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span
                    className={cn(
                      "grid size-4 place-items-center rounded-full border",
                      active ? "border-cyan bg-cyan text-ink" : "border-line",
                    )}
                  >
                    {active && <Check className="size-3" />}
                  </span>
                </div>
                <p className="mt-4 text-sm font-medium">{option.title}</p>
                <p className="text-mist mt-1.5 text-[11px] leading-5">
                  {unsupported
                    ? "Unavailable for GitHub App installations because an App is not a human reviewer."
                    : option.description}
                </p>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-mist flex items-center gap-2 text-xs">
              {manual ? (
                <>
                  <ShieldCheck className="text-lime size-3.5" />
                  New pull requests remain under your control.
                </>
              ) : (
                <>
                  <Clock3 className="text-cyan size-3.5" />
                  {repository.intakeLastReconciledAt ? (
                    <>
                      Last checked{" "}
                      <time
                        dateTime={new Date(
                          repository.intakeLastReconciledAt,
                        ).toISOString()}
                        // Formatted in the reviewer's locale, which the server
                        // render cannot know.
                        suppressHydrationWarning
                      >
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(repository.intakeLastReconciledAt))}
                      </time>
                    </>
                  ) : (
                    "Waiting for the first automatic check."
                  )}
                </>
              )}
            </p>
            {repository.reviewIntakeMode === "all" && (
              <p className="text-fog mt-1 text-[10px] leading-4">
                This can increase provider, analysis, storage, and AI usage on
                busy repositories.
              </p>
            )}
          </div>
          {!manual && (
            <Button
              size="sm"
              variant="secondary"
              loading={reconcilePending}
              disabled={reconcilePending}
              onClick={onReconcile}
            >
              <RefreshCw className="size-3.5" />
              {reconcilePending ? "Checking…" : "Check now"}
            </Button>
          )}
        </div>
        {repository.intakeLastError && (
          <div
            role="alert"
            className="border-coral/25 bg-coral/[.055] mt-4 flex gap-3 rounded-xl border px-4 py-3"
          >
            <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-xs font-medium">
                Automatic intake needs attention
              </p>
              <p className="text-mist mt-1 text-[11px] leading-5">
                {repository.intakeLastError}
              </p>
            </div>
          </div>
        )}
      </section>

      {!manual && <DashboardSyncPanel synchronizing={synchronizing} />}

      {manual ? (
        <section className="bg-surface/70 rounded-2xl border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h3 className="text-sm font-medium">Open pull requests</h3>
              <p className="text-mist mt-0.5 text-xs">
                Prepare the ones you want in your review queue.
              </p>
            </div>
            <button
              type="button"
              aria-label="Refresh pull requests"
              disabled={openPullRequests.isFetching}
              onClick={() => void openPullRequests.refetch()}
              className="text-mist hover:text-cloud grid size-9 shrink-0 place-items-center rounded-lg border border-line transition disabled:pointer-events-none"
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  openPullRequests.isFetching && "animate-spin",
                )}
              />
            </button>
          </div>
          <div className="divide-y divide-line">
            {openPullRequests.isLoading && (
              <div className="grid h-24 place-items-center">
                <Loader2 className="text-cyan size-4 animate-spin" />
              </div>
            )}
            {openPullRequests.isError && (
              <div
                role="alert"
                className="border-coral/25 bg-coral/[.055] m-3 flex items-start gap-3 rounded-xl border px-4 py-3"
              >
                <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="text-xs font-medium">
                    Pull requests could not be loaded
                  </p>
                  <p className="text-mist mt-1 text-[11px] leading-5">
                    {openPullRequests.error.message}
                  </p>
                </div>
              </div>
            )}
            {openPullRequests.data?.map((pullRequest) => {
              const sync = synchronizing.find(
                (item) => item.pullRequestNumber === pullRequest.number,
              );
              const queued = queuedByNumber.get(pullRequest.number);
              const failed = failedByNumber.get(pullRequest.number);
              const requesting =
                heldNumbers.has(pullRequest.number) ||
                (syncPullRequest.isPending &&
                  syncPullRequest.variables?.number === pullRequest.number);
              const preparing = Boolean(sync) || (requesting && !queued);
              return (
                <OpenPullRequestRow
                  key={pullRequest.externalId}
                  failedMessage={failed?.message}
                  onPrepare={() =>
                    syncPullRequest.mutate({
                      repositoryId: repository.id,
                      number: pullRequest.number,
                    })
                  }
                  preparing={preparing}
                  preparePending={
                    syncPullRequest.isPending &&
                    syncPullRequest.variables?.number === pullRequest.number
                  }
                  progress={sync?.progress ?? 0}
                  pullRequest={pullRequest}
                  queuedReviewId={queued?.id}
                  status={sync?.status ?? "queued"}
                />
              );
            })}
            {openPullRequests.data?.length === 0 && (
              <p className="text-mist px-5 py-8 text-center text-sm">
                No open pull requests in this repository.
              </p>
            )}
          </div>
        </section>
      ) : (
        <div className="border-cyan/15 bg-cyan/[.025] flex flex-col gap-3 rounded-2xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              Automatic intake is managing this repository
            </p>
            <p className="text-mist mt-1 text-xs leading-5">
              Matching PRs go directly to your review queue. The manual
              preparation list is hidden while automation is enabled.
            </p>
          </div>
          <Button asChild size="sm" variant="secondary">
            <Link href="/pullrequests">
              <LinkPendingSpinner />
              Open review queue
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Renders one open pull request and the durable action that applies to it. */
function OpenPullRequestRow({
  failedMessage,
  onPrepare,
  preparePending,
  preparing,
  progress,
  pullRequest,
  queuedReviewId,
  status,
}: {
  failedMessage?: string;
  onPrepare: () => void;
  preparePending: boolean;
  preparing: boolean;
  progress: number;
  pullRequest: {
    number: number;
    sourceBranch: string;
    targetBranch: string;
    title: string;
  };
  queuedReviewId?: string;
  status: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center",
        preparing && "bg-cyan/[.035]",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          #{pullRequest.number} {pullRequest.title}
        </p>
        <p className="text-fog mt-1 text-xs">
          {pullRequest.sourceBranch} → {pullRequest.targetBranch}
        </p>
        {preparing && (
          <div className="mt-3 max-w-md">
            <SyncProgressMeter
              label={`#${pullRequest.number} synchronization progress`}
              progress={progress}
              status={status}
            />
          </div>
        )}
        {failedMessage && !preparing && !queuedReviewId && (
          <p className="text-coral mt-2 text-[11px] leading-5">
            {failedMessage}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {preparing ? (
          <p className="text-cyan text-xs font-medium">Preparing…</p>
        ) : queuedReviewId ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={`/review/${queuedReviewId}`}>
              <LinkPendingSpinner />
              Open review
            </Link>
          </Button>
        ) : (
          <Button size="sm" loading={preparePending} onClick={onPrepare}>
            {failedMessage ? "Retry" : "Prepare review"}
          </Button>
        )}
      </div>
    </div>
  );
}
