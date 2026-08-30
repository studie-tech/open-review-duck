"use client";

import {
  Activity,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  Code2,
  GitBranch,
  GitPullRequest,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";

import { DashboardSyncPanel } from "~/components/dashboard/dashboard-panels";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import {
  LinkNavigationStatus,
  LinkPendingSpinner,
} from "~/components/ui/link-status";
import { prioritizeInbox } from "~/lib/priority-inbox";
import { activeRunStatuses } from "~/lib/repository-run-progress";
import { partitionReviewQueue } from "~/lib/review-queue";
import { followActiveReviewJobs } from "~/lib/sync-progress";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type PullRequests = RouterOutputs["review"]["dashboard"];
type Monitors = RouterOutputs["repoReviews"]["list"];
type Monitor = Monitors[number];
type ActivityKind = "pull-request" | "repository" | "code" | "compliance";

interface WorkspaceActivity {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  date: Date;
  href: string;
}

/** Formats a recent timestamp without exposing clock precision as important UI. */
function relativeTime(value: Date) {
  const seconds = Math.round((value.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

/** Chooses the latest durable timestamp represented by one monitor. */
function monitorActivityDate(monitor: Monitor) {
  const candidates = [
    monitor.latestCodeRun?.completedAt ?? monitor.latestCodeRun?.createdAt,
    monitor.latestComplianceRun?.completedAt ??
      monitor.latestComplianceRun?.createdAt,
    monitor.snapshot?.createdAt,
    monitor.lastSyncedAt,
    monitor.lastCheckedAt,
    monitor.createdAt,
  ].filter((value): value is Date => Boolean(value));
  return new Date(
    Math.max(...candidates.map((candidate) => candidate.getTime())),
  );
}

/** Ranks repository work by errors, changed code, and unread understanding. */
function monitorAttentionScore(monitor: Monitor) {
  if (monitor.lastError) return 4;
  if (monitor.progress.changed > 0) return 3;
  if (monitor.progress.unseen > 0) return 2;
  if (monitor.activeSync) return 1;
  return 0;
}

/** Builds one combined, chronologically ordered activity stream. */
function workspaceActivity(
  pullRequests: PullRequests,
  monitors: Monitors,
): WorkspaceActivity[] {
  const activities: WorkspaceActivity[] = pullRequests.map((pullRequest) => ({
    id: `pull-request:${pullRequest.id}`,
    kind: "pull-request",
    title: pullRequest.title,
    detail: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number} · updated`,
    date: pullRequest.updatedAt,
    href: `/review/${pullRequest.id}`,
  }));

  for (const monitor of monitors) {
    const href = `/repo-reviews?monitor=${encodeURIComponent(monitor.id)}`;
    if (monitor.snapshot) {
      activities.push({
        id: `repository:${monitor.id}:${monitor.snapshot.id}`,
        kind: "repository",
        title:
          monitor.progress.changed > 0
            ? `${monitor.progress.changed} review ${monitor.progress.changed === 1 ? "unit changed" : "units changed"}`
            : "Repository snapshot refreshed",
        detail: `${monitor.repositoryOwner}/${monitor.repositoryName} · ${monitor.branch}`,
        date: monitor.snapshot.createdAt,
        href,
      });
    }
    for (const [kind, run] of [
      ["code", monitor.latestCodeRun],
      ["compliance", monitor.latestComplianceRun],
    ] as const) {
      if (!run) continue;
      const label = kind === "code" ? "Code audit" : "Compliance check";
      activities.push({
        id: `${kind}:${run.id}`,
        kind,
        title: `${label} ${run.status.replaceAll("_", " ")}`,
        detail: `${monitor.repositoryOwner}/${monitor.repositoryName} · ${monitor.branch}`,
        date: run.completedAt ?? run.createdAt,
        href,
      });
    }
  }

  return activities
    .sort((left, right) => right.date.getTime() - left.date.getTime())
    .slice(0, 6);
}

/** Renders a calm workspace overview that routes users to the right review mode. */
export function DashboardOverview({
  initialPullRequests,
  initialMonitors,
  fetchedAt,
}: {
  initialPullRequests: PullRequests;
  initialMonitors: Monitors;
  fetchedAt: number;
}) {
  const activeSyncs = api.review.activeSyncs.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: followActiveReviewJobs,
  });
  // The sidebar prefetches this route eagerly, so the server payload can
  // predate the navigation. Stamping it with the time it was read lets the
  // shared stale time decide whether hydration has to refresh it.
  const pullRequestsQuery = api.review.dashboard.useQuery(undefined, {
    initialData: initialPullRequests,
    initialDataUpdatedAt: fetchedAt,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const monitorsQuery = api.repoReviews.list.useQuery(undefined, {
    initialData: initialMonitors,
    initialDataUpdatedAt: fetchedAt,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.some(({ activeSync }) => activeSync) ? 1_500 : false,
  });
  const hadActiveSync = useRef(false);
  useEffect(() => {
    const hasActiveSync = (activeSyncs.data?.length ?? 0) > 0;
    if (hadActiveSync.current && !hasActiveSync) {
      void pullRequestsQuery.refetch();
      void monitorsQuery.refetch();
    }
    hadActiveSync.current = hasActiveSync;
  }, [activeSyncs.data, monitorsQuery, pullRequestsQuery]);
  const pullRequests = pullRequestsQuery.data ?? initialPullRequests;
  const monitors = monitorsQuery.data ?? initialMonitors;
  const { needsReview, reviewed } = useMemo(
    () => partitionReviewQueue(pullRequests),
    [pullRequests],
  );
  const prioritizedPullRequests = useMemo(
    () => prioritizeInbox(needsReview),
    [needsReview],
  );
  const sortedMonitors = useMemo(
    () =>
      [...monitors].sort((left, right) => {
        const attention =
          monitorAttentionScore(right) - monitorAttentionScore(left);
        if (attention !== 0) return attention;
        return (
          monitorActivityDate(right).getTime() -
          monitorActivityDate(left).getTime()
        );
      }),
    [monitors],
  );
  const activities = useMemo(
    () => workspaceActivity(pullRequests, monitors),
    [monitors, pullRequests],
  );
  const nextPullRequest = prioritizedPullRequests[0];
  const nextMonitor = sortedMonitors[0];
  const inProgressCount = needsReview.filter(
    ({ signedUnits }) => signedUnits > 0,
  ).length;
  const repositoryAttentionCount = monitors.filter(
    ({ progress, lastError }) =>
      progress.changed > 0 || progress.unseen > 0 || Boolean(lastError),
  ).length;
  const unreadUnits = monitors.reduce(
    (total, { progress }) => total + progress.unseen,
    0,
  );
  const activeRepositoryWork = monitors.filter(
    ({ activeSync, latestCodeRun, latestComplianceRun }) =>
      activeSync ||
      [latestCodeRun?.status, latestComplianceRun?.status].some((status) =>
        activeRunStatuses.has(status ?? ""),
      ),
  ).length;
  const attentionCount = needsReview.length + repositoryAttentionCount;

  return (
    <PageContainer>
      <header className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-[.18em] text-lime uppercase">
            <Sparkles className="size-4" /> Workspace overview
          </div>
          <h1 className="font-editorial mt-3 max-w-3xl text-4xl font-medium tracking-[-.045em] text-balance sm:text-5xl">
            Choose where to focus.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-mist">
            Review proposed changes before they merge, or keep your
            understanding of an entire repository current over time.
          </p>
        </div>
        <div
          className={cn(
            "flex max-w-md items-start gap-3 rounded-2xl border px-4 py-3",
            attentionCount > 0
              ? "border-coral/25 bg-coral/[.06]"
              : "border-lime/25 bg-lime/[.06]",
          )}
        >
          {attentionCount > 0 ? (
            <Activity className="mt-0.5 size-4 shrink-0 text-coral" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-lime" />
          )}
          <div>
            <p className="text-sm font-medium">
              {attentionCount > 0
                ? `${attentionCount} ${attentionCount === 1 ? "area needs" : "areas need"} attention`
                : "Your workspace is caught up"}
            </p>
            <p className="mt-1 text-xs leading-5 text-mist">
              {attentionCount > 0
                ? `${needsReview.length} pull ${needsReview.length === 1 ? "request" : "requests"} and ${repositoryAttentionCount} monitored ${repositoryAttentionCount === 1 ? "repository" : "repositories"}.`
                : "New pull requests and repository changes will surface here."}
            </p>
          </div>
        </div>
      </header>

      <div className="mt-8">
        <DashboardSyncPanel synchronizing={activeSyncs.data ?? []} />
      </div>

      <section
        className="mt-10 grid gap-5 lg:grid-cols-2"
        aria-label="Review modes"
      >
        <ReviewModeCard
          icon={GitPullRequest}
          eyebrow="Change review"
          title="Pull requests"
          description="Inspect a bounded change, follow its logic, and sign off before it merges."
          href="/pullrequests"
          action="Open pull request inbox"
          accent="coral"
          metrics={[
            [needsReview.length, "Need review"],
            [inProgressCount, "In progress"],
            [reviewed.length, "Awaiting merge"],
          ]}
        >
          {nextPullRequest ? (
            <Link
              href={`/review/${nextPullRequest.id}`}
              className="group flex items-center gap-3 rounded-2xl border border-line bg-ink/25 p-4 transition hover:border-coral/30 hover:bg-surface-hover"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-coral/10 text-coral">
                <GitPullRequest className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fog text-[10px] font-semibold tracking-[.1em] uppercase">
                  Next pull request
                </span>
                <span className="mt-1 block truncate text-sm font-medium">
                  {nextPullRequest.title}
                </span>
                <span className="mt-1 block truncate text-xs text-mist">
                  {nextPullRequest.repositoryOwner}/
                  {nextPullRequest.repositoryName} #{nextPullRequest.number} ·{" "}
                  {nextPullRequest.signedUnits}/{nextPullRequest.totalUnits}{" "}
                  read
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-mist transition group-hover:translate-x-0.5 group-hover:text-cloud" />
            </Link>
          ) : (
            <ModeEmptyState
              icon={CheckCircle2}
              title={
                pullRequests.length > 0
                  ? "Pull requests caught up"
                  : "No pull requests yet"
              }
              detail={
                pullRequests.length > 0
                  ? "Finished work remains available in the pull request history."
                  : "Connect a provider to bring proposed changes into your inbox."
              }
            />
          )}
        </ReviewModeCard>

        <ReviewModeCard
          icon={BookOpenCheck}
          eyebrow="Repository understanding"
          title="Repo reviews"
          description="Learn a complete branch once, then return only to code that is new or changed."
          href="/repo-reviews"
          action="Open repository reviews"
          accent="lime"
          metrics={[
            [monitors.length, "Monitored"],
            [unreadUnits, "Unread units"],
            [activeRepositoryWork, "Running now"],
          ]}
        >
          {nextMonitor ? (
            <Link
              href={`/repo-reviews?monitor=${encodeURIComponent(nextMonitor.id)}`}
              className="group flex items-center gap-3 rounded-2xl border border-line bg-ink/25 p-4 transition hover:border-lime/30 hover:bg-surface-hover"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-lime/10 text-lime">
                <GitBranch className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fog text-[10px] font-semibold tracking-[.1em] uppercase">
                  {nextMonitor.lastError
                    ? "Needs reconnection"
                    : nextMonitor.progress.changed > 0
                      ? "Changed since your review"
                      : nextMonitor.progress.unseen > 0
                        ? "Continue reading"
                        : "Latest repository"}
                </span>
                <span className="mt-1 block truncate text-sm font-medium">
                  {nextMonitor.repositoryOwner}/{nextMonitor.repositoryName}
                </span>
                <span className="mt-1 block truncate text-xs text-mist">
                  {nextMonitor.branch} · {nextMonitor.progress.signed}/
                  {nextMonitor.progress.total} read
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-mist transition group-hover:translate-x-0.5 group-hover:text-cloud" />
            </Link>
          ) : (
            <ModeEmptyState
              icon={GitBranch}
              title="No repositories monitored"
              detail="Add a repository branch to build living, full-codebase understanding."
            />
          )}
        </ReviewModeCard>
      </section>

      <section className="mt-10 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="overflow-hidden rounded-3xl border border-line bg-surface/55">
          <div className="flex items-end justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
            <div>
              <p className="text-fog text-[10px] font-semibold tracking-[.12em] uppercase">
                Across your workspace
              </p>
              <h2 className="mt-1 text-lg font-medium">Latest updates</h2>
            </div>
            <Clock3 className="size-4 text-fog" />
          </div>
          {activities.length > 0 ? (
            <div className="divide-y divide-line">
              {activities.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <div className="grid min-h-52 place-items-center px-6 py-10 text-center">
              <div>
                <Activity className="mx-auto size-5 text-fog" />
                <h3 className="mt-4 text-sm font-medium">No activity yet</h3>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-mist">
                  Connect a provider or monitor a repository branch. Your latest
                  updates will stay together here.
                </p>
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-3xl border border-line bg-panel p-6">
          <p className="text-lime text-[10px] font-semibold tracking-[.12em] uppercase">
            Pick the right mode
          </p>
          <h2 className="mt-2 text-lg font-medium">
            One codebase, two questions
          </h2>
          <div className="mt-6 space-y-5">
            <GuideRow
              icon={GitPullRequest}
              title="What is this change doing?"
              detail="Use Pull requests for a proposed diff with a clear merge boundary."
            />
            <GuideRow
              icon={BookOpenCheck}
              title="How does this repository work?"
              detail="Use Repo reviews for full-branch knowledge and ongoing change awareness."
            />
          </div>
          <div className="mt-6 border-t border-line pt-5">
            <Link
              href="/settings/providers"
              className="group flex items-center justify-between gap-3 text-xs font-medium text-mist transition hover:text-cloud"
            >
              Manage connected repositories
              <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
            </Link>
          </div>
        </aside>
      </section>
    </PageContainer>
  );
}

/** Renders one of the two primary destination cards. */
function ReviewModeCard({
  icon: Icon,
  eyebrow,
  title,
  description,
  href,
  action,
  accent,
  metrics,
  children,
}: {
  icon: typeof GitPullRequest;
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  action: string;
  accent: "coral" | "lime";
  metrics: Array<readonly [number, string]>;
  children: React.ReactNode;
}) {
  return (
    <article
      className={cn(
        "rounded-3xl border bg-surface/60 p-5 shadow-[0_24px_70px_var(--app-shadow)] sm:p-6",
        accent === "coral" ? "border-coral/20" : "border-lime/20",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div
            className={cn(
              "flex items-center gap-2 text-[10px] font-semibold tracking-[.12em] uppercase",
              accent === "coral" ? "text-coral" : "text-lime",
            )}
          >
            <Icon className="size-4" /> {eyebrow}
          </div>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-mist">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-2">
        {metrics.map(([value, label]) => (
          <div
            key={label}
            className="rounded-2xl border border-line bg-ink/25 p-3"
          >
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="mt-1 text-[10px] leading-4 text-mist">{label}</p>
          </div>
        ))}
      </div>
      <div className="mt-4">{children}</div>
      <Button asChild variant="secondary" className="mt-5 w-full sm:w-auto">
        <Link href={href}>
          {action}
          <LinkNavigationStatus
            idle={<ArrowRight className="size-4" />}
            pending={<LinkPendingSpinner />}
          />
        </Link>
      </Button>
    </article>
  );
}

/** Renders an informative empty destination preview. */
function ModeEmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof GitBranch;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-24 items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-ink/20 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-subtle text-mist">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-mist">{detail}</p>
      </div>
    </div>
  );
}

/** Renders one event in the cross-workspace activity feed. */
function ActivityRow({ item }: { item: WorkspaceActivity }) {
  const Icon =
    item.kind === "pull-request"
      ? GitPullRequest
      : item.kind === "code"
        ? Code2
        : item.kind === "compliance"
          ? ShieldCheck
          : GitBranch;
  return (
    <Link
      href={item.href}
      className="group flex items-center gap-3 px-5 py-4 transition hover:bg-surface-hover sm:px-6"
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-xl",
          item.kind === "pull-request"
            ? "bg-coral/10 text-coral"
            : "bg-lime/10 text-lime",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className="mt-1 block truncate text-xs text-mist">
          {item.detail}
        </span>
      </span>
      <span
        suppressHydrationWarning
        className="hidden shrink-0 text-[11px] text-fog sm:block"
      >
        {relativeTime(item.date)}
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-fog transition group-hover:translate-x-0.5 group-hover:text-cloud" />
    </Link>
  );
}

/** Explains when one review mode is the better fit. */
function GuideRow({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof GitPullRequest;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-subtle text-mist">
        <Icon className="size-3.5" />
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-mist">{detail}</p>
      </div>
    </div>
  );
}
