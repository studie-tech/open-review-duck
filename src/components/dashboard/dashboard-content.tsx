"use client";

import { CheckCheck, GitPullRequest, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DashboardFailurePanel,
  DashboardSyncPanel,
} from "~/components/dashboard/dashboard-panels";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import {
  LinkNavigationStatus,
  LinkPendingSpinner,
} from "~/components/ui/link-status";
import {
  dashboardFilters,
  rememberDashboardFilters,
} from "~/lib/dashboard-filters";
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
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type DashboardPullRequests = RouterOutputs["review"]["dashboard"];
type WorkView = PriorityInboxView | "reviewed" | "closed" | "removed";

const providerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} satisfies Record<PriorityInboxItem["provider"], string>;

const workCopy = {
  all: [
    "Your priority inbox",
    "Grouped by the next useful action, then repository.",
  ],
  continue: ["In progress", "Pick up where you left off."],
  ready: ["Ready to start", "Prepared changes waiting for a first pass."],
  unreviewable: [
    "Not reviewable here",
    "No supported review units were found.",
  ],
  reviewed: [
    "Reviewed, awaiting merge",
    "Fully reviewed at the current provider revision.",
  ],
  closed: ["Closed history", "Merged and closed pull requests."],
  removed: [
    "Removed from my queue",
    "Hidden until restored or a new revision arrives.",
  ],
} satisfies Record<WorkView, readonly [string, string]>;

/** Returns whether the selected My work tab shows history instead of the inbox. */
function isHistoryView(
  view: WorkView,
): view is "reviewed" | "closed" | "removed" {
  return view === "reviewed" || view === "closed" || view === "removed";
}

/** Renders live dashboard data and follows durable synchronization progress. */
export function PullRequestsContent({
  initialPullRequests,
}: {
  initialPullRequests: DashboardPullRequests;
}) {
  const utils = api.useUtils();
  const [pendingPullRequestId, setPendingPullRequestId] = useState<string>();
  const [workView, setWorkView] = useState<WorkView>("all");
  const [providerFilter, setProviderFilter] = useState<
    "all" | PriorityInboxItem["provider"]
  >("all");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [filtersReady, setFiltersReady] = useState(false);
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
  const hadActiveSync = useRef(false);
  const reviews = pullRequests.data ?? initialPullRequests;
  const synchronizing = activeSyncs.data ?? [];
  const failedSyncs = recentSyncFailures.data ?? [];

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
  const sourceItems = isHistoryView(workView)
    ? workView === "reviewed"
      ? reviewed
      : workView === "closed"
        ? closed
        : removed
    : prioritizedNeedsReview;
  const scopedItems = useMemo(
    () =>
      filterPriorityInbox(sourceItems, {
        view: "all",
        provider: providerFilter,
        repository: repositoryFilter,
        search: searchQuery,
      }),
    [providerFilter, repositoryFilter, searchQuery, sourceItems],
  );
  const visibleItems = useMemo(
    () =>
      isHistoryView(workView) || workView === "all"
        ? scopedItems
        : scopedItems.filter(
            (pullRequest) => priorityInboxGroup(pullRequest).id === workView,
          ),
    [scopedItems, workView],
  );
  /** Applies the current provider, repository, and search filters to one list. */
  const applySharedFilters = (
    items: DashboardPullRequests,
    view: PriorityInboxView,
  ) =>
    filterPriorityInbox(items, {
      view,
      provider: providerFilter,
      repository: repositoryFilter,
      search: searchQuery,
    });
  const workCounts = {
    all: applySharedFilters(prioritizedNeedsReview, "all").length,
    continue: applySharedFilters(prioritizedNeedsReview, "continue").length,
    ready: applySharedFilters(prioritizedNeedsReview, "ready").length,
    unreviewable: applySharedFilters(prioritizedNeedsReview, "unreviewable")
      .length,
    reviewed: applySharedFilters(reviewed, "all").length,
    closed: applySharedFilters(closed, "all").length,
    removed: applySharedFilters(removed, "all").length,
  };
  const repositorySource = isHistoryView(workView)
    ? sourceItems
    : prioritizedNeedsReview;
  const repositories = useMemo(
    () =>
      [
        ...new Map(
          repositorySource
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
    [providerFilter, repositorySource],
  );
  useEffect(() => {
    const stored = dashboardFilters(window.localStorage);
    setProviderFilter(stored.provider);
    setRepositoryFilter(stored.repository);
    setSearchQuery(stored.search);
    setFiltersReady(true);
  }, []);
  useEffect(() => {
    if (!filtersReady) return;
    rememberDashboardFilters(window.localStorage, {
      provider: providerFilter,
      repository: repositoryFilter,
      search: searchQuery,
    });
  }, [filtersReady, providerFilter, repositoryFilter, searchQuery]);
  useEffect(() => {
    if (
      repositoryFilter !== "all" &&
      !repositories.some((repository) => repository.key === repositoryFilter)
    ) {
      setRepositoryFilter("all");
    }
  }, [repositories, repositoryFilter]);
  const filtersActive =
    workView !== "all" ||
    providerFilter !== "all" ||
    repositoryFilter !== "all" ||
    searchQuery.trim().length > 0;
  const hasWorkNav =
    needsReview.length + reviewed.length + closed.length + removed.length > 0;
  const showListFilters = isHistoryView(workView)
    ? sourceItems.length > 0 || filtersActive
    : needsReview.length > 0;
  const listKind = isHistoryView(workView) ? workView : "active";
  const [sectionTitle, sectionDetail] = workCopy[workView];

  /** Resets My work to the full inbox and clears search filters. */
  function clearFilters() {
    setWorkView("all");
    setProviderFilter("all");
    setRepositoryFilter("all");
    setSearchQuery("");
  }

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
            <LinkNavigationStatus
              idle={<Plus className="size-4" />}
              pending={<LinkPendingSpinner />}
            />{" "}
            Add repository
          </Link>
        </Button>
      </div>

      <div className="mt-8 space-y-4">
        <DashboardSyncPanel synchronizing={synchronizing} />
        <DashboardFailurePanel failedSyncs={failedSyncs} />
      </div>

      <section className="mt-10">
        <div
          className={cn(
            "grid items-start gap-4",
            hasWorkNav && "xl:grid-cols-[15rem_minmax(0,1fr)]",
          )}
        >
          {hasWorkNav && (
            <aside className="bg-surface/55 rounded-2xl border border-line p-2">
              <p className="text-fog px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[.1em] uppercase">
                My work
              </p>
              <nav className="grid grid-cols-1 gap-0.5" aria-label="My work">
                {(
                  [
                    ["all", "Needs review", workCounts.all, "bg-lime"],
                    ["continue", "In progress", workCounts.continue, "bg-lime"],
                    ["ready", "Ready to start", workCounts.ready, "bg-cyan"],
                    [
                      "unreviewable",
                      "Not reviewable here",
                      workCounts.unreviewable,
                      "bg-fog",
                    ],
                  ] as const
                ).map(([view, label, count, dot]) => (
                  <WorkTab
                    key={view}
                    label={label}
                    count={count}
                    dot={dot}
                    selected={workView === view}
                    onSelect={() => setWorkView(view)}
                  />
                ))}
              </nav>
              <p className="text-fog mt-2 px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[.1em] uppercase">
                History
              </p>
              <nav
                className="grid grid-cols-1 gap-0.5"
                aria-label="Review history"
              >
                {(reviewed.length > 0 || workView === "reviewed") && (
                  <WorkTab
                    label="Reviewed"
                    count={workCounts.reviewed}
                    dot="bg-lime"
                    selected={workView === "reviewed"}
                    onSelect={() => setWorkView("reviewed")}
                  />
                )}
                <WorkTab
                  label="Closed history"
                  count={workCounts.closed}
                  dot="bg-cyan"
                  selected={workView === "closed"}
                  onSelect={() => setWorkView("closed")}
                />
                {(removed.length > 0 || workView === "removed") && (
                  <WorkTab
                    label="Removed"
                    count={workCounts.removed}
                    dot="bg-fog"
                    selected={workView === "removed"}
                    onSelect={() => setWorkView("removed")}
                  />
                )}
              </nav>
            </aside>
          )}

          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-medium">{sectionTitle}</h2>
                <p className="text-mist mt-1 text-xs">{sectionDetail}</p>
              </div>
              <span
                aria-live="polite"
                className="text-fog text-xs tabular-nums"
              >
                {visibleItems.length === sourceItems.length
                  ? `${sourceItems.length} pull requests`
                  : `${visibleItems.length} of ${sourceItems.length} pull requests`}
              </span>
            </div>
            {!isHistoryView(workView) && needsReview.length === 0 ? (
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
                        ? "There is nothing waiting for review. Closed and finished work stays in My work."
                        : "Add GitHub, GitLab, or Azure DevOps and choose the pull requests you want to review with full context."}
                  </p>
                  {synchronizing.length === 0 && reviews.length === 0 && (
                    <Button asChild className="mt-6">
                      <Link href="/settings/providers">
                        <LinkPendingSpinner />
                        Connect a provider
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {showListFilters && (
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
                      {Object.entries(providerLabel).map(
                        ([provider, label]) => (
                          <option key={provider} value={provider}>
                            {label}
                          </option>
                        ),
                      )}
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
                        onClick={clearFilters}
                        className="text-mist hover:bg-surface-subtle hover:text-cloud grid size-9 shrink-0 place-items-center self-end rounded-xl transition sm:self-auto"
                      >
                        <X className="size-4" />
                      </button>
                    )}
                  </div>
                )}

                {visibleItems.length === 0 ? (
                  <div className="bg-surface/45 grid min-h-56 place-items-center rounded-2xl border border-dashed border-line-strong p-6 text-center">
                    <div>
                      <Search className="text-fog mx-auto size-5" />
                      <h3 className="mt-3 text-sm font-medium">
                        {sourceItems.length === 0
                          ? workView === "closed"
                            ? "No closed pull requests"
                            : workView === "reviewed"
                              ? "Nothing awaiting merge"
                              : "Nothing removed from your queue"
                          : "No pull requests match"}
                      </h3>
                      <p className="text-mist mt-1 text-xs">
                        {sourceItems.length === 0
                          ? "This history stays here so you can return to it later."
                          : "Try another repository, provider, or search."}
                      </p>
                      {filtersActive && (
                        <button
                          type="button"
                          onClick={clearFilters}
                          className="text-lime mt-4 text-xs font-medium hover:underline"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <PullRequestList
                    pullRequests={visibleItems}
                    kind={listKind}
                    showPriorityGroups={!isHistoryView(workView)}
                    pendingPullRequestId={pendingPullRequestId}
                    onRemove={
                      listKind === "active" || listKind === "reviewed"
                        ? (pullRequest) =>
                            removeFromQueue.mutate({
                              pullRequestId: pullRequest.id,
                            })
                        : undefined
                    }
                    onRestore={
                      listKind === "removed"
                        ? (pullRequest) =>
                            restoreToQueue.mutate({
                              pullRequestId: pullRequest.id,
                            })
                        : undefined
                    }
                  />
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </PageContainer>
  );
}

/** Renders one selectable My work or history view. */
function WorkTab({
  label,
  count,
  dot,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  dot: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label}, ${count}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={
        selected
          ? "bg-surface-subtle text-cloud flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-medium"
          : "text-mist hover:bg-surface-subtle/70 hover:text-cloud flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition"
      }
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${dot}`}
      />
      <span className="min-w-0 flex-1">{label}</span>
      <span className="text-fog tabular-nums">{count}</span>
    </button>
  );
}
