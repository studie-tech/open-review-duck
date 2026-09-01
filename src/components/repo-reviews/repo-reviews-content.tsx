"use client";

import {
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Code2,
  Download,
  FileCheck2,
  GitBranch,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  type CommandCenterItem,
  ShortcutHint,
} from "~/components/command-center";
import { usePendingNavigation } from "~/components/navigation-progress";
import { useRegisterPageCommands } from "~/components/page-command-center";
import { PageContainer } from "~/components/page-container";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import {
  clampToClientClock,
  hydratedQueryOptions,
} from "~/lib/hydration-clock";
import { providerLabel } from "~/lib/provider-labels";
import { formatRelativeTime, useRelativeClock } from "~/lib/relative-time";
import {
  repositoryReportFilename,
  repositoryReviewReport,
} from "~/lib/repository-review-report";
import {
  activeRunStatuses,
  followActiveRepositorySyncs,
  hasActiveRepositoryRun,
  mergeRepositoryRunProgress,
} from "~/lib/repository-run-progress";
import { repositorySyncActivity } from "~/lib/repository-sync-progress";
import { shortRevision } from "~/lib/review-revision";
import { cockpitShortcuts } from "~/lib/review-shortcuts";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Monitors = RouterOutputs["repoReviews"]["list"];
type Repositories = RouterOutputs["provider"]["listImportedRepositories"];
type Section = "overview" | "findings" | "rules" | "history";
const EMPTY_UUID = "00000000-0000-4000-8000-000000000000";

const sectionShortcuts = {
  overview: cockpitShortcuts.overview,
  findings: cockpitShortcuts.findings,
  rules: cockpitShortcuts.rules,
  history: cockpitShortcuts.history,
} as const;

/** Renders a durable review run's compact live state. */
function RunStatus({ status, progress }: { status: string; progress: number }) {
  const active = activeRunStatuses.has(status);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-mist">
      <span
        className={cn(
          "size-2 rounded-full",
          active
            ? "animate-pulse bg-amber-400"
            : status === "completed"
              ? "bg-lime"
              : status === "failed"
                ? "bg-red-400"
                : "bg-mist/50",
        )}
      />
      {active ? `${progress}%` : status.replaceAll("_", " ")}
    </span>
  );
}

/** Renders the repository review cockpit and its action workflows. */
export function RepoReviewsContent({
  initialMonitors,
  initialRepositories,
  initialMonitorId,
  fetchedAt,
}: {
  initialMonitors: Monitors;
  initialRepositories: Repositories;
  initialMonitorId?: string;
  fetchedAt: number;
}) {
  const utils = api.useUtils();
  const now = useRelativeClock(fetchedAt);
  const monitorsQuery = api.repoReviews.list.useQuery(undefined, {
    ...hydratedQueryOptions(initialMonitors, fetchedAt),
    refetchInterval: followActiveRepositorySyncs,
  });
  const monitors = monitorsQuery.data ?? initialMonitors;
  const runsActive = hasActiveRepositoryRun(monitors);
  const runProgressQuery = api.repoReviews.runProgress.useQuery(undefined, {
    enabled: runsActive,
    refetchInterval: runsActive ? 1_500 : false,
  });
  const runProgress = runProgressQuery.data;
  // `list` reads every review unit and snapshot file of every monitor, and an
  // AI run stays live for minutes, so its status and percentage arrive through
  // the narrow progress read and are folded into the same cache.
  useEffect(() => {
    if (!runProgress) return;
    utils.repoReviews.list.setData(
      undefined,
      (cached) => cached && mergeRepositoryRunProgress(cached, runProgress),
    );
  }, [runProgress, utils]);
  const repositoriesQuery = api.provider.listImportedRepositories.useQuery(
    undefined,
    {
      initialData: initialRepositories,
      initialDataUpdatedAt: clampToClientClock(fetchedAt),
    },
  );
  const [selectedMonitorId, setSelectedMonitorId] = useState(
    initialMonitors.some(({ id }) => id === initialMonitorId)
      ? initialMonitorId
      : initialMonitors[0]?.id,
  );
  const [section, setSection] = useState<Section>("overview");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedMonitor =
    monitors.find(({ id }) => id === selectedMonitorId) ?? monitors[0];

  useEffect(() => {
    if (!selectedMonitorId && monitors[0]) setSelectedMonitorId(monitors[0].id);
    if (
      selectedMonitorId &&
      !monitors.some(({ id }) => id === selectedMonitorId)
    ) {
      setSelectedMonitorId(monitors[0]?.id);
    }
  }, [monitors, selectedMonitorId]);

  const visibleMonitors = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return monitors;
    return monitors.filter((monitor) =>
      `${monitor.repositoryOwner}/${monitor.repositoryName} ${monitor.branch}`
        .toLowerCase()
        .includes(query),
    );
  }, [monitors, search]);

  const stepMonitor = useMemo(
    () => (direction: -1 | 1) => {
      if (visibleMonitors.length < 2) return;
      const index = visibleMonitors.findIndex(
        ({ id }) => id === selectedMonitor?.id,
      );
      const next =
        visibleMonitors[
          (index + direction + visibleMonitors.length) % visibleMonitors.length
        ];
      if (next) {
        setSelectedMonitorId(next.id);
        setSection("overview");
      }
    },
    [selectedMonitor?.id, visibleMonitors],
  );

  /** Cockpit-level quick actions; monitor actions live in RepositoryCockpit. */
  const commands = useMemo<CommandCenterItem[]>(
    () => [
      {
        id: "cockpit-add-repository",
        label: "Add repository",
        description: "Follow another repository branch with repo reviews",
        group: "Repository actions",
        icon: <Plus className="size-4" />,
        shortcut: cockpitShortcuts.addRepository,
        onSelect: () => setAddOpen(true),
      },
      {
        id: "cockpit-search",
        label: "Find a monitored repository",
        group: "Repository actions",
        icon: <Search className="size-4" />,
        shortcut: cockpitShortcuts.search,
        onSelect: () => searchInputRef.current?.focus(),
      },
      {
        id: "cockpit-previous-monitor",
        label: "Previous monitored repository",
        group: "Repository navigation",
        icon: <ChevronRight className="size-4 rotate-180" />,
        shortcut: cockpitShortcuts.previousMonitor,
        disabled: visibleMonitors.length < 2,
        onSelect: () => stepMonitor(-1),
      },
      {
        id: "cockpit-next-monitor",
        label: "Next monitored repository",
        group: "Repository navigation",
        icon: <ChevronRight className="size-4" />,
        shortcut: cockpitShortcuts.nextMonitor,
        disabled: visibleMonitors.length < 2,
        onSelect: () => stepMonitor(1),
      },
      ...(
        [
          [
            "overview",
            "Show overview",
            "Reading progress and primary workflows",
          ],
          [
            "findings",
            "Show findings",
            "Review-run findings and fixing briefs",
          ],
          ["rules", "Show rules", "Versioned compliance conventions"],
          ["history", "Show history", "Past code audits and compliance checks"],
        ] as Array<[Section, string, string]>
      ).map(([target, label, description]) => ({
        id: `cockpit-section-${target}`,
        label,
        description,
        group: "Repository navigation",
        shortcut: sectionShortcuts[target],
        disabled: !selectedMonitor,
        onSelect: () => setSection(target),
      })),
    ],
    [selectedMonitor, stepMonitor, visibleMonitors.length],
  );
  useRegisterPageCommands(commands);

  return (
    <PageContainer>
      <header className="mb-8 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-lime">
            <BookOpenCheck className="size-4" />
            Living repository knowledge
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-cloud sm:text-4xl">
            Repo reviews
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-mist">
            Read a codebase once, keep up with what changed, and run focused
            audits without losing your place.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="size-4" /> Add repository
          <ShortcutHint shortcut={cockpitShortcuts.addRepository} />
        </Button>
      </header>

      {monitors.length === 0 ? (
        <EmptyState
          repositories={repositoriesQuery.data ?? []}
          onAdd={() => setAddOpen(true)}
        />
      ) : (
        <div className="grid min-h-[680px] overflow-hidden rounded-3xl border border-line bg-panel shadow-[0_24px_80px_var(--app-shadow)] lg:grid-cols-[310px_minmax(0,1fr)]">
          <aside className="border-b border-line bg-surface-subtle/45 p-4 lg:border-r lg:border-b-0">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSearch("");
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Find a repository"
                aria-label="Find a monitored repository"
                className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm text-cloud outline-none placeholder:text-mist focus:border-lime/50"
              />
            </label>
            <div className="mt-4 space-y-1.5">
              {visibleMonitors.length === 0 && search.trim() && (
                <div
                  className="rounded-2xl border border-dashed border-line px-4 py-6 text-center"
                  aria-live="polite"
                >
                  <Search className="mx-auto size-5 text-fog" />
                  <p className="mt-3 text-xs font-medium text-cloud">
                    No monitored repositories match “{search.trim()}”.
                  </p>
                  <button
                    type="button"
                    className="mt-3 text-xs font-medium text-lime hover:text-lime-bright"
                    onClick={() => setSearch("")}
                  >
                    Clear filter
                  </button>
                </div>
              )}
              {visibleMonitors.map((monitor) => {
                const selected = monitor.id === selectedMonitor?.id;
                const syncing = Boolean(monitor.activeSync);
                return (
                  <button
                    key={monitor.id}
                    type="button"
                    onClick={() => {
                      setSelectedMonitorId(monitor.id);
                      setSection("overview");
                    }}
                    className={cn(
                      "group w-full rounded-2xl border px-3.5 py-3 text-left transition",
                      selected
                        ? "border-lime/35 bg-lime/8"
                        : "border-transparent hover:border-line hover:bg-surface",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          "mt-1 size-2.5 shrink-0 rounded-full",
                          syncing
                            ? "animate-pulse bg-amber-400"
                            : monitor.lastError
                              ? "bg-red-400"
                              : "bg-lime",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-cloud">
                          {monitor.repositoryName}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 truncate text-xs text-mist">
                          <GitBranch className="size-3" /> {monitor.branch}
                        </span>
                      </span>
                      {(monitor.progress.unseen > 0 || syncing) && (
                        <Badge className="border-lime/25 bg-lime/8 text-lime">
                          {syncing
                            ? `${monitor.activeSync?.progress ?? 0}%`
                            : monitor.progress.unseen}
                        </Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {selectedMonitor && (
            <RepositoryCockpit
              key={selectedMonitor.id}
              monitor={selectedMonitor}
              section={section}
              onSection={setSection}
              onRemoved={() => setSelectedMonitorId(undefined)}
              now={now}
            />
          )}
        </div>
      )}

      {addOpen && (
        <AddRepositoryDialog
          repositories={repositoriesQuery.data ?? []}
          monitors={monitors}
          onClose={() => setAddOpen(false)}
          onAdded={(monitorId) => {
            setSelectedMonitorId(monitorId);
            setAddOpen(false);
            void utils.repoReviews.list.invalidate();
          }}
        />
      )}
    </PageContainer>
  );
}

/** Guides an empty workspace toward its first repository monitor. */
function EmptyState({
  repositories,
  onAdd,
}: {
  repositories: Repositories;
  onAdd: () => void;
}) {
  return (
    <section className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-line bg-panel px-6 text-center">
      <div className="max-w-md">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-lime/20 bg-lime/8 text-lime">
          <GitBranch className="size-7" />
        </span>
        <h2 className="mt-6 text-xl font-semibold text-cloud">
          Build your repository shelf
        </h2>
        <p className="mt-2 text-sm leading-6 text-mist">
          Add a repository and branch. The first sync maps the complete
          codebase; later revisions preserve what you read and surface only what
          is new.
        </p>
        {repositories.length > 0 ? (
          <Button className="mt-6" onClick={onAdd}>
            <Plus className="size-4" /> Add your first repository
          </Button>
        ) : (
          <Button className="mt-6" asChild>
            <Link href="/settings/providers">Connect a code provider</Link>
          </Button>
        )}
      </div>
    </section>
  );
}

/** Renders the selected monitored branch and its cockpit sections. */
function RepositoryCockpit({
  monitor,
  section,
  onSection,
  onRemoved,
  now,
}: {
  monitor: Monitors[number];
  section: Section;
  onSection: (section: Section) => void;
  onRemoved: () => void;
  now: number;
}) {
  const utils = api.useUtils();
  const { navigate } = usePendingNavigation();
  const [findingJobId, setFindingJobId] = useState<string>();
  const sync = api.repoReviews.sync.useMutation({
    onSuccess: () => {
      toast.success("Repository check queued");
      void utils.repoReviews.list.invalidate();
    },
    onError: (error) =>
      toast.error("Could not check repository", { description: error.message }),
  });
  const remove = api.repoReviews.remove.useMutation({
    onSuccess: () => {
      toast.success("Repository monitor removed");
      onRemoved();
      void utils.repoReviews.list.invalidate();
    },
    onError: (error) =>
      toast.error("Could not remove repository", {
        description: error.message,
      }),
  });
  const rules = api.repoReviews.rules.useQuery({ monitorId: monitor.id });
  const enabledRuleCount =
    rules.data?.filter(({ enabled }) => enabled).length ?? 0;
  // Owned here rather than in Overview so the keyboard command center can
  // start the same runs the cards do.
  const run = api.repoReviews.startRun.useMutation({
    onSuccess: (result, variables) => {
      toast.success(
        variables.purpose === "code"
          ? "Code audit started"
          : "Compliance check started",
      );
      void Promise.all([
        utils.repoReviews.list.invalidate(),
        utils.repoReviews.history.invalidate({ monitorId: monitor.id }),
      ]);
      setFindingJobId(result.job.id);
      onSection("findings");
    },
    onError: (error) =>
      toast.error("Could not start review", { description: error.message }),
  });
  /** Starts a code audit or compliance run for this monitor. */
  const runStart = run.mutate;
  const syncStart = sync.mutate;
  const startRun = useCallback(
    (purpose: "code" | "compliance") => {
      if (purpose === "compliance" && enabledRuleCount === 0) {
        onSection("rules");
        return;
      }
      runStart({ monitorId: monitor.id, purpose });
    },
    [enabledRuleCount, monitor.id, onSection, runStart],
  );

  /** Monitor-level quick actions; page-wide actions live in RepoReviewsContent. */
  const commands = useMemo<CommandCenterItem[]>(
    () => [
      {
        id: "cockpit-open-reader",
        label: monitor.progress.signed
          ? "Continue reading this repository"
          : "Start reading this repository",
        description: "Open the structured reading path for this snapshot",
        group: "Repository actions",
        icon: <BookOpenCheck className="size-4" />,
        shortcut: cockpitShortcuts.openReader,
        disabled: !monitor.snapshot,
        onSelect: () => navigate(`/repo-reviews/${monitor.id}/read`),
      },
      {
        id: "cockpit-check-now",
        label: "Check repository now",
        description: "Compare the branch head and refresh the snapshot",
        group: "Repository actions",
        icon: <RefreshCw className="size-4" />,
        shortcut: cockpitShortcuts.checkNow,
        disabled: Boolean(monitor.activeSync) || sync.isPending,
        onSelect: () => syncStart({ monitorId: monitor.id }),
      },
      {
        id: "cockpit-run-code-audit",
        label: "Run code audit",
        description: "Review the full branch with the evidence-based reviewer",
        group: "Repository actions",
        icon: <Code2 className="size-4" />,
        shortcut: cockpitShortcuts.runCodeAudit,
        disabled:
          !monitor.snapshot ||
          activeRunStatuses.has(monitor.latestCodeRun?.status ?? ""),
        onSelect: () => startRun("code"),
      },
      {
        id: "cockpit-run-compliance",
        label:
          enabledRuleCount === 0
            ? "Set up compliance rules"
            : "Check compliance rules",
        description:
          "Verify versioned conventions with file agents and a survey",
        group: "Repository actions",
        icon: <ShieldCheck className="size-4" />,
        shortcut: cockpitShortcuts.runCompliance,
        disabled:
          !monitor.snapshot ||
          rules.isLoading ||
          activeRunStatuses.has(monitor.latestComplianceRun?.status ?? ""),
        onSelect: () => startRun("compliance"),
      },
    ],
    [
      enabledRuleCount,
      monitor,
      navigate,
      rules.isLoading,
      startRun,
      sync.isPending,
      syncStart,
    ],
  );
  useRegisterPageCommands(commands);

  return (
    <section className="min-w-0">
      <div className="border-b border-line px-5 pt-5 sm:px-7 sm:pt-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-cloud">
                {monitor.repositoryOwner}/{monitor.repositoryName}
              </h2>
              <Badge>{providerLabel(monitor.provider)}</Badge>
              {monitor.activeSync && (
                <Badge
                  className="border-amber-400/25 bg-amber-400/8 text-amber-300"
                  role="status"
                  aria-live="polite"
                >
                  <span className="mr-1 size-1.5 animate-pulse rounded-full bg-amber-300" />
                  {repositorySyncActivity(monitor.activeSync.progress)} ·{" "}
                  {monitor.activeSync.progress}%
                </Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-mist">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" /> {monitor.branch}
              </span>
              <span className="font-mono">
                {monitor.snapshot
                  ? shortRevision(monitor.snapshot.headSha)
                  : "Waiting"}
              </span>
              <span>
                Checked{" "}
                {monitor.lastCheckedAt
                  ? formatRelativeTime(monitor.lastCheckedAt, now)
                  : "Not yet"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={sync.isPending || Boolean(monitor.activeSync)}
              disabled={Boolean(monitor.activeSync)}
              onClick={() => sync.mutate({ monitorId: monitor.id })}
            >
              <RefreshCw className="size-3.5" />
              {monitor.activeSync || sync.isPending ? "Checking…" : "Check now"}
              <ShortcutHint
                shortcut={cockpitShortcuts.checkNow}
                className="max-sm:hidden"
              />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              loading={remove.isPending}
              disabled={remove.isPending}
              aria-label="Remove repository monitor"
              onClick={() => {
                if (
                  window.confirm(
                    `Stop monitoring ${monitor.repositoryName}/${monitor.branch}? Review history for this monitor will be removed.`,
                  )
                ) {
                  remove.mutate({ monitorId: monitor.id });
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {monitor.lastError && !monitor.activeSync && (
          <div className="mt-4 rounded-xl border border-red-400/20 bg-red-400/8 px-4 py-3 text-xs text-red-200">
            {monitor.lastError}
          </div>
        )}
        <nav
          className="mt-6 flex gap-6 overflow-x-auto"
          aria-label="Repository review sections"
        >
          {(["overview", "findings", "rules", "history"] as const).map(
            (item) => (
              <button
                key={item}
                type="button"
                aria-current={section === item ? "page" : undefined}
                onClick={() => onSection(item)}
                className={cn(
                  "flex items-center gap-2 border-b-2 pb-3 text-sm font-medium capitalize transition",
                  section === item
                    ? "border-lime text-cloud"
                    : "border-transparent text-mist hover:text-cloud",
                )}
              >
                {item}
                <ShortcutHint
                  shortcut={sectionShortcuts[item]}
                  className="max-sm:hidden"
                />
              </button>
            ),
          )}
        </nav>
      </div>

      <div className="p-5 sm:p-7">
        {section === "overview" && (
          <Overview
            monitor={monitor}
            onSection={onSection}
            rules={rules}
            enabledRuleCount={enabledRuleCount}
            startRun={startRun}
            runPendingPurpose={
              run.isPending ? (run.variables?.purpose ?? undefined) : undefined
            }
            now={now}
          />
        )}
        {section === "findings" && (
          <Findings monitor={monitor} requestedJobId={findingJobId} />
        )}
        {section === "rules" && <Rules monitor={monitor} />}
        {section === "history" && (
          <History
            monitor={monitor}
            onOpenFindings={(jobId) => {
              setFindingJobId(jobId);
              onSection("findings");
            }}
          />
        )}
      </div>
    </section>
  );
}

/** Presents the three primary repository-review workflows. */
function Overview({
  monitor,
  onSection,
  rules,
  enabledRuleCount,
  startRun,
  runPendingPurpose,
  now,
}: {
  monitor: Monitors[number];
  onSection: (section: Section) => void;
  rules: {
    isLoading: boolean;
  };
  enabledRuleCount: number;
  startRun: (purpose: "code" | "compliance") => void;
  runPendingPurpose?: "code" | "compliance";
  now: number;
}) {
  const total = monitor.progress.total;
  const percent = total
    ? Math.round((monitor.progress.signed / total) * 100)
    : 0;
  const coverage = monitor.coverage ?? {
    files: 0,
    reviewableFiles: 0,
    nonReviewableFiles: 0,
  };
  return (
    <div className="space-y-7">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Read"
          value={`${percent}%`}
          detail={`${monitor.progress.signed} of ${total} units`}
        />
        <Metric
          label="Unseen"
          value={String(monitor.progress.unseen)}
          detail={
            monitor.progress.changed
              ? `${monitor.progress.changed} changed since sign-off`
              : "Current revision"
          }
          accent={monitor.progress.unseen > 0}
        />
        <Metric
          label="Snapshot"
          value={`v${monitor.snapshot?.version ?? 0}`}
          detail={
            monitor.snapshot
              ? formatRelativeTime(monitor.snapshot.createdAt, now)
              : "Preparing first snapshot"
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ActionCard
          icon={BookOpenCheck}
          eyebrow="Understand"
          title="Complete repo review"
          description="Walk the codebase in a structured reading path. Sign-offs survive unchanged revisions; changed units return to your queue."
          action={
            monitor.snapshot ? (
              <Button asChild className="w-full">
                <Link href={`/repo-reviews/${monitor.id}/read`}>
                  {monitor.progress.signed
                    ? "Continue reading"
                    : "Start reading"}
                  <LinkPendingSpinner />
                  <ShortcutHint
                    shortcut={cockpitShortcuts.openReader}
                    className="ml-auto"
                  />
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            ) : (
              <Button className="w-full" disabled>
                Preparing repository…
              </Button>
            )
          }
        />
        <ActionCard
          icon={Code2}
          eyebrow="Inspect"
          title="Code audit"
          description="Launch the existing evidence-based reviewer across the full branch, then curate its findings into a fixing brief."
          status={
            monitor.latestCodeRun ? (
              <RunStatus
                status={monitor.latestCodeRun.status}
                progress={monitor.latestCodeRun.progress}
              />
            ) : undefined
          }
          action={
            <Button
              variant="secondary"
              className="w-full"
              loading={
                runPendingPurpose === "code" ||
                activeRunStatuses.has(monitor.latestCodeRun?.status ?? "")
              }
              disabled={
                !monitor.snapshot ||
                activeRunStatuses.has(monitor.latestCodeRun?.status ?? "")
              }
              onClick={() => startRun("code")}
            >
              <Code2 className="size-4" />
              {runPendingPurpose === "code" ||
              activeRunStatuses.has(monitor.latestCodeRun?.status ?? "")
                ? "Running…"
                : "Run code audit"}
              <ShortcutHint
                shortcut={cockpitShortcuts.runCodeAudit}
                className="ml-auto"
              />
            </Button>
          }
        />
        <ActionCard
          icon={ShieldCheck}
          eyebrow="Enforce"
          title="Compliance"
          description="Check your versioned conventions with file agents and a repository-wide survey for architecture rules."
          status={
            monitor.latestComplianceRun ? (
              <RunStatus
                status={monitor.latestComplianceRun.status}
                progress={monitor.latestComplianceRun.progress}
              />
            ) : undefined
          }
          action={
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Button
                variant="secondary"
                loading={
                  runPendingPurpose === "compliance" ||
                  activeRunStatuses.has(
                    monitor.latestComplianceRun?.status ?? "",
                  )
                }
                disabled={
                  !monitor.snapshot ||
                  rules.isLoading ||
                  activeRunStatuses.has(
                    monitor.latestComplianceRun?.status ?? "",
                  )
                }
                onClick={() => startRun("compliance")}
              >
                <ShieldCheck className="size-4" />
                {runPendingPurpose === "compliance" ||
                activeRunStatuses.has(monitor.latestComplianceRun?.status ?? "")
                  ? "Checking…"
                  : enabledRuleCount === 0
                    ? "Set up rules"
                    : "Check rules"}
                <ShortcutHint
                  shortcut={cockpitShortcuts.runCompliance}
                  className="ml-auto"
                />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Manage compliance rules"
                onClick={() => onSection("rules")}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          }
        />
      </div>

      <div className="rounded-2xl border border-line bg-surface-subtle/35 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-cloud">
              How updates work
            </h3>
            <p className="mt-1 text-xs leading-5 text-mist">
              Every branch head is captured as a complete immutable snapshot.
              Semantic sign-offs carry forward only when a unit and its
              dependencies remain safe; changed knowledge becomes unseen again.
            </p>
          </div>
          <CheckCircle2 className="size-6 shrink-0 text-lime" />
        </div>
      </div>
      {coverage.nonReviewableFiles > 0 && (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/7 px-5 py-4 text-xs leading-5 text-amber-100">
          {coverage.nonReviewableFiles} of {coverage.files} tracked files are
          outside the reading path because they are binary, unsupported, or
          beyond the source budget. Repository audits record those files as
          waived coverage instead of silently reviewing partial content.
        </div>
      )}
    </div>
  );
}

/** Renders one compact repository metric. */
function Metric({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-mist">
        {label}
      </div>
      <div
        className={cn(
          "mt-2 text-2xl font-semibold",
          accent ? "text-lime" : "text-cloud",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-mist">{detail}</div>
    </div>
  );
}

/** Renders one primary cockpit action with optional durable status. */
function ActionCard({
  icon: Icon,
  eyebrow,
  title,
  description,
  action,
  status,
}: {
  icon: typeof Code2;
  eyebrow: string;
  title: string;
  description: string;
  action: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <article className="flex min-h-64 flex-col rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl border border-lime/15 bg-lime/8 text-lime">
          <Icon className="size-5" />
        </span>
        {status}
      </div>
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-lime">
        {eyebrow}
      </div>
      <h3 className="mt-1 text-base font-semibold text-cloud">{title}</h3>
      <p className="mt-2 flex-1 text-xs leading-5 text-mist">{description}</p>
      <div className="mt-5">{action}</div>
    </article>
  );
}

/** Renders run findings and composes a selected fixing report. */
function Findings({
  monitor,
  requestedJobId,
}: {
  monitor: Monitors[number];
  requestedJobId?: string;
}) {
  const history = api.repoReviews.history.useQuery(
    { monitorId: monitor.id },
    {
      refetchInterval: (query) =>
        query.state.data?.some(({ status }) => activeRunStatuses.has(status))
          ? 1_500
          : false,
    },
  );
  const [jobId, setJobId] = useState<string | undefined>(requestedJobId);
  const utils = api.useUtils();
  const runs = history.data ?? [];
  const selectedJobId = runs.some(({ id }) => id === jobId)
    ? jobId
    : runs[0]?.id;
  const selectedRun = runs.find(({ id }) => id === selectedJobId);
  const deleteReport = api.repoReviews.deleteReport.useMutation({
    onSuccess: async ({ deletedId }) => {
      let nextJobId: string | undefined;
      utils.repoReviews.history.setData(
        { monitorId: monitor.id },
        (current) => {
          const remaining = current?.filter(({ id }) => id !== deletedId);
          nextJobId = remaining?.[0]?.id;
          return remaining;
        },
      );
      setSelected(new Set());
      setJobId(nextJobId);
      await Promise.all([
        utils.repoReviews.list.invalidate(),
        utils.repoReviews.history.invalidate({ monitorId: monitor.id }),
        utils.repoReviews.findings.invalidate(),
      ]);
      toast.success("Repository report deleted");
    },
    onError: (error) => toast.error(error.message),
  });
  // This payload carries the decrypted title and body of every finding in the
  // run, so it polls slower than the run status: the `history` read above keeps
  // progress live at 1.5s. The interval follows the status inside the payload
  // so the run's last findings always arrive before the poll winds down.
  const findings = api.repoReviews.findings.useQuery(
    { monitorId: monitor.id, jobId: selectedJobId ?? EMPTY_UUID },
    {
      enabled: Boolean(selectedJobId),
      refetchInterval: (query) =>
        query.state.data && activeRunStatuses.has(query.state.data.status)
          ? 4_000
          : false,
    },
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const payload = findings.data;
  // Keep one stable identity for the effect below; `payload?.findings ?? []`
  // would mint a fresh array every render and run it on each pass.
  const payloadFindings = payload?.findings;
  const visibleFindings = payloadFindings ?? [];
  const waivedItems =
    payload?.items.filter(({ state }) => state === "waived") ?? [];
  useEffect(() => {
    if (!payloadFindings) return;
    const visibleIds = new Set(payloadFindings.map(({ id }) => id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [payloadFindings]);
  const purpose =
    selectedRun?.reviewPurpose === "compliance" ? "compliance" : "code";
  /** Compiles the current finding selection into a fixing brief. */
  const report = () =>
    repositoryReviewReport({
      repository: `${monitor.repositoryOwner}/${monitor.repositoryName}`,
      branch: monitor.branch,
      revision:
        monitor.snapshot?.headSha ?? monitor.currentHeadSha ?? "unknown",
      purpose,
      findings: visibleFindings.filter(({ id }) => selected.has(id)),
    });
  /** Copies the current fixing brief to the clipboard. */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      toast.success(
        `Copied ${selected.size} finding${selected.size === 1 ? "" : "s"}`,
      );
    } catch {
      toast.error("Could not copy the report");
    }
  };
  /** Downloads the current fixing brief as Markdown. */
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([report()], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = repositoryReportFilename(
      `${monitor.repositoryOwner}-${monitor.repositoryName}`,
      monitor.branch,
      purpose,
    );
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (runs.length === 0 && !history.isLoading) {
    return (
      <div className="rounded-2xl border border-dashed border-line py-20 text-center">
        <FileCheck2 className="mx-auto size-8 text-mist" />
        <h3 className="mt-4 font-semibold text-cloud">No review runs yet</h3>
        <p className="mt-2 text-sm text-mist">
          Start a code audit or compliance check from Overview.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <select
          aria-label="Review run"
          value={selectedJobId ?? ""}
          onChange={(event) => {
            setJobId(event.target.value);
            setSelected(new Set());
          }}
          className="h-10 w-full min-w-0 rounded-xl border border-line bg-surface px-3 text-sm text-cloud outline-none focus:border-lime/50 md:flex-1"
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id} suppressHydrationWarning>
              {run.reviewPurpose === "compliance" ? "Compliance" : "Code audit"}{" "}
              · {run.status.replaceAll("_", " ")} ·{" "}
              {run.createdAt.toLocaleString()}
            </option>
          ))}
        </select>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0}
            onClick={copy}
          >
            <Clipboard className="size-3.5" /> Copy report
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0}
            onClick={download}
          >
            <Download className="size-3.5" /> Download .md
          </Button>
          <Button
            size="icon"
            variant="ghost"
            loading={deleteReport.isPending}
            disabled={
              !selectedRun ||
              activeRunStatuses.has(selectedRun.status) ||
              deleteReport.isPending
            }
            aria-label="Delete repository report"
            title={
              selectedRun && activeRunStatuses.has(selectedRun.status)
                ? "A running report cannot be deleted"
                : "Delete this report and its findings"
            }
            onClick={() => {
              if (
                selectedRun &&
                window.confirm(
                  "Delete this repository report and all of its findings? This cannot be undone.",
                )
              ) {
                deleteReport.mutate({
                  monitorId: monitor.id,
                  jobId: selectedRun.id,
                });
              }
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {selectedRun && activeRunStatuses.has(selectedRun.status) && (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/7 p-4">
          <div className="flex items-center justify-between text-xs text-amber-200">
            <span>Reviewing repository snapshot…</span>
            <span>{selectedRun.progress}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/30">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${selectedRun.progress}%` }}
            />
          </div>
        </div>
      )}
      {findings.error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/8 p-4 text-xs text-red-200">
          Findings could not be loaded. {findings.error.message}
        </div>
      )}
      {payload && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Metric
            label="Findings"
            value={String(payload.findings.length)}
            detail={`${payload.coverage.completed} items covered`}
          />
          <Metric
            label="Selected"
            value={String(selected.size)}
            detail="Included in report"
            accent={selected.size > 0}
          />
          <Metric
            label="Waived"
            value={String(payload.coverage.waived)}
            detail="Explicit coverage exclusions"
          />
          <Metric
            label="Failed"
            value={String(payload.coverage.failed)}
            detail="Coverage gaps"
            accent={payload.coverage.failed > 0}
          />
        </div>
      )}
      {waivedItems.length > 0 && (
        <details className="rounded-2xl border border-line bg-surface p-4 text-xs text-mist">
          <summary className="cursor-pointer font-medium text-cloud">
            Coverage waivers ({waivedItems.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {waivedItems.map((item) => (
              <li key={item.id} className="flex min-w-0 justify-between gap-3">
                <span className="truncate font-mono">{item.path}</span>
                <span className="shrink-0">
                  {(item.reason ?? "waived").replaceAll("_", " ")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {visibleFindings.length > 0 && (
        <div className="flex items-center gap-3 border-b border-line pb-3 text-xs text-mist">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.size === visibleFindings.length}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? new Set(visibleFindings.map(({ id }) => id))
                    : new Set(),
                )
              }
              className="accent-lime"
            />
            Select all
          </label>
          <span>Choose only findings you want an agent to fix.</span>
        </div>
      )}
      <div className="space-y-3">
        {visibleFindings.map((finding) => (
          <label
            key={finding.id}
            className={cn(
              "block cursor-pointer rounded-2xl border p-4 transition",
              selected.has(finding.id)
                ? "border-lime/35 bg-lime/5"
                : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(finding.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(finding.id);
                    else next.delete(finding.id);
                    return next;
                  })
                }
                className="mt-1 accent-lime"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={cn(
                      finding.severity === "critical" ||
                        finding.severity === "high"
                        ? "border-red-400/25 text-red-300"
                        : finding.severity === "medium"
                          ? "border-amber-400/25 text-amber-300"
                          : "",
                    )}
                  >
                    {finding.severity}
                  </Badge>
                  <span className="text-xs text-mist">{finding.category}</span>
                  {finding.path && (
                    <span className="truncate font-mono text-[11px] text-mist">
                      {finding.path}
                      {finding.startLine ? `:${finding.startLine}` : ""}
                    </span>
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-cloud">
                  {finding.title}
                </h3>
                <p className="mt-1 text-xs leading-5 text-mist">
                  {finding.body}
                </p>
                {finding.existingCode && (
                  <pre className="mt-3 max-h-48 overflow-auto rounded-xl border border-line bg-ink/50 p-3 text-[11px] leading-5 text-cloud">
                    <code>{finding.existingCode}</code>
                  </pre>
                )}
              </div>
            </div>
          </label>
        ))}
      </div>
      {payload &&
        visibleFindings.length === 0 &&
        !activeRunStatuses.has(payload.status) && (
          <div className="rounded-2xl border border-line bg-surface py-16 text-center">
            <CheckCircle2 className="mx-auto size-8 text-lime" />
            <h3 className="mt-4 font-semibold text-cloud">
              No surfaced findings
            </h3>
            <p className="mt-2 text-sm text-mist">
              Review coverage and any waived files are recorded above.
            </p>
          </div>
        )}
    </div>
  );
}

/** Manages versioned file and repository compliance rules. */
function Rules({ monitor }: { monitor: Monitors[number] }) {
  const rules = api.repoReviews.rules.useQuery({ monitorId: monitor.id });
  const utils = api.useUtils();
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState({
    title: "",
    instruction: "",
    pathGlob: "**/*",
    scope: "file" as "file" | "repository",
    severity: "medium" as "critical" | "high" | "medium" | "low",
  });
  /** Restores the rule editor to its creation defaults. */
  const reset = () => {
    setEditingId(undefined);
    setForm({
      title: "",
      instruction: "",
      pathGlob: "**/*",
      scope: "file",
      severity: "medium",
    });
  };
  const add = api.repoReviews.addRule.useMutation({
    onSuccess: () => {
      toast.success("Compliance rule added");
      reset();
      void rules.refetch();
    },
    onError: (error) =>
      toast.error("Could not save rule", { description: error.message }),
  });
  const update = api.repoReviews.updateRule.useMutation({
    onMutate: ({ monitorId: _monitorId, ruleId, ...changes }) =>
      utils.repoReviews.rules.setData({ monitorId: monitor.id }, (current) =>
        current?.map((rule) =>
          rule.id === ruleId ? { ...rule, ...changes } : rule,
        ),
      ),
    onSuccess: (_result, { ruleId }) => {
      toast.success("Compliance rule updated");
      if (editingId === ruleId) reset();
      void utils.repoReviews.rules.invalidate({ monitorId: monitor.id });
    },
    onError: (error) => {
      void utils.repoReviews.rules.invalidate({ monitorId: monitor.id });
      toast.error("Could not update rule", { description: error.message });
    },
  });
  const archive = api.repoReviews.archiveRule.useMutation({
    onSuccess: (_result, { ruleId }) => {
      toast.success("Compliance rule archived");
      if (editingId === ruleId) reset();
      void rules.refetch();
    },
    onError: (error) =>
      toast.error("Could not archive rule", { description: error.message }),
  });
  /** Creates or updates the rule currently open in the editor. */
  const save = () => {
    if (editingId)
      update.mutate({ monitorId: monitor.id, ruleId: editingId, ...form });
    else add.mutate({ monitorId: monitor.id, ...form });
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="mb-4">
          <h3 className="font-semibold text-cloud">Active rules</h3>
          <p className="mt-1 text-xs leading-5 text-mist">
            File rules fan out only to matching paths. Repository rules run in
            the cross-file survey. Every run stores an immutable copy.
          </p>
        </div>
        <div className="space-y-3">
          {(rules.data ?? []).map((rule) => (
            <article
              key={rule.id}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-cloud">
                      {rule.title}
                    </h4>
                    <Badge>{rule.scope}</Badge>
                    <Badge>{rule.severity}</Badge>
                    {!rule.enabled && <Badge>paused</Badge>}
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-lime">
                    {rule.pathGlob}
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-mist">
                    {rule.instruction}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(rule.id);
                      setForm({
                        title: rule.title,
                        instruction: rule.instruction,
                        pathGlob: rule.pathGlob,
                        scope:
                          rule.scope === "repository" ? "repository" : "file",
                        severity: rule.severity,
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Archive ${rule.title}`}
                    onClick={() => {
                      if (window.confirm(`Archive “${rule.title}”?`)) {
                        archive.mutate({
                          monitorId: monitor.id,
                          ruleId: rule.id,
                        });
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <button
                type="button"
                className="mt-3 text-xs text-mist hover:text-cloud"
                onClick={() =>
                  update.mutate({
                    monitorId: monitor.id,
                    ruleId: rule.id,
                    enabled: !rule.enabled,
                  })
                }
              >
                {rule.enabled ? "Pause rule" : "Enable rule"}
              </button>
            </article>
          ))}
          {!rules.isLoading && rules.data?.length === 0 && (
            <div className="rounded-2xl border border-dashed border-line p-10 text-center text-sm text-mist">
              No compliance rules yet.
            </div>
          )}
        </div>
      </div>
      <aside className="h-fit rounded-2xl border border-line bg-surface p-5 xl:sticky xl:top-6">
        <h3 className="font-semibold text-cloud">
          {editingId ? "Edit rule" : "Write a rule"}
        </h3>
        <div className="mt-4 space-y-4">
          <Field label="Name">
            <input
              aria-label="Rule name"
              value={form.title}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
              placeholder="Utilities below routers"
              className="form-input"
            />
          </Field>
          <Field label="Instruction">
            <textarea
              aria-label="Rule instruction"
              value={form.instruction}
              onChange={(event) =>
                setForm({ ...form, instruction: event.target.value })
              }
              placeholder="In tRPC route files, declare router exports before local utility functions…"
              rows={5}
              className="form-input h-auto resize-y py-3"
            />
          </Field>
          <Field label="Applies to">
            <input
              aria-label="Rule path glob"
              value={form.pathGlob}
              onChange={(event) =>
                setForm({ ...form, pathGlob: event.target.value })
              }
              placeholder="src/server/api/**/*.ts"
              className="form-input font-mono"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scope">
              <select
                aria-label="Rule scope"
                value={form.scope}
                onChange={(event) =>
                  setForm({
                    ...form,
                    scope: event.target.value as typeof form.scope,
                  })
                }
                className="form-input"
              >
                <option value="file">Per file</option>
                <option value="repository">Repository-wide</option>
              </select>
            </Field>
            <Field label="Severity">
              <select
                aria-label="Rule severity"
                value={form.severity}
                onChange={(event) =>
                  setForm({
                    ...form,
                    severity: event.target.value as typeof form.severity,
                  })
                }
                className="form-input"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              loading={add.isPending || update.isPending}
              disabled={
                !form.title.trim() ||
                !form.instruction.trim() ||
                !form.pathGlob.trim()
              }
              onClick={save}
            >
              {editingId ? "Save changes" : "Add rule"}
            </Button>
            {editingId && (
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Labels one rule or repository-picker field. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block text-xs font-medium text-mist">
      <span className="mb-2 block">{label}</span>
      {children}
    </div>
  );
}

/** Lists repository-scoped audit history newest first. */
function History({
  monitor,
  onOpenFindings,
}: {
  monitor: Monitors[number];
  onOpenFindings: (jobId: string) => void;
}) {
  const history = api.repoReviews.history.useQuery(
    { monitorId: monitor.id },
    {
      refetchInterval: (query) =>
        query.state.data?.some(({ status }) => activeRunStatuses.has(status))
          ? 1_500
          : false,
    },
  );
  return (
    <div className="space-y-2">
      {(history.data ?? []).map((run) => (
        <button
          key={run.id}
          type="button"
          onClick={() => onOpenFindings(run.id)}
          className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-4 text-left hover:border-line-strong"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-surface-subtle text-lime">
            {run.reviewPurpose === "compliance" ? (
              <ShieldCheck className="size-5" />
            ) : (
              <Code2 className="size-5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-cloud">
              {run.reviewPurpose === "compliance"
                ? "Compliance check"
                : "Code audit"}
            </span>
            <span
              className="mt-1 block text-xs text-mist"
              suppressHydrationWarning
            >
              {run.createdAt.toLocaleString()}
            </span>
          </span>
          <RunStatus status={run.status} progress={run.progress} />
          <ChevronRight className="size-4 text-mist" />
        </button>
      ))}
      {!history.isLoading && history.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line p-12 text-center text-sm text-mist">
          Review runs will appear here.
        </div>
      )}
    </div>
  );
}

/** Selects an imported repository and exact provider branch to monitor. */
function AddRepositoryDialog({
  repositories,
  monitors,
  onClose,
  onAdded,
}: {
  repositories: Repositories;
  monitors: Monitors;
  onClose: () => void;
  onAdded: (monitorId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const branches = api.repoReviews.listBranches.useQuery(
    { repositoryId: repositoryId || EMPTY_UUID },
    { enabled: Boolean(repositoryId) },
  );
  const monitoredBranches = useMemo(
    () =>
      new Set(
        monitors
          .filter((monitor) => monitor.repositoryId === repositoryId)
          .map((monitor) => monitor.branch),
      ),
    [monitors, repositoryId],
  );
  const [branch, setBranch] = useState("");
  useEffect(() => {
    setBranch((current) => {
      if (
        current &&
        !monitoredBranches.has(current) &&
        branches.data?.some(({ name }) => name === current)
      ) {
        return current;
      }
      return (
        branches.data?.find(({ name }) => !monitoredBranches.has(name))?.name ??
        ""
      );
    });
  }, [branches.data, monitoredBranches]);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
      element.querySelector<HTMLElement>("button, select")?.focus();
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);
  const add = api.repoReviews.add.useMutation({
    onSuccess: ({ monitor, sync }) => {
      if (sync.status === "failed" && "error" in sync) {
        toast.warning("Repository added, but its first check could not start", {
          description: sync.error,
        });
      } else {
        toast.success("Repository added", {
          description: "The first complete snapshot is being prepared.",
        });
      }
      onAdded(monitor.id);
    },
    onError: (error) =>
      toast.error("Could not add repository", { description: error.message }),
  });
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-3xl border border-line bg-panel p-6 shadow-2xl backdrop:bg-ink/80 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        if (!add.isPending) onClose();
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-xl font-semibold text-cloud">
            Monitor a repository
          </h2>
          <p className="mt-1 text-sm text-mist">
            Pick an imported repository and the exact branch to follow.
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close"
          disabled={add.isPending}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {repositories.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-line p-8 text-center">
          <p className="text-sm text-mist">
            Import a repository from a code provider first.
          </p>
          <Button asChild className="mt-5">
            <Link href="/settings/providers">Open provider settings</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-7 space-y-5">
          <Field label="Repository">
            <select
              aria-label="Repository"
              value={repositoryId}
              onChange={(event) => {
                setRepositoryId(event.target.value);
                setBranch("");
              }}
              className="form-input"
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.owner}/{repository.name} ·{" "}
                  {providerLabel(repository.provider)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branch">
            <select
              aria-label="Branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              disabled={branches.isLoading || branches.isError}
              className="form-input"
            >
              <option value="">
                {branches.isLoading
                  ? "Loading branches…"
                  : branches.isError
                    ? "Branches unavailable"
                    : "Choose a branch"}
              </option>
              {branches.data?.map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={monitoredBranches.has(item.name)}
                >
                  {item.name}
                  {item.isDefault ? " (default)" : ""}
                  {monitoredBranches.has(item.name)
                    ? " (already monitored)"
                    : ""}
                </option>
              ))}
            </select>
            {branches.error && (
              <span className="mt-2 block text-xs text-red-300">
                {branches.error.message}
              </span>
            )}
            {!branches.isLoading &&
              !branches.isError &&
              branches.data?.length !== 0 &&
              !branch && (
                <span className="mt-2 block text-xs text-mist">
                  Every branch in this repository is already monitored.
                </span>
              )}
          </Field>
          <div className="rounded-xl border border-line bg-surface-subtle/45 p-3 text-xs leading-5 text-mist">
            The initial snapshot reads the full branch. Later checks compare the
            branch head and carry your reading progress across unchanged code.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={add.isPending}
              disabled={!repositoryId || !branch}
              onClick={() => add.mutate({ repositoryId, branch })}
            >
              <Plus className="size-4" /> Add and sync
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
