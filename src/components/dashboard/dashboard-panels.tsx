import {
  CheckCheck,
  ChevronDown,
  CircleAlert,
  GitMerge,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import {
  PullRequestList,
  type PullRequestListKind,
} from "~/components/dashboard/pull-request-list";
import { syncProgressLabel } from "~/lib/sync-progress";
import type { RouterOutputs } from "~/trpc/react";

type DashboardPullRequests = RouterOutputs["review"]["dashboard"];
type ActiveSyncs = RouterOutputs["review"]["activeSyncs"];
type FailedSyncs = RouterOutputs["review"]["recentSyncFailures"];

/** Renders AI usage or local configuration status for the workspace rail. */
export function DashboardAiCard({
  localMode,
  status,
  usagePercent,
  usedTokens,
  limitTokens,
  subscribed,
}: {
  localMode: boolean;
  status: readonly string[];
  usagePercent: number;
  usedTokens?: number;
  limitTokens?: number;
  subscribed?: boolean;
}) {
  return (
    <section className="bg-surface/55 rounded-2xl border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <Sparkles className="text-violet size-3.5" />
        <p className="text-mist text-xs">
          AI assistant · <span className="text-cloud">{status[0]}</span>
        </p>
      </div>
      <p className="text-fog mt-0.5 text-[10px]">{status[1]}</p>
      {!localMode && usedTokens !== undefined && limitTokens !== undefined && (
        <div className="mt-2 flex items-center gap-3">
          <div
            className="bg-surface-subtle h-1.5 min-w-24 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Monthly AI token usage"
            aria-valuemin={0}
            aria-valuemax={limitTokens}
            aria-valuenow={usedTokens}
          >
            <div
              className="bg-violet h-full rounded-full"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <Link
            href="/settings/ai"
            className="text-violet text-[10px] font-medium hover:underline"
          >
            {subscribed ? "Manage plan" : "View plans"}
          </Link>
        </div>
      )}
    </section>
  );
}

/** Renders durable pull-request synchronization progress. */
export function DashboardSyncPanel({
  synchronizing,
}: {
  synchronizing: ActiveSyncs;
}) {
  if (synchronizing.length === 0) return null;
  return (
    <section
      aria-live="polite"
      className="border-cyan/20 bg-cyan/[.045] rounded-2xl border px-4 py-3"
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
                <p className="text-fog min-w-0 flex-1 truncate text-right text-[11px]">
                  {syncProgressLabel(sync.status, progress)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Renders recent synchronization failures that still need attention. */
export function DashboardFailurePanel({
  failedSyncs,
}: {
  failedSyncs: FailedSyncs;
}) {
  if (failedSyncs.length === 0) return null;
  return (
    <section
      aria-live="polite"
      className="border-coral/25 bg-coral/[.045] rounded-2xl border px-4 py-3"
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
                    {syncProgressLabel("running", sync.progress).toLowerCase()}.{" "}
                    {sync.message}{" "}
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
  );
}

/** Renders reviewed, closed, and removed queue history. */
export function DashboardHistoryPanel({
  reviewed,
  closed,
  removed,
  pendingPullRequestId,
  compact,
  onRemove,
  onRestore,
}: {
  reviewed: DashboardPullRequests;
  closed: DashboardPullRequests;
  removed: DashboardPullRequests;
  pendingPullRequestId?: string;
  compact?: boolean;
  onRemove: (pullRequest: DashboardPullRequests[number]) => void;
  onRestore: (pullRequest: DashboardPullRequests[number]) => void;
}) {
  if (reviewed.length + closed.length + removed.length === 0) {
    return (
      <section className="bg-surface/35 rounded-2xl border border-line px-4 py-3">
        <p className="text-sm font-medium">Reviewed, awaiting merge</p>
        <p className="text-fog mt-1 text-xs leading-5">
          Nothing waiting. Closed and removed work stays one click away once it
          appears.
        </p>
      </section>
    );
  }
  return (
    <div className="space-y-3">
      {reviewed.length > 0 && (
        <HistoryDetails
          icon={CheckCheck}
          iconClassName="bg-lime/10 text-lime"
          title="Reviewed, awaiting merge"
          description="Fully reviewed at the current provider revision"
          count={reviewed.length}
          pullRequests={reviewed}
          kind="reviewed"
          pendingPullRequestId={pendingPullRequestId}
          compact={compact}
          onRemove={onRemove}
        />
      )}
      {closed.length > 0 && (
        <HistoryDetails
          icon={GitMerge}
          iconClassName="bg-cyan/10 text-cyan"
          title="Closed history"
          description="Merged and closed pull requests"
          count={closed.length}
          pullRequests={closed}
          kind="closed"
          compact={compact}
        />
      )}
      {removed.length > 0 && (
        <HistoryDetails
          icon={RotateCcw}
          iconClassName="bg-surface-subtle text-mist"
          title="Removed from my queue"
          description="Hidden until restored or a new revision arrives"
          count={removed.length}
          pullRequests={removed}
          kind="removed"
          pendingPullRequestId={pendingPullRequestId}
          compact={compact}
          onRestore={onRestore}
        />
      )}
    </div>
  );
}

/** Renders one collapsible history section. */
function HistoryDetails({
  icon: Icon,
  iconClassName,
  title,
  description,
  count,
  pullRequests,
  kind,
  pendingPullRequestId,
  compact,
  onRemove,
  onRestore,
}: {
  icon: typeof CheckCheck;
  iconClassName: string;
  title: string;
  description: string;
  count: number;
  pullRequests: DashboardPullRequests;
  kind: PullRequestListKind;
  pendingPullRequestId?: string;
  compact?: boolean;
  onRemove?: (pullRequest: DashboardPullRequests[number]) => void;
  onRestore?: (pullRequest: DashboardPullRequests[number]) => void;
}) {
  return (
    <details className="group rounded-2xl border border-line bg-surface/35">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span
          className={`grid size-8 place-items-center rounded-lg ${iconClassName}`}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="text-fog mt-0.5 block text-xs">{description}</span>
        </span>
        <span className="text-mist text-xs">{count}</span>
        <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-line p-2">
        <PullRequestList
          pullRequests={pullRequests}
          kind={kind}
          compact={compact}
          pendingPullRequestId={pendingPullRequestId}
          onRemove={onRemove}
          onRestore={onRestore}
        />
      </div>
    </details>
  );
}
