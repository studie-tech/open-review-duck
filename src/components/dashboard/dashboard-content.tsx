"use client";

import {
  CheckCheck,
  ChevronDown,
  CircleAlert,
  GitMerge,
  GitPullRequest,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import {
  comparePriorityInboxText,
  filterPriorityInbox,
  prioritizeInbox,
  priorityInboxGroup,
  priorityInboxRepositoryKey,
  type PriorityInboxItem,
  type PriorityInboxView,
} from "~/lib/priority-inbox";
import { partitionReviewQueue } from "~/lib/review-queue";
import { syncProgressLabel } from "~/lib/sync-progress";
import { formatTokenCount } from "~/lib/token-usage";
import { api, type RouterOutputs } from "~/trpc/react";

type DashboardPullRequests = RouterOutputs["review"]["dashboard"];
type AiConfiguration = RouterOutputs["ai"]["configuration"];
type AiPlanUsage = RouterOutputs["ai"]["planUsage"];

const providerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} satisfies Record<PriorityInboxItem["provider"], string>;

/** Renders live dashboard data and follows durable synchronization progress. */
export function DashboardContent({
  initialPullRequests,
  initialAiConfiguration,
  initialAiPlanUsage,
  localMode,
}: {
  initialPullRequests: DashboardPullRequests;
  initialAiConfiguration: AiConfiguration;
  initialAiPlanUsage: AiPlanUsage;
  localMode: boolean;
}) {
  const utils = api.useUtils();
  const [pendingPullRequestId, setPendingPullRequestId] = useState<string>();
  const [inboxView, setInboxView] = useState<PriorityInboxView>("all");
  const [providerFilter, setProviderFilter] = useState<
    "all" | PriorityInboxItem["provider"]
  >("all");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const activeSyncs = api.review.activeSyncs.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? 1_500 : false,
  });
  const recentSyncFailures = api.review.recentSyncFailures.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const pullRequests = api.review.dashboard.useQuery(undefined, {
    enabled: activeSyncs.isFetched,
    initialData: initialPullRequests,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const aiConfiguration = api.ai.configuration.useQuery(undefined, {
    initialData: initialAiConfiguration,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const aiPlanUsage = api.ai.planUsage.useQuery(undefined, {
    enabled: !localMode,
    initialData: initialAiPlanUsage ?? undefined,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const hadActiveSync = useRef(false);
  const reviews = pullRequests.data ?? initialPullRequests;
  const synchronizing = activeSyncs.data ?? [];
  const failedSyncs = recentSyncFailures.data ?? [];
  const configuration = aiConfiguration.data ?? initialAiConfiguration;
  const planUsage = aiPlanUsage.data ?? initialAiPlanUsage;

  /** Updates one queue item immediately while the server mutation settles. */
  function setQueueState(
    pullRequestId: string,
    queueState: "active" | "removed",
  ) {
    utils.review.dashboard.setData(undefined, (current) =>
      current?.map((pullRequest) =>
        pullRequest.id === pullRequestId
          ? {
              ...pullRequest,
              queueState,
              removedAt: queueState === "removed" ? new Date() : null,
            }
          : pullRequest,
      ),
    );
  }

  const restoreToQueue = api.review.restoreToQueue.useMutation({
    onMutate: ({ pullRequestId }) => {
      setPendingPullRequestId(pullRequestId);
      setQueueState(pullRequestId, "active");
    },
    onSuccess: () => toast.success("Restored to your review queue"),
    onError: (error) => {
      void utils.review.dashboard.invalidate();
      toast.error("Could not restore review", { description: error.message });
    },
    onSettled: () => setPendingPullRequestId(undefined),
  });
  const removeFromQueue = api.review.removeFromQueue.useMutation({
    onMutate: ({ pullRequestId }) => {
      setPendingPullRequestId(pullRequestId);
      setQueueState(pullRequestId, "removed");
    },
    onSuccess: (_result, variables) =>
      toast.success("Removed from your review queue", {
        description:
          "It stays under Removed and can be restored at any time. Automatic intake may bring it back after a new revision.",
        action: {
          label: "Undo",
          onClick: () =>
            restoreToQueue.mutate({
              pullRequestId: variables.pullRequestId,
            }),
        },
      }),
    onError: (error) => {
      void utils.review.dashboard.invalidate();
      toast.error("Could not remove review", { description: error.message });
    },
    onSettled: () => setPendingPullRequestId(undefined),
  });

  useEffect(() => {
    const hasActiveSync = synchronizing.length > 0;
    if (hadActiveSync.current && !hasActiveSync) {
      void pullRequests.refetch();
      void recentSyncFailures.refetch();
    }
    hadActiveSync.current = hasActiveSync;
  }, [pullRequests, recentSyncFailures, synchronizing.length]);

  const { needsReview, reviewed, closed, removed } = useMemo(
    () => partitionReviewQueue(reviews),
    [reviews],
  );
  const prioritizedNeedsReview = useMemo(
    () => prioritizeInbox(needsReview),
    [needsReview],
  );
  const scopedNeedsReview = useMemo(
    () =>
      filterPriorityInbox(prioritizedNeedsReview, {
        view: "all",
        provider: providerFilter,
        repository: repositoryFilter,
        search: searchQuery,
      }),
    [prioritizedNeedsReview, providerFilter, repositoryFilter, searchQuery],
  );
  const filteredNeedsReview = useMemo(
    () =>
      inboxView === "all"
        ? scopedNeedsReview
        : scopedNeedsReview.filter(
            (pullRequest) => priorityInboxGroup(pullRequest).id === inboxView,
          ),
    [inboxView, scopedNeedsReview],
  );
  const inProgressCount = useMemo(
    () =>
      needsReview.filter(
        (pullRequest) => priorityInboxGroup(pullRequest).id === "continue",
      ).length,
    [needsReview],
  );
  const inboxCounts = useMemo(
    () => ({
      all: scopedNeedsReview.length,
      continue: scopedNeedsReview.filter(
        (pullRequest) => priorityInboxGroup(pullRequest).id === "continue",
      ).length,
      ready: scopedNeedsReview.filter(
        (pullRequest) => priorityInboxGroup(pullRequest).id === "ready",
      ).length,
      unreviewable: scopedNeedsReview.filter(
        (pullRequest) => priorityInboxGroup(pullRequest).id === "unreviewable",
      ).length,
    }),
    [scopedNeedsReview],
  );
  const repositories = useMemo(
    () =>
      [
        ...new Map(
          prioritizedNeedsReview
            .filter(
              (pullRequest) =>
                providerFilter === "all" ||
                pullRequest.provider === providerFilter,
            )
            .map((pullRequest) => [
              priorityInboxRepositoryKey(pullRequest),
              {
                key: priorityInboxRepositoryKey(pullRequest),
                label: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`,
                provider: pullRequest.provider,
              },
            ]),
        ).values(),
      ].sort((left, right) =>
        comparePriorityInboxText(left.label, right.label),
      ),
    [prioritizedNeedsReview, providerFilter],
  );
  useEffect(() => {
    if (
      repositoryFilter !== "all" &&
      !repositories.some((repository) => repository.key === repositoryFilter)
    ) {
      setRepositoryFilter("all");
    }
  }, [repositories, repositoryFilter]);
  const filtersActive =
    inboxView !== "all" ||
    providerFilter !== "all" ||
    repositoryFilter !== "all" ||
    searchQuery.trim().length > 0;
  const localAiStatus =
    configuration.mode === "off"
      ? ["Off", "Enable when you want assistance"]
      : !configuration.configuration
        ? ["Setup", "Connect your preferred model provider"]
        : configuration.configuration.useManagedModels
          ? configuration.configuration.provider === "opencode"
            ? ["Free", "Managed Big Pickle with privacy controls"]
            : ["Subscriber", "Managed ZDR model with quota guardrails"]
          : ["Connected", "Using your local AI configuration"];
  const resetLabel = planUsage?.resetsAt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  const aiStatus =
    !localMode && planUsage
      ? [
          `${formatTokenCount(planUsage.usedTokens)} / ${formatTokenCount(planUsage.limitTokens)}`,
          `${formatTokenCount(planUsage.remainingTokens)} left · resets ${resetLabel}`,
        ]
      : localAiStatus;
  const aiUsagePercent = planUsage
    ? Math.min(100, (planUsage.usedTokens / planUsage.limitTokens) * 100)
    : 0;

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
            Review inbox
          </p>
          <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em] sm:text-5xl">
            What needs your attention.
          </h1>
          <p className="text-mist mt-3 max-w-xl text-sm leading-6">
            Continue an active review first, then pick up the next prepared
            change across every repository and provider.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/providers">
            <Plus className="size-4" /> Add repository
          </Link>
        </Button>
      </div>

      <section className="bg-surface/55 mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-line px-5 py-4">
        <div>
          <p className="text-fog text-[10px] tracking-[.08em] uppercase">
            Needs review
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {needsReview.length}
          </p>
        </div>
        <div>
          <p className="text-fog text-[10px] tracking-[.08em] uppercase">
            In progress
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {inProgressCount}
          </p>
        </div>
        <div>
          <p className="text-fog text-[10px] tracking-[.08em] uppercase">
            Reviewed
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {reviewed.length}
          </p>
        </div>
        <div className="bg-line hidden h-8 w-px sm:block" />
        <div className="min-w-44 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles className="text-violet size-3.5" />
            <p className="text-mist text-xs">
              AI assistant · <span className="text-cloud">{aiStatus[0]}</span>
            </p>
          </div>
          <p className="text-fog mt-0.5 text-[10px]">{aiStatus[1]}</p>
          {!localMode && planUsage && (
            <div className="mt-2 flex items-center gap-3">
              <div
                className="bg-surface-subtle h-1.5 min-w-24 flex-1 overflow-hidden rounded-full"
                role="progressbar"
                aria-label="Monthly AI token usage"
                aria-valuemin={0}
                aria-valuemax={planUsage.limitTokens}
                aria-valuenow={planUsage.usedTokens}
              >
                <div
                  className="bg-violet h-full rounded-full"
                  style={{ width: `${aiUsagePercent}%` }}
                />
              </div>
              <Link
                href="/settings/ai"
                className="text-violet text-[10px] font-medium hover:underline"
              >
                {planUsage.subscribed ? "Manage plan" : "View plans"}
              </Link>
            </div>
          )}
        </div>
      </section>

      {synchronizing.length > 0 && (
        <section
          aria-live="polite"
          className="border-cyan/20 bg-cyan/[.045] mt-6 rounded-2xl border px-4 py-3"
        >
          <div className="flex items-center gap-3">
            <Loader2 className="text-cyan size-4 shrink-0 animate-spin" />
            <div className="min-w-0">
              <p className="text-cloud text-sm font-medium">
                {synchronizing.length === 1
                  ? "Preparing a review"
                  : `Preparing ${synchronizing.length} reviews`}
              </p>
              <p className="text-mist mt-0.5 text-xs">
                The review queue updates automatically as each pull request is
                ready.
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-2 border-t border-cyan/10 pt-3">
            {synchronizing.map((sync) => {
              const progress = Math.min(99, Math.max(0, sync.progress));
              const provider =
                sync.provider === "azure_devops"
                  ? "Azure DevOps"
                  : sync.provider === "gitlab"
                    ? "GitLab"
                    : "GitHub";
              return (
                <li key={sync.id} className="min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-cloud truncate text-xs font-medium">
                        <span className="text-mist">{provider}</span>
                        {" · "}
                        {sync.repositoryOwner}/{sync.repositoryName} #
                        {sync.pullRequestNumber}
                      </p>
                      {sync.title && (
                        <p className="text-mist mt-0.5 truncate text-[11px]">
                          {sync.title}
                        </p>
                      )}
                    </div>
                    <span className="text-cyan shrink-0 text-[11px] tabular-nums">
                      {progress}%
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <div
                      className="bg-surface-subtle h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
                      role="progressbar"
                      aria-label={`${sync.repositoryOwner}/${sync.repositoryName} #${sync.pullRequestNumber} synchronization progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <div
                        className="bg-cyan h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-fog w-48 shrink-0 truncate text-right text-[11px] sm:w-56">
                      {syncProgressLabel(sync.status, progress)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {failedSyncs.length > 0 && (
        <section
          aria-live="polite"
          className="border-coral/25 bg-coral/[.045] mt-6 rounded-2xl border px-4 py-3"
        >
          <div className="flex items-start gap-3">
            <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-cloud text-sm font-medium">
                {failedSyncs.length === 1
                  ? "A review could not be prepared"
                  : `${failedSyncs.length} reviews could not be prepared`}
              </p>
              <p className="text-mist mt-0.5 text-xs">
                Unresolved synchronization failures remain visible for up to 24
                hours.
              </p>
              <ul className="mt-3 space-y-3 border-t border-coral/10 pt-3">
                {failedSyncs.map((sync) => {
                  const provider =
                    sync.provider === "azure_devops"
                      ? "Azure DevOps"
                      : sync.provider === "gitlab"
                        ? "GitLab"
                        : "GitHub";
                  return (
                    <li key={sync.id} className="min-w-0 text-xs">
                      <p className="text-cloud font-medium">
                        <span className="text-mist">{provider}</span>
                        {" · "}
                        {sync.repositoryOwner}/{sync.repositoryName} #
                        {sync.pullRequestNumber}
                      </p>
                      {sync.title && (
                        <p className="text-mist mt-0.5 truncate text-[11px]">
                          {sync.title}
                        </p>
                      )}
                      <p className="text-fog mt-1 text-[11px] leading-5">
                        Failed at {sync.progress}% while{" "}
                        {syncProgressLabel(
                          "running",
                          sync.progress,
                        ).toLowerCase()}
                        . {sync.message}{" "}
                        <Link
                          href="/settings/providers"
                          className="text-coral font-medium hover:underline"
                        >
                          Review connection
                        </Link>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">Your priority inbox</h2>
            <p className="text-mist mt-1 text-xs">
              Grouped by the next useful action, then repository.
            </p>
          </div>
          <span aria-live="polite" className="text-fog text-xs tabular-nums">
            {filteredNeedsReview.length === needsReview.length
              ? `${needsReview.length} pull requests`
              : `${filteredNeedsReview.length} of ${needsReview.length} pull requests`}
          </span>
        </div>
        {needsReview.length === 0 ? (
          <div className="bg-surface/55 grid min-h-80 place-items-center rounded-3xl border border-dashed border-line-strong p-8 text-center">
            <div>
              <span className="text-lime mx-auto grid size-12 place-items-center rounded-2xl bg-lime/10">
                {reviews.length > 0 ? (
                  <CheckCheck className="size-5" />
                ) : (
                  <GitPullRequest className="size-5" />
                )}
              </span>
              <h3 className="mt-5 text-lg font-medium">
                {synchronizing.length > 0
                  ? "Your review is being prepared"
                  : reviews.length > 0
                    ? "You're caught up"
                    : "Connect your first repository"}
              </h3>
              <p className="text-mist mx-auto mt-2 max-w-sm text-sm leading-6">
                {synchronizing.length > 0
                  ? "You can stay on this page. The pull request will appear as soon as its dependency path is ready."
                  : reviews.length > 0
                    ? "There is nothing waiting for review. Completed, closed, and removed work remains available below."
                    : "Add GitHub, GitLab, or Azure DevOps and choose the pull requests you want to review with full context."}
              </p>
              {synchronizing.length === 0 && reviews.length === 0 && (
                <Button asChild className="mt-6">
                  <Link href="/settings/providers">Connect a provider</Link>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <aside className="bg-surface/55 rounded-2xl border border-line p-2">
              <p className="text-fog px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[.1em] uppercase">
                My work
              </p>
              <nav
                className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1"
                aria-label="Priority inbox views"
              >
                {[
                  ["all", "Needs review", inboxCounts.all, "bg-lime"],
                  ["continue", "In progress", inboxCounts.continue, "bg-lime"],
                  ["ready", "Ready to start", inboxCounts.ready, "bg-cyan"],
                  [
                    "unreviewable",
                    "Not reviewable here",
                    inboxCounts.unreviewable,
                    "bg-fog",
                  ],
                ].map(([view, label, count, dot]) => (
                  <button
                    key={view}
                    type="button"
                    aria-label={`${label}, ${count}`}
                    aria-pressed={inboxView === view}
                    onClick={() => setInboxView(view as PriorityInboxView)}
                    className={
                      inboxView === view
                        ? "bg-surface-subtle text-cloud flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-medium"
                        : "text-mist hover:bg-surface-subtle/70 hover:text-cloud flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition"
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={`size-1.5 shrink-0 rounded-full ${dot}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="text-fog tabular-nums">{count}</span>
                  </button>
                ))}
              </nav>
            </aside>

            <div className="min-w-0">
              <div className="bg-surface/55 mb-3 flex flex-col gap-2 rounded-2xl border border-line p-3 sm:flex-row sm:items-center">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Search pull requests</span>
                  <Search className="text-fog pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) =>
                      setSearchQuery(event.currentTarget.value)
                    }
                    placeholder="Search PRs, repos, authors…"
                    className="bg-ink/35 placeholder:text-fog h-9 w-full rounded-xl border border-line py-2 pr-3 pl-9 text-xs outline-none transition focus:border-line-strong"
                  />
                </label>
                <select
                  aria-label="Filter by provider"
                  value={providerFilter}
                  onChange={(event) => {
                    setProviderFilter(
                      event.currentTarget.value as
                        | "all"
                        | PriorityInboxItem["provider"],
                    );
                    setRepositoryFilter("all");
                  }}
                  className="bg-ink/35 h-9 rounded-xl border border-line px-3 text-xs outline-none transition focus:border-line-strong sm:max-w-36"
                >
                  <option value="all">All providers</option>
                  {Object.entries(providerLabel).map(([provider, label]) => (
                    <option key={provider} value={provider}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by repository"
                  value={repositoryFilter}
                  onChange={(event) =>
                    setRepositoryFilter(event.currentTarget.value)
                  }
                  className="bg-ink/35 h-9 min-w-0 rounded-xl border border-line px-3 text-xs outline-none transition focus:border-line-strong sm:max-w-52"
                >
                  <option value="all">All repositories</option>
                  {repositories.map((repository) => (
                    <option key={repository.key} value={repository.key}>
                      {repository.label}
                      {providerFilter === "all"
                        ? ` · ${providerLabel[repository.provider]}`
                        : ""}
                    </option>
                  ))}
                </select>
                {filtersActive && (
                  <button
                    type="button"
                    aria-label="Clear inbox filters"
                    title="Clear filters"
                    onClick={() => {
                      setInboxView("all");
                      setProviderFilter("all");
                      setRepositoryFilter("all");
                      setSearchQuery("");
                    }}
                    className="text-mist hover:bg-surface-subtle hover:text-cloud grid size-9 shrink-0 place-items-center self-end rounded-xl transition sm:self-auto"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>

              {filteredNeedsReview.length === 0 ? (
                <div className="bg-surface/45 grid min-h-56 place-items-center rounded-2xl border border-dashed border-line-strong p-6 text-center">
                  <div>
                    <Search className="text-fog mx-auto size-5" />
                    <h3 className="mt-3 text-sm font-medium">
                      No pull requests match
                    </h3>
                    <p className="text-mist mt-1 text-xs">
                      Try another repository, provider, or search.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setInboxView("all");
                        setProviderFilter("all");
                        setRepositoryFilter("all");
                        setSearchQuery("");
                      }}
                      className="text-lime mt-4 text-xs font-medium hover:underline"
                    >
                      Clear filters
                    </button>
                  </div>
                </div>
              ) : (
                <PullRequestList
                  pullRequests={filteredNeedsReview}
                  kind="active"
                  showPriorityGroups
                  pendingPullRequestId={pendingPullRequestId}
                  onRemove={(pullRequest) =>
                    removeFromQueue.mutate({ pullRequestId: pullRequest.id })
                  }
                />
              )}
            </div>
          </div>
        )}
      </section>

      {reviewed.length > 0 && (
        <details className="group mt-8 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-lime/10 text-lime grid size-8 place-items-center rounded-lg">
              <CheckCheck className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                Reviewed, awaiting merge
              </span>
              <span className="text-fog mt-0.5 block text-xs">
                Fully reviewed at the current provider revision
              </span>
            </span>
            <span className="text-mist text-xs">{reviewed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList
              pullRequests={reviewed}
              kind="reviewed"
              pendingPullRequestId={pendingPullRequestId}
              onRemove={(pullRequest) =>
                removeFromQueue.mutate({ pullRequestId: pullRequest.id })
              }
            />
          </div>
        </details>
      )}

      {closed.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-cyan/10 text-cyan grid size-8 place-items-center rounded-lg">
              <GitMerge className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Closed history</span>
              <span className="text-fog mt-0.5 block text-xs">
                Merged and closed pull requests
              </span>
            </span>
            <span className="text-mist text-xs">{closed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList pullRequests={closed} kind="closed" />
          </div>
        </details>
      )}

      {removed.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-surface-subtle text-mist grid size-8 place-items-center rounded-lg">
              <RotateCcw className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                Removed from my queue
              </span>
              <span className="text-fog mt-0.5 block text-xs">
                Hidden until restored or a new revision arrives
              </span>
            </span>
            <span className="text-mist text-xs">{removed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList
              pullRequests={removed}
              kind="removed"
              pendingPullRequestId={pendingPullRequestId}
              onRestore={(pullRequest) =>
                restoreToQueue.mutate({ pullRequestId: pullRequest.id })
              }
            />
          </div>
        </details>
      )}
    </PageContainer>
  );
}
