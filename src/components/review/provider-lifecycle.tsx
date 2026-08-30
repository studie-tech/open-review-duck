"use client";

import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitMerge,
  LoaderCircle,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  providerCheckStateLabel,
  providerLifecycleSummaryLabel,
} from "~/lib/provider-lifecycle";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type LifecycleState = RouterOutputs["review"]["providerLifecycle"];

const providerNames = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} as const;

/** Renders live CI checks and the provider merge action after a review. */
export function ProviderLifecycle({
  error,
  loading,
  mutationPending,
  onMerge,
  onRefresh,
  state,
}: {
  error?: string;
  loading: boolean;
  mutationPending: boolean;
  onMerge: () => void;
  onRefresh: () => void;
  state?: LifecycleState;
}) {
  const [confirming, setConfirming] = useState(false);
  const providerName = state ? providerNames[state.provider] : "provider";
  const merged = state?.pullRequestState === "merged";
  const closed = state?.pullRequestState === "closed";
  const summary = state?.summary ?? "empty";
  const summaryLabel = providerLifecycleSummaryLabel(
    summary,
    state?.checks.length ?? 0,
  );
  const mergeLabel = state?.mergeActionLabel ?? "Merge";

  useEffect(() => {
    if (mutationPending || !confirming) return;
    if (state?.pullRequestState === "merged") setConfirming(false);
  }, [confirming, mutationPending, state?.pullRequestState]);

  return (
    <>
      <section
        aria-labelledby="provider-lifecycle-title"
        className="rounded-2xl border border-line bg-panel/70 p-4"
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
            <GitMerge className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
              Checks and merge
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h3 id="provider-lifecycle-title" className="text-sm text-cloud">
                Status on {providerName}
              </h3>
              {state && (
                <Badge
                  className={cn(
                    merged || summary === "passing"
                      ? "border-addition/30 bg-addition/10 text-addition"
                      : summary === "failing"
                        ? "border-coral/25 bg-coral/10 text-coral"
                        : summary === "pending"
                          ? "border-cyan/25 bg-cyan/10 text-cyan"
                          : "border-line-strong bg-surface text-mist",
                  )}
                >
                  {merged ? (
                    <CheckCircle2 className="size-3" />
                  ) : summary === "failing" ? (
                    <XCircle className="size-3" />
                  ) : summary === "pending" ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : summary === "passing" ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <CircleDashed className="size-3" />
                  )}
                  {merged ? "Merged" : summaryLabel}
                </Badge>
              )}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Refresh checks and merge state"
            title="Refresh checks and merge state"
            disabled={loading || mutationPending}
            onClick={onRefresh}
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>

        {loading && !state ? (
          <p role="status" className="text-mist mt-4 text-xs">
            Synchronizing checks and merge state…
          </p>
        ) : error ? (
          <p role="alert" className="text-coral mt-4 text-xs leading-5">
            {error}
          </p>
        ) : state ? (
          <div className="mt-4">
            {state.checks.length > 0 ? (
              <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
                {state.checks.map((check) => (
                  <li key={check.id}>
                    <CheckRow check={check} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-mist text-[10px] leading-4">
                {providerName} has not reported any checks or pipelines for this
                revision yet.
              </p>
            )}

            {state.mergeBlockedReason && !merged && (
              <p className="text-mist mt-3 rounded-xl border border-line bg-surface/50 px-3 py-2 text-[10px] leading-4">
                {state.mergeBlockedReason}
              </p>
            )}
            {summary === "failing" && state.canMerge && (
              <p className="text-mist mt-3 rounded-xl border border-line bg-surface/50 px-3 py-2 text-[10px] leading-4">
                Some checks have not passed. {providerName} still allows merging
                this revision.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {merged ? (
                <p className="text-addition text-xs">
                  This pull request is merged on {providerName}.
                </p>
              ) : closed ? (
                <p className="text-mist text-xs">
                  This pull request is closed on {providerName}.
                </p>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={mutationPending || !state.canMerge}
                  onClick={() => setConfirming(true)}
                >
                  <GitMerge className="size-3.5" />
                  {mergeLabel}
                </Button>
              )}
              {mutationPending && (
                <span
                  role="status"
                  className="text-mist flex items-center gap-2 text-[10px]"
                >
                  <LoaderCircle className="size-3 animate-spin" />
                  Updating {providerName}…
                </span>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {confirming && state && (
        <ConfirmationDialog
          title={`${mergeLabel} on ${providerName}?`}
          description={
            mergeLabel === "Complete"
              ? "This completes the pull request on Azure DevOps against the exact revision you finished reviewing. The action cannot be undone from ReviewDuck."
              : `This merges the exact revision you finished reviewing on ${providerName}. The action cannot be undone from ReviewDuck.`
          }
          confirmLabel={mergeLabel}
          pending={mutationPending}
          pendingLabel={
            <span className="flex items-center gap-2">
              <LoaderCircle className="size-3.5 animate-spin" />
              Updating…
            </span>
          }
          icon={<GitMerge className="text-cyan size-5" />}
          iconClassName="bg-cyan/10"
          onCancel={() => setConfirming(false)}
          onConfirm={onMerge}
        />
      )}
    </>
  );
}

/** Renders one check, pipeline, or status with its live state. */
function CheckRow({ check }: { check: LifecycleState["checks"][number] }) {
  const label = providerCheckStateLabel(check.state);
  const content = (
    <span className="flex min-w-0 items-start gap-2.5 px-1 py-1.5">
      <CheckStateIcon state={check.state} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-cloud">{check.name}</span>
          {check.webUrl && (
            <ExternalLink className="text-fog size-3 shrink-0" />
          )}
        </span>
        {check.description && (
          <span className="text-mist mt-0.5 block text-[10px] leading-4">
            {check.description}
          </span>
        )}
      </span>
      <span className="text-fog shrink-0 text-[10px]">{label}</span>
    </span>
  );

  if (!check.webUrl) {
    return content;
  }

  return (
    <a
      href={check.webUrl}
      target="_blank"
      rel="noreferrer"
      className="hover:bg-surface-hover/60 -mx-1 block rounded-xl transition"
    >
      {content}
    </a>
  );
}

/** Chooses the status icon for one normalized check state. */
function CheckStateIcon({
  state,
}: {
  state: LifecycleState["checks"][number]["state"];
}) {
  if (state === "success") {
    return <CheckCircle2 className="text-addition mt-0.5 size-3.5 shrink-0" />;
  }
  if (state === "failure") {
    return <XCircle className="text-coral mt-0.5 size-3.5 shrink-0" />;
  }
  if (state === "in_progress") {
    return (
      <LoaderCircle className="text-cyan mt-0.5 size-3.5 shrink-0 animate-spin" />
    );
  }
  if (state === "queued") {
    return <CircleDashed className="text-cyan mt-0.5 size-3.5 shrink-0" />;
  }
  return <MinusCircle className="text-fog mt-0.5 size-3.5 shrink-0" />;
}
