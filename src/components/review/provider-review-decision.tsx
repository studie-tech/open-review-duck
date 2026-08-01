"use client";

import {
  Check,
  CheckCircle2,
  ExternalLink,
  GitFork,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Undo2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { cn } from "~/lib/utils";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";

type ReviewState = RouterOutputs["review"]["providerReviewState"];
type ReviewAction =
  RouterInputs["review"]["setProviderReviewDecision"]["action"];

const providerNames = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} as const;

/** Renders live provider review state and exact-revision decision controls. */
export function ProviderReviewDecision({
  error,
  loading,
  mutationPending,
  onDecision,
  onRefresh,
  pullRequestUrl,
  repositoryUrl,
  state,
}: {
  error?: string;
  loading: boolean;
  mutationPending: boolean;
  onDecision: (action: ReviewAction, body?: string) => void;
  onRefresh: () => void;
  pullRequestUrl: string;
  repositoryUrl: string;
  state?: ReviewState;
}) {
  const [confirmation, setConfirmation] = useState<ReviewAction>();
  const [reason, setReason] = useState("");
  const providerName = state ? providerNames[state.provider] : "provider";
  const decisionLabel =
    state?.decision === "approved"
      ? "Approved"
      : state?.decision === "changes_requested"
        ? state.provider === "azure_devops"
          ? "Rejected"
          : "Changes requested"
        : state?.decision === "waiting"
          ? "Waiting for author"
          : "No decision";
  const requestChangesLabel =
    state?.provider === "azure_devops" ? "Reject" : "Request changes";
  const requiresReason =
    confirmation === "request_changes" &&
    Boolean(state?.requestChangesRequiresBody);

  /** Submits the confirmed provider decision and its optional explanation. */
  function submitDecision() {
    if (!confirmation) return;
    onDecision(
      confirmation,
      confirmation === "request_changes" ? reason.trim() : undefined,
    );
  }

  useEffect(() => {
    if (mutationPending || !confirmation || !state) return;
    const applied =
      (confirmation === "approve" && state.decision === "approved") ||
      (confirmation === "request_changes" &&
        state.decision === "changes_requested") ||
      (confirmation === "clear" && state.decision === "none");
    if (applied) setConfirmation(undefined);
  }, [confirmation, mutationPending, state]);

  return (
    <>
      <section
        aria-labelledby="provider-review-title"
        className="rounded-2xl border border-line bg-panel/70 p-4"
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
              Provider approval
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h3 id="provider-review-title" className="text-sm text-cloud">
                Finish on {providerName}
              </h3>
              {state && (
                <Badge
                  className={cn(
                    state.decision === "approved"
                      ? "border-lime/25 bg-lime/10 text-lime"
                      : state.decision === "changes_requested"
                        ? "border-coral/25 bg-coral/10 text-coral"
                        : "border-line-strong bg-surface text-mist",
                  )}
                >
                  {state.decision === "approved" ? (
                    <CheckCircle2 className="size-3" />
                  ) : state.decision === "changes_requested" ? (
                    <XCircle className="size-3" />
                  ) : null}
                  {decisionLabel}
                </Badge>
              )}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Refresh provider approval state"
            title="Refresh provider approval state"
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
            Synchronizing approval state…
          </p>
        ) : error ? (
          <p role="alert" className="text-coral mt-4 text-xs leading-5">
            {error}
          </p>
        ) : state ? (
          <div className="mt-4">
            <div className="text-mist flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
              <span>
                {state.approvedCount}{" "}
                {state.approvedCount === 1 ? "approval" : "approvals"}
              </span>
              {state.requiredApprovals !== undefined && (
                <span>{state.requiredApprovals} required</span>
              )}
              {state.approvalsRemaining !== undefined && (
                <span>{state.approvalsRemaining} remaining</span>
              )}
              {state.changesRequestedCount > 0 && (
                <span className="text-coral">
                  {state.changesRequestedCount} requesting changes
                </span>
              )}
              <span className="text-fog">Live state for {state.actorName}</span>
            </div>
            {state.unavailableReason && (
              <p className="text-mist mt-3 rounded-xl border border-line bg-surface/50 px-3 py-2 text-[10px] leading-4">
                {state.unavailableReason}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {state.canApprove && state.decision !== "approved" && (
                <Button
                  type="button"
                  size="sm"
                  disabled={mutationPending}
                  onClick={() => setConfirmation("approve")}
                >
                  <Check className="size-3.5" />
                  Approve
                </Button>
              )}
              {state.canRequestChanges &&
                state.decision !== "changes_requested" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={mutationPending}
                    onClick={() => {
                      setReason("");
                      setConfirmation("request_changes");
                    }}
                  >
                    <XCircle className="size-3.5" />
                    {requestChangesLabel}
                  </Button>
                )}
              {state.canClear && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={mutationPending}
                  onClick={() => setConfirmation("clear")}
                >
                  <Undo2 className="size-3.5" />
                  {state.provider === "gitlab" ? "Unapprove" : "Clear decision"}
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

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3">
          <a
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
            className="text-mist hover:text-cyan inline-flex items-center gap-1.5 text-[10px] transition"
          >
            <GitFork className="size-3.5" />
            Repository
            <ExternalLink className="size-3" />
          </a>
          <a
            href={pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="text-mist hover:text-cyan inline-flex items-center gap-1.5 text-[10px] transition"
          >
            <GitPullRequest className="size-3.5" />
            Open pull request
            <ExternalLink className="size-3" />
          </a>
        </div>
      </section>

      {confirmation && state && (
        <ConfirmationDialog
          title={
            confirmation === "approve"
              ? `Approve on ${providerName}?`
              : confirmation === "clear"
                ? "Clear your provider decision?"
                : `${requestChangesLabel} on ${providerName}?`
          }
          description={
            confirmation === "request_changes" ? (
              <div>
                <p>
                  This decision is submitted against the exact revision you
                  finished reviewing.
                </p>
                <label
                  htmlFor="provider-review-reason"
                  className="text-cloud mt-4 block text-[10px] font-medium"
                >
                  Reason{requiresReason ? " (required)" : " (optional)"}
                </label>
                <textarea
                  id="provider-review-reason"
                  value={reason}
                  maxLength={10_000}
                  onChange={(event) => setReason(event.target.value)}
                  className="bg-ink text-cloud placeholder:text-fog focus:border-cyan/45 mt-2 min-h-28 w-full resize-y rounded-xl border border-line px-3 py-2 text-xs outline-none"
                  placeholder={
                    state.provider === "azure_devops"
                      ? "Add a note in ReviewDuck separately if context is needed."
                      : "Explain what needs to change…"
                  }
                />
              </div>
            ) : confirmation === "clear" ? (
              "This removes your current approval or vote from the provider. Your ReviewDuck sign-offs stay saved."
            ) : (
              "This records your approval on the provider against the exact revision you finished reviewing."
            )
          }
          confirmLabel={
            confirmation === "approve"
              ? "Approve"
              : confirmation === "clear"
                ? state.provider === "gitlab"
                  ? "Unapprove"
                  : "Clear decision"
                : requestChangesLabel
          }
          confirmVariant={
            confirmation === "request_changes" ? "danger" : "primary"
          }
          confirmDisabled={requiresReason && !reason.trim()}
          pending={mutationPending}
          pendingLabel={
            <span className="flex items-center gap-2">
              <LoaderCircle className="size-3.5 animate-spin" />
              Updating…
            </span>
          }
          icon={
            confirmation === "approve" ? (
              <CheckCircle2 className="text-lime size-5" />
            ) : confirmation === "clear" ? (
              <Undo2 className="text-cyan size-5" />
            ) : (
              <XCircle className="text-coral size-5" />
            )
          }
          iconClassName={
            confirmation === "approve"
              ? "bg-lime/10"
              : confirmation === "clear"
                ? "bg-cyan/10"
                : undefined
          }
          onCancel={() => setConfirmation(undefined)}
          onConfirm={submitDecision}
        />
      )}
    </>
  );
}
