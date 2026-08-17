"use client";

import { CheckCheck, GitPullRequest, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DashboardAiCard,
  DashboardFailurePanel,
  DashboardHistoryPanel,
  DashboardSyncPanel,
} from "~/components/dashboard/dashboard-panels";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import {
  comparePriorityInboxText,
  filterPriorityInbox,
  type PriorityInboxItem,
  type PriorityInboxView,
  prioritizeInbox,
  priorityInboxGroup,
  priorityInboxRepositoryKey,
} from "~/lib/priority-inbox";
import { partitionReviewQueue } from "~/lib/review-queue";
import { formatTokenCount } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
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
  const hasInbox = needsReview.length > 0;

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
            Review inbox
          </p>
          <h1 className="font-editorial mt-2 text-3xl font-medium tracking-[-.04em] sm:text-4xl">
            What needs your attention.
          </h1>
          <p className="text-mist mt-2 max-w-xl text-sm leading-6">
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

      <section className="bg-surface/55 mt-8 grid grid-cols-3 gap-4 rounded-2xl border border-line px-5 py-4 sm:max-w-lg">
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
      </section>

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
        <div
          className={cn(
            "grid items-start gap-4",
            hasInbox
              ? "xl:grid-cols-[13rem_minmax(0,1fr)_20rem]"
              : "xl:grid-cols-[minmax(0,1fr)_20rem]",
          )}
        >
          <div
            className={cn(
              "order-1 space-y-4",
              hasInbox
                ? "xl:col-start-3 xl:row-start-1"
                : "xl:col-start-2 xl:row-start-1",
            )}
          >
            <DashboardSyncPanel synchronizing={synchronizing} />
            <DashboardFailurePanel failedSyncs={failedSyncs} />
            <DashboardAiCard
              localMode={localMode}
              status={aiStatus}
              usagePercent={aiUsagePercent}
              usedTokens={planUsage?.usedTokens}
              limitTokens={planUsage?.limitTokens}
              subscribed={planUsage?.subscribed}
            />
          </div>

          {hasInbox && (
            <aside className="bg-surface/55 order-2 rounded-2xl border border-line p-2 xl:col-start-1 xl:row-start-1">
              <p className="text-fog px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[.1em] uppercase">
                My work
              </p>
              <nav
                className="grid grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-1"
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
          )}

          <div
            className={cn(
              "order-3 min-w-0",
              hasInbox
                ? "xl:col-start-2 xl:row-start-1 xl:row-span-2"
                : "xl:col-start-1 xl:row-start-1 xl:row-span-2",
            )}
          >
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
                        ? "There is nothing waiting for review. Completed, closed, and removed work remains in the workspace rail."
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
              <>
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
              </>
            )}
          </div>

          {(reviewed.length > 0 ||
            closed.length > 0 ||
            removed.length > 0 ||
            !hasInbox) && (
            <div
              className={cn(
                "order-4",
                hasInbox
                  ? "xl:col-start-3 xl:row-start-2"
                  : "xl:col-start-2 xl:row-start-2",
              )}
            >
              <DashboardHistoryPanel
                reviewed={reviewed}
                closed={closed}
                removed={removed}
                compact
                pendingPullRequestId={pendingPullRequestId}
                onRemove={(pullRequest) =>
                  removeFromQueue.mutate({ pullRequestId: pullRequest.id })
                }
                onRestore={(pullRequest) =>
                  restoreToQueue.mutate({ pullRequestId: pullRequest.id })
                }
              />
            </div>
          )}
        </div>
      </section>
    </PageContainer>
  );
}
