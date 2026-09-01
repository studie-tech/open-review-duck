"use client";

import {
  CheckCheck,
  CircleAlert,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { RepositoryFilter } from "~/components/dashboard/repository-filter";
import { ReviewPreparationList } from "~/components/dashboard/review-preparation-list";
import { UnimportedPullRequestList } from "~/components/dashboard/unimported-pull-request-list";
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
import { hydratedQueryOptions } from "~/lib/hydration-clock";
import {
  comparePriorityInboxText,
  filterPriorityInbox,
  type PriorityInboxItem,
  type PriorityInboxView,
  prioritizeInbox,
  priorityInboxGroup,
  priorityInboxRepositoryKey,
} from "~/lib/priority-inbox";
import { PROVIDER_NAMES, providerLabel } from "~/lib/provider-labels";
import { filterReviewPreparations } from "~/lib/review-preparation";
import { partitionReviewQueue } from "~/lib/review-queue";
import { followActiveReviewJobs } from "~/lib/sync-progress";
import {
  filterUnimportedPullRequests,
  type UnimportedPullRequest,
  unimportedPullRequestKey,
  unimportedRepositoryKey,
} from "~/lib/unimported-pull-requests";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type DashboardPullRequests = RouterOutputs["review"]["dashboard"];
type UnimportedInboxSectionProps = {
  draftsHidden: boolean;
  errorMessage?: string;
  errors: Array<{
    message: string;
    repositoryId: string;
    repositoryName: string;
    repositoryOwner: string;
  }>;
  filtersActive: boolean;
  heading?: boolean;
  isError: boolean;
  isLoading: boolean;
  onClearFilters: () => void;
  onPrepare: (pullRequest: UnimportedPullRequest) => void;
  onRetry: () => void;
  onShowDrafts: () => void;
  pendingKey?: string;
  pullRequests: UnimportedPullRequest[];
  totalCount: number;
};
type WorkView =
  | PriorityInboxView
  | "reviewed"
  | "closed"
  | "removed"
  | "unimported";

const workCopy = {
  all: [
    "Your priority inbox",
    "Grouped by the next useful action, then repository.",
  ],
  continue: ["In progress", "Pick up where you left off."],
  ready: ["Ready to start", "Prepared changes waiting for a first pass."],
  unreviewable: [
    "Not reviewable here",
    "Open on the provider or synchronize if supported files landed.",
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
  unimported: [
    "Un-imported PRs",
    "Open changes from repositories you prepare by hand.",
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
  fetchedAt,
}: {
  initialPullRequests: DashboardPullRequests;
  fetchedAt: number;
}) {
  const utils = api.useUtils();
  const [pendingPullRequestId, setPendingPullRequestId] = useState<string>();
  const [workView, setWorkView] = useState<WorkView>("all");
  const [providerFilter, setProviderFilter] = useState<
    "all" | PriorityInboxItem["provider"]
  >("all");
  const [repositoryFilter, setRepositoryFilter] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDrafts, setShowDrafts] = useState(true);
  const [filtersReady, setFiltersReady] = useState(false);
  const activeSyncs = api.review.activeSyncs.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: followActiveReviewJobs,
  });
  const recentSyncFailures = api.review.recentSyncFailures.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const pullRequests = api.review.dashboard.useQuery(undefined, {
    ...hydratedQueryOptions(initialPullRequests, fetchedAt),
    enabled: activeSyncs.isFetched,
  });
  const unimportedPullRequests =
    api.provider.listUnimportedPullRequests.useQuery(undefined, {
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    });
  const [pendingUnimportedKey, setPendingUnimportedKey] = useState<string>();
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
  const prepareReview = api.review.sync.useMutation({
    onMutate: (input) =>
      setPendingUnimportedKey(
        unimportedPullRequestKey({
          repositoryId: input.repositoryId,
          number: input.number,
        }),
      ),
    onSuccess: (_result, input) => {
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.provider.listUnimportedPullRequests.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
      ]);
      toast.success("Review synchronization queued", {
        description: `Pull request #${input.number} is being prepared in the background.`,
      });
    },
    onError: (error) => {
      setPendingUnimportedKey(undefined);
      toast.error("Could not prepare review", {
        description: error.message,
      });
    },
  });

  useEffect(() => {
    const hasActiveSync = synchronizing.length > 0;
    if (hadActiveSync.current && !hasActiveSync) {
      void pullRequests.refetch();
      void recentSyncFailures.refetch();
      void unimportedPullRequests.refetch();
    }
    hadActiveSync.current = hasActiveSync;
  }, [
    pullRequests,
    recentSyncFailures,
    synchronizing.length,
    unimportedPullRequests,
  ]);

  const { needsReview, reviewed, closed, removed } = useMemo(
    () => partitionReviewQueue(reviews),
    [reviews],
  );
  const prioritizedNeedsReview = useMemo(
    () => prioritizeInbox(needsReview),
    [needsReview],
  );
  const unimportedSource = unimportedPullRequests.data?.pullRequests ?? [];
  const synchronizingKeys = useMemo(
    () =>
      new Set(
        synchronizing.map(
          (sync) => `${sync.repositoryId}:${sync.pullRequestNumber}`,
        ),
      ),
    [synchronizing],
  );
  const preparationKeys = useMemo(
    () =>
      new Set(
        [...synchronizing, ...failedSyncs].map(
          (sync) => `${sync.repositoryId}:${sync.pullRequestNumber}`,
        ),
      ),
    [failedSyncs, synchronizing],
  );
  useEffect(() => {
    if (!pendingUnimportedKey) return;
    if (synchronizingKeys.has(pendingUnimportedKey)) {
      setPendingUnimportedKey(undefined);
      return;
    }
    const stillListed = unimportedSource.some(
      (pullRequest) =>
        unimportedPullRequestKey(pullRequest) === pendingUnimportedKey,
    );
    if (!stillListed && !prepareReview.isPending) {
      setPendingUnimportedKey(undefined);
    }
  }, [
    pendingUnimportedKey,
    prepareReview.isPending,
    synchronizingKeys,
    unimportedSource,
  ]);
  const availableUnimported = useMemo(
    () =>
      unimportedSource.filter(
        (pullRequest) =>
          !preparationKeys.has(unimportedPullRequestKey(pullRequest)),
      ),
    [preparationKeys, unimportedSource],
  );
  const preparationFilters = useMemo(
    () => ({
      provider: providerFilter,
      repositories: repositoryFilter,
      search: searchQuery,
    }),
    [providerFilter, repositoryFilter, searchQuery],
  );
  const visibleSynchronizing = useMemo(
    () => filterReviewPreparations(synchronizing, preparationFilters),
    [preparationFilters, synchronizing],
  );
  const visibleFailedSyncs = useMemo(
    () => filterReviewPreparations(failedSyncs, preparationFilters),
    [failedSyncs, preparationFilters],
  );
  const visiblePreparationCount =
    visibleSynchronizing.length + visibleFailedSyncs.length;
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
        repositories: repositoryFilter,
        search: searchQuery,
        includeDrafts: showDrafts,
      }),
    [providerFilter, repositoryFilter, searchQuery, showDrafts, sourceItems],
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
  const visibleUnimported = useMemo(
    () =>
      filterUnimportedPullRequests(availableUnimported, {
        includeDrafts: showDrafts,
        provider: providerFilter,
        repositories: repositoryFilter,
        search: searchQuery,
      }),
    [
      availableUnimported,
      providerFilter,
      repositoryFilter,
      searchQuery,
      showDrafts,
    ],
  );
  /** Applies the current provider, repository, and search filters to one list. */
  const applySharedFilters = (
    items: DashboardPullRequests,
    view: PriorityInboxView,
  ) =>
    filterPriorityInbox(items, {
      view,
      provider: providerFilter,
      repositories: repositoryFilter,
      search: searchQuery,
      includeDrafts: showDrafts,
    });
  const workCounts = {
    all:
      applySharedFilters(prioritizedNeedsReview, "all").length +
      visiblePreparationCount,
    continue: applySharedFilters(prioritizedNeedsReview, "continue").length,
    ready: applySharedFilters(prioritizedNeedsReview, "ready").length,
    unreviewable: applySharedFilters(prioritizedNeedsReview, "unreviewable")
      .length,
    reviewed: applySharedFilters(reviewed, "all").length,
    closed: applySharedFilters(closed, "all").length,
    removed: applySharedFilters(removed, "all").length,
    unimported: visibleUnimported.length,
  };
  const hasManualRepositories =
    (unimportedPullRequests.data?.manualRepositoryCount ?? 0) > 0;
  const repositorySource = useMemo(
    () =>
      isHistoryView(workView)
        ? sourceItems
        : workView === "unimported"
          ? availableUnimported
          : [
              ...prioritizedNeedsReview,
              ...synchronizing,
              ...failedSyncs,
              ...availableUnimported,
            ],
    [
      availableUnimported,
      failedSyncs,
      prioritizedNeedsReview,
      sourceItems,
      synchronizing,
      workView,
    ],
  );
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
            .map((pullRequest) => {
              const key =
                "repositoryId" in pullRequest
                  ? unimportedRepositoryKey(pullRequest)
                  : priorityInboxRepositoryKey(pullRequest);
              return [
                key,
                {
                  key,
                  label: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`,
                  provider: pullRequest.provider,
                },
              ] as const;
            }),
        ).values(),
      ].sort((left, right) =>
        comparePriorityInboxText(left.label, right.label),
      ),
    [providerFilter, repositorySource],
  );
  useEffect(() => {
    const stored = dashboardFilters(window.localStorage);
    setProviderFilter(stored.provider);
    setRepositoryFilter(stored.repositories);
    setSearchQuery(stored.search);
    setShowDrafts(stored.showDrafts);
    setFiltersReady(true);
  }, []);
  useEffect(() => {
    if (!filtersReady) return;
    rememberDashboardFilters(window.localStorage, {
      provider: providerFilter,
      repositories: repositoryFilter,
      search: searchQuery,
      showDrafts,
    });
  }, [filtersReady, providerFilter, repositoryFilter, searchQuery, showDrafts]);
  useEffect(() => {
    if (unimportedPullRequests.isFetched === false) return;
    const available = new Set(repositories.map((repository) => repository.key));
    if (repositoryFilter.some((key) => !available.has(key))) {
      setRepositoryFilter(repositoryFilter.filter((key) => available.has(key)));
    }
  }, [repositories, repositoryFilter, unimportedPullRequests.isFetched]);
  const filtersActive =
    workView !== "all" ||
    providerFilter !== "all" ||
    repositoryFilter.length > 0 ||
    searchQuery.trim().length > 0;
  const hasImportedWork =
    needsReview.length + reviewed.length + closed.length + removed.length > 0;
  const hasUnimportedQueryError = unimportedPullRequests.isError;
  const hasPreparationWork = synchronizing.length + failedSyncs.length > 0;
  const hasWorkNav =
    hasImportedWork ||
    hasPreparationWork ||
    hasManualRepositories ||
    hasUnimportedQueryError;
  const showCatchUpEmpty =
    !isHistoryView(workView) &&
    workView !== "unimported" &&
    needsReview.length === 0 &&
    !hasPreparationWork &&
    !(workView === "all" && availableUnimported.length > 0) &&
    !hasUnimportedQueryError;
  const showListFilters = isHistoryView(workView)
    ? sourceItems.length > 0 || filtersActive
    : workView === "unimported"
      ? hasManualRepositories || filtersActive
      : needsReview.length > 0 ||
        hasPreparationWork ||
        availableUnimported.length > 0;
  const listKind = isHistoryView(workView) ? workView : "active";
  const [sectionTitle, sectionDetail] = workCopy[workView];
  const listedCount =
    workView === "unimported"
      ? visibleUnimported.length
      : visibleItems.length +
        (workView === "all" ? visiblePreparationCount : 0);
  const listedTotal =
    workView === "unimported"
      ? availableUnimported.length
      : sourceItems.length +
        (workView === "all" ? synchronizing.length + failedSyncs.length : 0);
  const filterScopeItems = useMemo(() => {
    if (workView === "unimported") {
      return filterUnimportedPullRequests(availableUnimported, {
        includeDrafts: true,
        provider: providerFilter,
        repositories: repositoryFilter,
        search: searchQuery,
      });
    }
    const matching = filterPriorityInbox(sourceItems, {
      view: "all",
      provider: providerFilter,
      repositories: repositoryFilter,
      search: searchQuery,
      includeDrafts: true,
    });
    return isHistoryView(workView) || workView === "all"
      ? matching
      : matching.filter(
          (pullRequest) => priorityInboxGroup(pullRequest).id === workView,
        );
  }, [
    availableUnimported,
    providerFilter,
    repositoryFilter,
    searchQuery,
    sourceItems,
    workView,
  ]);
  const draftsHidden =
    !showDrafts &&
    (workView === "unimported"
      ? filterScopeItems.some((pullRequest) => pullRequest.state === "draft")
      : filterScopeItems.some((pullRequest) => pullRequest.state === "draft") ||
        (workView === "all" &&
          filterUnimportedPullRequests(availableUnimported, {
            includeDrafts: true,
            provider: providerFilter,
            repositories: repositoryFilter,
            search: searchQuery,
          }).some((pullRequest) => pullRequest.state === "draft")));

  /** Resets My work to the full inbox and clears search filters. */
  function clearFilters() {
    setWorkView("all");
    setProviderFilter("all");
    setRepositoryFilter([]);
    setSearchQuery("");
  }

  const unimportedSectionProps = {
    draftsHidden,
    errorMessage: unimportedPullRequests.error?.message,
    errors: unimportedPullRequests.data?.errors ?? [],
    filtersActive,
    isError: unimportedPullRequests.isError,
    isLoading: unimportedPullRequests.isLoading,
    onClearFilters: clearFilters,
    onPrepare: (pullRequest: UnimportedPullRequest) =>
      prepareReview.mutate({
        repositoryId: pullRequest.repositoryId,
        number: pullRequest.number,
      }),
    onRetry: () => void unimportedPullRequests.refetch(),
    onShowDrafts: () => setShowDrafts(true),
    pendingKey: pendingUnimportedKey,
    pullRequests: visibleUnimported,
    totalCount: availableUnimported.length,
  } satisfies Omit<UnimportedInboxSectionProps, "heading">;

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
            change — or add an un-imported pull request from a manual
            repository.
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

      <section className="mt-8">
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
                {(hasManualRepositories || unimportedPullRequests.isError) && (
                  <WorkTab
                    label="Un-imported"
                    count={workCounts.unimported}
                    dot="bg-coral"
                    selected={workView === "unimported"}
                    onSelect={() => setWorkView("unimported")}
                  />
                )}
              </nav>
              {(hasImportedWork ||
                workView === "reviewed" ||
                workView === "closed" ||
                workView === "removed") && (
                <>
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
                </>
              )}
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
                {listedCount === listedTotal
                  ? `${listedTotal} pull requests`
                  : `${listedCount} of ${listedTotal} pull requests`}
              </span>
            </div>
            {showCatchUpEmpty ? (
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
                      }}
                      className="bg-ink/35 h-9 rounded-xl border border-line px-3 text-xs outline-none transition focus:border-line-strong sm:max-w-36"
                    >
                      <option value="all">All providers</option>
                      {PROVIDER_NAMES.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerLabel(provider)}
                        </option>
                      ))}
                    </select>
                    <RepositoryFilter
                      onChange={setRepositoryFilter}
                      providerFilter={providerFilter}
                      repositories={repositories}
                      selected={repositoryFilter}
                    />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={showDrafts}
                      aria-label="Show draft pull requests"
                      title={
                        showDrafts
                          ? "Hide draft pull requests"
                          : "Show draft pull requests"
                      }
                      onClick={() => setShowDrafts((current) => !current)}
                      className="bg-ink/35 flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 text-xs outline-none transition hover:border-line-strong focus-visible:border-line-strong"
                    >
                      <span className="text-mist pointer-events-none">
                        Drafts
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none relative block h-5 w-9 rounded-full border transition",
                          showDrafts
                            ? "border-lime bg-lime"
                            : "border-line bg-surface-subtle",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full shadow-sm transition-[left]",
                            showDrafts
                              ? "left-[1.125rem] bg-accent-foreground"
                              : "left-0.5 bg-cloud",
                          )}
                        />
                      </span>
                    </button>
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

                {workView === "unimported" ? (
                  <UnimportedInboxSection {...unimportedSectionProps} />
                ) : visibleItems.length === 0 &&
                  !(workView === "all" && visiblePreparationCount > 0) &&
                  !(
                    workView === "all" &&
                    (availableUnimported.length > 0 || hasUnimportedQueryError)
                  ) ? (
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
                          : draftsHidden
                            ? "Draft pull requests are hidden"
                            : "No pull requests match"}
                      </h3>
                      <p className="text-mist mt-1 text-xs">
                        {sourceItems.length === 0
                          ? "This history stays here so you can return to it later."
                          : draftsHidden
                            ? "Turn on Drafts to include them in this list."
                            : "Try another repository, provider, or search."}
                      </p>
                      {draftsHidden ? (
                        <button
                          type="button"
                          onClick={() => setShowDrafts(true)}
                          className="text-lime mt-4 text-xs font-medium hover:underline"
                        >
                          Show drafts
                        </button>
                      ) : (
                        filtersActive && (
                          <button
                            type="button"
                            onClick={clearFilters}
                            className="text-lime mt-4 text-xs font-medium hover:underline"
                          >
                            Clear filters
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {workView === "all" && visiblePreparationCount > 0 && (
                      <ReviewPreparationList
                        failedSyncs={visibleFailedSyncs}
                        synchronizing={visibleSynchronizing}
                        retryingKey={
                          pendingUnimportedKey ??
                          (prepareReview.isPending
                            ? `${prepareReview.variables?.repositoryId}:${prepareReview.variables?.number}`
                            : undefined)
                        }
                        onRetry={(sync) =>
                          prepareReview.mutate({
                            repositoryId: sync.repositoryId,
                            number: sync.pullRequestNumber,
                          })
                        }
                      />
                    )}
                    {visibleItems.length > 0 && (
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
                    {workView === "all" &&
                      (availableUnimported.length > 0 ||
                        unimportedPullRequests.isError ||
                        (unimportedPullRequests.data?.errors.length ?? 0) >
                          0) && (
                        <UnimportedInboxSection
                          {...unimportedSectionProps}
                          heading
                        />
                      )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </PageContainer>
  );
}

/** Renders un-imported pull requests with prepare actions and load errors. */
function UnimportedInboxSection({
  draftsHidden,
  errorMessage,
  errors,
  filtersActive,
  heading = false,
  isError,
  isLoading,
  onClearFilters,
  onPrepare,
  onRetry,
  onShowDrafts,
  pendingKey,
  pullRequests,
  totalCount,
}: UnimportedInboxSectionProps) {
  return (
    <div className="space-y-3">
      {heading && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">Un-imported PRs</h3>
            <p className="text-mist mt-1 text-xs">
              Open changes from repositories you prepare by hand.
            </p>
          </div>
          <span className="text-fog text-xs tabular-nums">
            {pullRequests.length === totalCount
              ? `${totalCount} pull requests`
              : `${pullRequests.length} of ${totalCount} pull requests`}
          </span>
        </div>
      )}
      {isError && (
        <div
          role="alert"
          className="border-coral/25 bg-coral/[.055] flex items-start gap-3 rounded-xl border px-4 py-3"
        >
          <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Un-imported pull requests could not be loaded
            </p>
            <p className="text-mist mt-1 text-[11px] leading-5">
              {errorMessage ??
                "The provider could not list open pull requests."}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      )}
      {errors.map((error) => (
        <div
          key={error.repositoryId}
          role="alert"
          className="border-coral/25 bg-coral/[.055] flex items-start gap-3 rounded-xl border px-4 py-3"
        >
          <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-xs font-medium">
              {error.repositoryOwner}/{error.repositoryName} could not be
              checked
            </p>
            <p className="text-mist mt-1 text-[11px] leading-5">
              {error.message}
            </p>
          </div>
        </div>
      ))}
      {isLoading ? (
        <div className="bg-surface/45 grid min-h-40 place-items-center rounded-2xl border border-dashed border-line-strong">
          <Loader2 className="text-cyan size-4 animate-spin" />
        </div>
      ) : pullRequests.length === 0 ? (
        <div className="bg-surface/45 grid min-h-40 place-items-center rounded-2xl border border-dashed border-line-strong p-6 text-center">
          <div>
            <GitPullRequest className="text-fog mx-auto size-5" />
            <h3 className="mt-3 text-sm font-medium">
              {totalCount === 0
                ? "No un-imported pull requests"
                : draftsHidden
                  ? "Draft pull requests are hidden"
                  : "No pull requests match"}
            </h3>
            <p className="text-mist mt-1 text-xs">
              {totalCount === 0
                ? "Every open pull request from your manual repositories is already in the inbox."
                : draftsHidden
                  ? "Turn on Drafts to include them in this list."
                  : "Try another repository, provider, or search."}
            </p>
            {draftsHidden ? (
              <button
                type="button"
                onClick={onShowDrafts}
                className="text-lime mt-4 text-xs font-medium hover:underline"
              >
                Show drafts
              </button>
            ) : (
              filtersActive &&
              totalCount > 0 && (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="text-lime mt-4 text-xs font-medium hover:underline"
                >
                  Clear filters
                </button>
              )
            )}
          </div>
        </div>
      ) : (
        <UnimportedPullRequestList
          onPrepare={onPrepare}
          pendingKey={pendingKey}
          pullRequests={pullRequests}
        />
      )}
    </div>
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
