import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { SyncProgressMeter } from "~/components/review/sync-progress-meter";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import { providerLabel } from "~/lib/provider-labels";
import { syncProgressLabel } from "~/lib/sync-progress";
import type { RouterOutputs } from "~/trpc/react";

type ActiveSyncs = RouterOutputs["review"]["activeSyncs"];
type FailedSyncs = RouterOutputs["review"]["recentSyncFailures"];

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
          const provider = providerLabel(sync.provider);
          return (
            <li key={sync.id} className="min-w-0">
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
              <div className="mt-2">
                <SyncProgressMeter
                  label={`${sync.repositoryOwner}/${sync.repositoryName} #${sync.pullRequestNumber} synchronization progress`}
                  progress={sync.progress}
                  status={sync.status}
                />
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
  onRetry,
  retryingKey,
}: {
  failedSyncs: FailedSyncs;
  onRetry?: (sync: FailedSyncs[number]) => void;
  retryingKey?: string;
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
              const provider = providerLabel(sync.provider);
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
                      className="text-coral inline-flex items-center gap-1 font-medium hover:underline"
                    >
                      Review connection
                      <LinkPendingSpinner className="size-3" />
                    </Link>
                  </p>
                  {onRetry ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      disabled={
                        retryingKey ===
                        `${sync.repositoryId}:${sync.pullRequestNumber}`
                      }
                      onClick={() => onRetry(sync)}
                    >
                      <RefreshCw
                        className={
                          retryingKey ===
                          `${sync.repositoryId}:${sync.pullRequestNumber}`
                            ? "size-3.5 animate-spin"
                            : "size-3.5"
                        }
                      />
                      Retry
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
