"use client";

import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  type AiFixPromptDiscussion,
  type AiFixPromptPullRequest,
  failingCheckFixPrompt,
  mergeBlockedFixPrompt,
} from "~/lib/ai-fix-prompt";
import { providerLabel } from "~/lib/provider-labels";
import {
  providerCheckStateLabel,
  providerLifecycleSummaryLabel,
} from "~/lib/provider-lifecycle";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { CopyAiFixPromptButton } from "./copy-ai-fix-prompt-button";
import { ProviderPermissionRecovery } from "./provider-permission-recovery";

type LifecycleState = RouterOutputs["review"]["providerLifecycle"];

/** Renders live CI checks and the provider merge action after a review. */
export function ProviderLifecycle({
  approval,
  discussions,
  error,
  loading,
  mutationPending,
  onMerge,
  onMarkReady,
  readyError,
  onRefresh,
  permissionDenied,
  pullRequest,
  reviewPath,
  state,
}: {
  /** Personal review controls, placed before the provider merge action. */
  approval?: ReactNode;
  /** Open review conversations, quoted when they are what blocks merging. */
  discussions?: readonly AiFixPromptDiscussion[];
  error?: string;
  loading: boolean;
  mutationPending: boolean;
  onMerge: (options?: {
    bypassRequirements: boolean;
    bypassReason?: string;
  }) => void;
  onMarkReady?: () => void;
  readyError?: string;
  onRefresh: () => void;
  permissionDenied?: boolean;
  pullRequest: AiFixPromptPullRequest;
  reviewPath?: string;
  state?: LifecycleState;
}) {
  const [confirming, setConfirming] = useState(false);
  const [bypassSelected, setBypassSelected] = useState(false);
  const [bypassReason, setBypassReason] = useState("");
  const consentScope = useRef("");
  const provider = pullRequest.provider;
  const pullRequestUrl = pullRequest.webUrl;
  const providerName = providerLabel(provider);
  const merged = state?.pullRequestState === "merged";
  const draft = state?.pullRequestState === "draft";
  const closed = state?.pullRequestState === "closed";
  const summary = state?.summary ?? "empty";
  const optionalPending = Boolean(
    state?.checks.some(
      (check) =>
        check.required === false &&
        (check.state === "queued" || check.state === "in_progress"),
    ),
  );
  const missingMergePermission = Boolean(
    state && !merged && !closed && state.hasMergePermission === false,
  );
  const showPermissionRecovery = Boolean(
    missingMergePermission ||
      (readyError && permissionDenied) ||
      (error && (permissionDenied || !state)),
  );
  const mergeReady = Boolean(state?.canMerge && !merged && !closed);
  const bypassAvailable = Boolean(
    state?.canBypassMergeRequirements &&
      state.mergeBypassPermission === "allowed" &&
      state.revisionCurrent &&
      !missingMergePermission &&
      !merged &&
      !closed &&
      !draft &&
      !state.canMerge,
  );
  const bypassActive = bypassAvailable && bypassSelected;
  const bypassNeedsReason = bypassActive && provider === "azure_devops";
  const canSubmitMerge = Boolean(
    state?.revisionCurrent &&
      !loading &&
      (mergeReady || bypassActive) &&
      (!bypassNeedsReason || bypassReason.trim()),
  );
  const actionableError =
    error &&
    (bypassSelected || !(state && !state.canMerge && state.mergeBlockedReason))
      ? error
      : undefined;
  const summaryLabel = providerLifecycleSummaryLabel(
    summary,
    state?.checks.length ?? 0,
    { canMerge: state?.canMerge, optionalPending },
  );
  const mergeLabel = state?.mergeActionLabel ?? "Merge";
  const mergeBlockedFix =
    state?.mergeBlockedReason && state.mergeBlockedFix
      ? {
          reason: state.mergeBlockedReason,
          fix: state.mergeBlockedFix,
        }
      : undefined;
  /** Assembles the merge-block prompt from the state shown at that moment. */
  const mergeBlockedPrompt = () =>
    mergeBlockedFix
      ? mergeBlockedFixPrompt(pullRequest, {
          ...mergeBlockedFix,
          checks: state?.checks.filter((check) => check.state === "failure"),
          discussions,
        })
      : "";
  const badgeReady =
    merged || (summary !== "failing" && (summary === "passing" || mergeReady));

  useEffect(() => {
    if (mutationPending || !confirming) return;
    if (state?.pullRequestState === "merged") setConfirming(false);
  }, [confirming, mutationPending, state?.pullRequestState]);

  const bypassConsentScope = `${pullRequestUrl}:${state?.headSha}:${state?.connection.connectionId}:${bypassAvailable}`;
  useEffect(() => {
    // Consent belongs to this revision and credential permission only.
    if (consentScope.current === bypassConsentScope) return;
    consentScope.current = bypassConsentScope;
    setBypassSelected(false);
    setBypassReason("");
  }, [bypassConsentScope]);

  return (
    <>
      <section
        aria-labelledby="provider-lifecycle-title"
        className="rounded-2xl border border-line bg-panel/70 p-4"
      >
        <div
          className={
            approval ? "grid items-start gap-5 xl:grid-cols-2" : undefined
          }
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-start gap-3">
              <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
                <GitMerge className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
                  Checks and merge
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h3
                    id="provider-lifecycle-title"
                    className="text-sm text-cloud"
                  >
                    Status on {providerName}
                  </h3>
                  {state && (
                    <Badge
                      className={cn(
                        badgeReady
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
                      ) : mergeReady || summary === "passing" ? (
                        <CheckCircle2 className="size-3" />
                      ) : summary === "pending" ? (
                        <LoaderCircle className="size-3 animate-spin" />
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
            ) : error && !state ? (
              <ProviderPermissionRecovery
                kind={permissionDenied ? "merge" : "sync"}
                provider={provider}
                pullRequestUrl={pullRequestUrl}
                reviewPath={reviewPath}
              />
            ) : state ? (
              <div className="mt-4">
                {state.checks.length > 0 ? (
                  <ul className="max-h-52 max-w-2xl space-y-1 overflow-y-auto pr-1">
                    {state.checks.map((check) => (
                      <li key={check.id}>
                        <CheckRow check={check} pullRequest={pullRequest} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-mist text-[10px] leading-4">
                    {providerName} has not reported any checks or pipelines for
                    this revision yet.
                  </p>
                )}

                {readyError && (
                  <p role="alert" className="text-coral mt-3 text-xs leading-5">
                    {readyError}
                  </p>
                )}
                {actionableError && !showPermissionRecovery && (
                  <p role="alert" className="text-coral mt-3 text-xs leading-5">
                    {actionableError}
                  </p>
                )}
                {state.mergeBlockedReason &&
                  !merged &&
                  !missingMergePermission && (
                    <div className="text-mist mt-3 rounded-xl border border-line bg-surface/50 px-3 py-2 text-[10px] leading-4">
                      <p>{state.mergeBlockedReason}</p>
                      {!bypassAvailable &&
                        state.mergeable !== false &&
                        !draft &&
                        !closed &&
                        !state.canMerge && (
                          <p className="mt-1">
                            {state.mergeBypassPermission === "unsupported"
                              ? `${providerName} does not offer a merge-requirements bypass through its API.`
                              : state.mergeBypassPermission === "denied"
                                ? "The connected provider credential cannot bypass merge requirements."
                                : state.mergeBypassPermission === "unknown"
                                  ? "Bypass permission could not be verified for the connected provider credential."
                                  : null}
                          </p>
                        )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <a
                          href={pullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-cyan inline-flex items-center gap-1 hover:underline"
                        >
                          Open on {providerName}
                          <ExternalLink className="size-3" />
                        </a>
                        {mergeBlockedFix && (
                          <CopyAiFixPromptButton
                            variant="inline"
                            className="-mx-1"
                            subject="the merge block"
                            prompt={mergeBlockedPrompt}
                          />
                        )}
                      </div>
                    </div>
                  )}
                {showPermissionRecovery && (
                  <ProviderPermissionRecovery
                    kind={
                      readyError && permissionDenied
                        ? "ready"
                        : permissionDenied || missingMergePermission
                          ? "merge"
                          : "sync"
                    }
                    provider={provider}
                    connection={state.connection}
                    pullRequestUrl={pullRequestUrl}
                    reviewPath={reviewPath}
                  />
                )}
                {(summary === "failing" || optionalPending) &&
                  state.canMerge && (
                    <p className="text-mist mt-3 rounded-xl border border-line bg-surface/50 px-3 py-2 text-[10px] leading-4">
                      {summary === "failing"
                        ? `Some checks have not passed. ${providerName} still allows merging this revision.`
                        : `Some checks haven't completed yet. ${providerName} still allows merging this revision.`}
                    </p>
                  )}
              </div>
            ) : null}
          </div>
          {approval && <div className="min-w-0">{approval}</div>}
        </div>
        {bypassAvailable && (
          <div className="mt-4 rounded-xl border border-coral/25 bg-coral/5 p-3">
            <label className="text-coral flex cursor-pointer items-start gap-2 text-xs leading-5">
              <input
                type="checkbox"
                className="mt-1 accent-coral"
                checked={bypassSelected}
                disabled={loading || mutationPending}
                onChange={(event) => setBypassSelected(event.target.checked)}
              />
              <span>
                Merge without waiting for requirements to be met (bypass rules)
              </span>
            </label>
            <p className="text-mist mt-1 pl-5 text-[10px] leading-4">
              {providerName} confirms that the connected credential can bypass
              requirements. Required checks, approvals, or branch policies may
              remain unmet.
            </p>
            {bypassNeedsReason && (
              <label className="text-mist mt-3 block text-xs">
                Reason for bypassing policies
                <textarea
                  className="text-cloud mt-1 block w-full rounded-lg border border-line-strong bg-surface p-2 text-xs"
                  maxLength={500}
                  required
                  rows={2}
                  value={bypassReason}
                  disabled={mutationPending || loading}
                  onChange={(event) => setBypassReason(event.target.value)}
                />
                <span className="mt-1 block text-[10px]">
                  Saved in Azure DevOps with the completion.
                </span>
              </label>
            )}
          </div>
        )}
        {state && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {merged ? (
              <p className="text-addition text-xs">
                This pull request is merged on {providerName}.
              </p>
            ) : closed ? (
              <p className="text-mist text-xs">
                This pull request is closed on {providerName}.
              </p>
            ) : draft && onMarkReady ? (
              <Button
                type="button"
                size="sm"
                disabled={mutationPending || loading || !state.revisionCurrent}
                onClick={onMarkReady}
              >
                <GitPullRequest className="size-3.5" />
                Mark ready for review
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant={bypassActive ? "danger" : "primary"}
                disabled={mutationPending || !canSubmitMerge}
                onClick={() => setConfirming(true)}
              >
                <GitMerge className="size-3.5" />
                {bypassActive ? `${mergeLabel} with bypass` : mergeLabel}
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
        )}
      </section>

      {confirming && state && (
        <ConfirmationDialog
          title={
            bypassActive
              ? `${mergeLabel} with bypass on ${providerName}?`
              : state.canMerge
                ? `${mergeLabel} on ${providerName}?`
                : `${mergeLabel} is blocked on ${providerName}`
          }
          description={
            <>
              <p>
                {bypassActive
                  ? `This bypasses unmet ${providerName} requirements and merges the exact revision you reviewed. The action cannot be undone from ReviewDuck.`
                  : !state.canMerge
                    ? `${providerName} is not ready to accept this ${mergeLabel.toLowerCase()}. ReviewDuck refreshed the latest provider state so you can see what needs attention.`
                    : mergeLabel === "Complete"
                      ? "This completes the pull request on Azure DevOps against the exact revision you finished reviewing. The action cannot be undone from ReviewDuck."
                      : `This merges the exact revision you finished reviewing on ${providerName}. The action cannot be undone from ReviewDuck.`}
              </p>
              {bypassActive && (
                <div className="text-coral mt-3 rounded-xl border border-coral/25 bg-coral/10 px-3 py-2 text-xs leading-5">
                  <p>{state.mergeBlockedReason}</p>
                  <p>
                    Required checks, approvals, or branch policies may remain
                    unmet.
                  </p>
                  {bypassNeedsReason && (
                    <p className="mt-2">Reason: {bypassReason.trim()}</p>
                  )}
                </div>
              )}
              {actionableError && (
                <p
                  role="alert"
                  className="text-coral mt-3 rounded-xl border border-coral/25 bg-coral/10 px-3 py-2 text-xs leading-5"
                >
                  {actionableError}
                </p>
              )}
              {!bypassActive && !state.canMerge && state.mergeBlockedReason && (
                <div
                  role="alert"
                  className="text-coral mt-3 rounded-xl border border-coral/25 bg-coral/10 px-3 py-2 text-xs leading-5"
                >
                  <p>{state.mergeBlockedReason}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <a
                      href={pullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium hover:underline"
                    >
                      Open on {providerName}
                      <ExternalLink className="size-3" />
                    </a>
                    {mergeBlockedFix && (
                      <CopyAiFixPromptButton
                        variant="inline"
                        className="-mx-1 font-medium"
                        subject="the merge block"
                        prompt={mergeBlockedPrompt}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          }
          confirmLabel={bypassActive ? `${mergeLabel} with bypass` : mergeLabel}
          confirmVariant={bypassActive ? "danger" : "primary"}
          confirmDisabled={!canSubmitMerge}
          pending={mutationPending}
          pendingLabel={
            <span className="flex items-center gap-2">
              <LoaderCircle className="size-3.5 animate-spin" />
              Updating…
            </span>
          }
          icon={
            bypassActive ? (
              <ShieldAlert className="text-coral size-5" />
            ) : (
              <GitMerge className="text-cyan size-5" />
            )
          }
          iconClassName={bypassActive ? "bg-coral/10" : "bg-cyan/10"}
          onCancel={() => {
            setConfirming(false);
            setBypassSelected(false);
            setBypassReason("");
          }}
          onConfirm={() => {
            if (!canSubmitMerge) return;
            if (bypassActive) {
              onMerge({
                bypassRequirements: true,
                ...(bypassNeedsReason
                  ? { bypassReason: bypassReason.trim() }
                  : {}),
              });
            } else onMerge();
          }}
        />
      )}
    </>
  );
}

/**
 * Renders one check, pipeline, or status with its live state.
 *
 * A failed check is something the branch still has to fix, so its row also
 * offers the fix prompt; the control sits beside the link rather than inside
 * it because an anchor cannot contain a button.
 */
function CheckRow({
  check,
  pullRequest,
}: {
  check: LifecycleState["checks"][number];
  pullRequest: AiFixPromptPullRequest;
}) {
  const label = providerCheckStateLabel(check.state);
  const fixPrompt =
    check.state === "failure" ? (
      <CopyAiFixPromptButton
        className="mt-1"
        subject={`the failing check ${check.name}`}
        prompt={() => failingCheckFixPrompt(pullRequest, check)}
      />
    ) : null;
  const content = (
    <span className="flex min-w-0 flex-1 items-start gap-2.5 px-1 py-1.5">
      <CheckStateIcon state={check.state} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-cloud">{check.name}</span>
          {check.webUrl && (
            <ExternalLink className="text-fog size-3 shrink-0" />
          )}
          <span className="text-fog shrink-0 text-[10px]">{label}</span>
        </span>
        {check.description && (
          <span className="text-mist mt-0.5 block text-[10px] leading-4">
            {check.description}
          </span>
        )}
      </span>
    </span>
  );

  return (
    <div className="-mx-1 flex items-start">
      {check.webUrl ? (
        <a
          href={check.webUrl}
          target="_blank"
          rel="noreferrer"
          className="hover:bg-surface-hover/60 flex min-w-0 flex-1 rounded-xl transition"
        >
          {content}
        </a>
      ) : (
        content
      )}
      {fixPrompt}
    </div>
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
