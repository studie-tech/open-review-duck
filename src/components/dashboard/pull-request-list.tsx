"use client";

import {
  ArchiveX,
  ArrowUpRight,
  CheckCheck,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import type { CommandCenterItem } from "~/components/command-center";
import { PullRequestLabelPills } from "~/components/dashboard/pull-request-label-pills";
import { usePendingNavigation } from "~/components/navigation-progress";
import { usePageCommandCenter } from "~/components/page-command-center";
import {
  AiReviewStatusDialog,
  aiReviewStatusLabel,
} from "~/components/review/ai-review-status-dialog";
import { aiJobActive } from "~/components/review/review-workspace-hooks";
import { Badge } from "~/components/ui/badge";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { LinkNavigationStatus } from "~/components/ui/link-status";
import { Spinner } from "~/components/ui/spinner";
import { priorityInboxGroup } from "~/lib/priority-inbox";
import { providerLabel } from "~/lib/provider-labels";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type PullRequests = RouterOutputs["review"]["dashboard"];
export type PullRequestListKind = "active" | "reviewed" | "closed" | "removed";

/** Returns the numeric keyboard shortcut for a pull request position. */
function positionShortcut(position: number) {
  return [
    { key: "g" },
    ...String(position)
      .split("")
      .map((key) => ({ key })),
  ];
}

/** Returns queue-section-specific progress copy for one pull request. */
function progressLabel(
  pullRequest: PullRequests[number],
  kind: PullRequestListKind,
) {
  if (kind === "reviewed") return "Review complete";
  if (kind === "removed") return "Removed from your queue";
  if (kind === "closed") {
    return pullRequest.state === "merged" ? "Merged" : "Closed";
  }
  if (pullRequest.totalUnits === 0) return "No supported units";
  if (pullRequest.signedUnits > 0) return "Continue review";
  return pullRequest.state === "draft"
    ? "Draft · Ready to start"
    : "Ready to start";
}

/** Renders one section of the review inbox with reversible queue actions. */
export function PullRequestList({
  pullRequests,
  kind,
  pendingPullRequestId,
  onRemove,
  onRestore,
  showPriorityGroups = false,
  compact = false,
  canStartAiReview = false,
  aiReviewDisabled = false,
}: {
  pullRequests: PullRequests;
  kind: PullRequestListKind;
  pendingPullRequestId?: string;
  onRemove?: (pullRequest: PullRequests[number]) => void;
  onRestore?: (pullRequest: PullRequests[number]) => void;
  showPriorityGroups?: boolean;
  compact?: boolean;
  canStartAiReview?: boolean;
  aiReviewDisabled?: boolean;
}) {
  const { navigate } = usePendingNavigation();
  const [pullRequestToRemove, setPullRequestToRemove] =
    useState<PullRequests[number]>();
  const [pullRequestToReview, setPullRequestToReview] =
    useState<PullRequests[number]>();
  const showAiReview =
    canStartAiReview && (kind === "active" || kind === "reviewed");
  const reviewRuns = api.ai.reviewRuns.useQuery(
    { pullRequestIds: pullRequests.map(({ id }) => id) },
    {
      enabled: showAiReview && pullRequests.length > 0,
      refetchInterval: 4_000,
    },
  );
  const commands = useMemo<CommandCenterItem[]>(
    () => [
      ...(kind === "active"
        ? pullRequests.map((pullRequest, index) => ({
            id: `open-pull-request-${pullRequest.id}`,
            label: `Open pull request ${index + 1}: ${pullRequest.title}`,
            description: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`,
            group: "Pull requests",
            keywords: [
              pullRequest.repositoryOwner,
              pullRequest.repositoryName,
              String(pullRequest.number),
              ...pullRequest.labels.map((label) => label.name),
            ],
            shortcut: positionShortcut(index + 1),
            searchOnly: true,
            onSelect: () => navigate(`/review/${pullRequest.id}`),
          }))
        : []),
      ...(showAiReview && !aiReviewDisabled
        ? pullRequests.map((pullRequest) => ({
            id: `review-pull-request-${pullRequest.id}`,
            label: `Review with AI: ${pullRequest.title}`,
            description: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`,
            group: "Pull requests",
            keywords: [
              pullRequest.repositoryOwner,
              pullRequest.repositoryName,
              String(pullRequest.number),
              "ai",
              "review",
            ],
            icon: <Sparkles className="size-4" />,
            searchOnly: true,
            onSelect: () => setPullRequestToReview(pullRequest),
          }))
        : []),
    ],
    [aiReviewDisabled, kind, navigate, pullRequests, showAiReview],
  );
  const pendingShortcut = usePageCommandCenter(commands);
  const isChoosingPullRequest =
    kind === "active" && pendingShortcut?.prefix[0]?.key.toLowerCase() === "g";
  const typedPosition = isChoosingPullRequest
    ? pendingShortcut.prefix
        .slice(1)
        .map(({ key }) => key)
        .join("")
    : "";

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-line">
        {pullRequests.map((pullRequest, index) => {
          const position = String(index + 1);
          const matchesTypedPosition =
            !typedPosition || position.startsWith(typedPosition);
          const pending = pendingPullRequestId === pullRequest.id;
          const aiRun = reviewRuns.data?.find(
            (run) => run.pullRequestId === pullRequest.id,
          );
          const aiRunning = aiJobActive(aiRun?.status);
          const progress = pullRequest.totalUnits
            ? Math.round(
                (pullRequest.signedUnits / pullRequest.totalUnits) * 100,
              )
            : 0;
          const priorityGroup = priorityInboxGroup(pullRequest);
          const previousPullRequest = pullRequests[index - 1];
          const previousGroup = previousPullRequest
            ? priorityInboxGroup(previousPullRequest)
            : undefined;
          const showGroupHeading =
            showPriorityGroups && previousGroup?.id !== priorityGroup.id;

          return (
            <Fragment key={pullRequest.id}>
              {showGroupHeading && (
                <div className="bg-surface-subtle/65 flex items-center gap-3 border-b border-line px-5 py-3">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      priorityGroup.id === "continue"
                        ? "bg-lime"
                        : priorityGroup.id === "ready"
                          ? "bg-cyan"
                          : "bg-fog",
                    )}
                  />
                  <h3 className="min-w-0 flex-1 text-[11px] font-semibold tracking-[.08em] uppercase">
                    {priorityGroup.label}
                  </h3>
                  <span className="text-fog text-[10px] tabular-nums">
                    {
                      pullRequests.filter(
                        (candidate) =>
                          priorityInboxGroup(candidate).id === priorityGroup.id,
                      ).length
                    }
                  </span>
                </div>
              )}
              <article
                className={cn(
                  "group bg-surface/70 hover:bg-surface-hover flex border-b border-line transition last-of-type:border-b-0",
                  isChoosingPullRequest &&
                    !matchesTypedPosition &&
                    "opacity-45",
                )}
              >
                <Link
                  href={`/review/${pullRequest.id}`}
                  className={cn(
                    "grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 p-4",
                    compact ? "p-3" : "sm:flex sm:items-center sm:gap-4 sm:p-5",
                  )}
                >
                  <span
                    className={cn(
                      "text-mist bg-surface-subtle grid size-9 shrink-0 place-items-center rounded-xl border border-transparent transition sm:size-10",
                      isChoosingPullRequest &&
                        matchesTypedPosition &&
                        "border-coral/40 bg-coral/10 text-coral",
                      kind === "reviewed" && "bg-lime/10 text-lime",
                      kind === "closed" && "bg-cyan/10 text-cyan",
                    )}
                  >
                    <LinkNavigationStatus
                      idle={
                        isChoosingPullRequest ? (
                          <kbd className="font-mono text-xs font-semibold">
                            {position}
                          </kbd>
                        ) : kind === "reviewed" ? (
                          <CheckCheck className="size-4" />
                        ) : kind === "closed" ? (
                          <GitMerge className="size-4" />
                        ) : (
                          <GitPullRequest className="size-4" />
                        )
                      }
                      pending={
                        <Spinner className="navigation-pending-reveal size-4" />
                      }
                    />
                  </span>
                  <span className={cn("min-w-0", !compact && "sm:flex-1")}>
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge>{providerLabel(pullRequest.provider)}</Badge>
                      <span className="text-fog truncate text-xs">
                        {pullRequest.repositoryOwner}/
                        {pullRequest.repositoryName} #{pullRequest.number}
                      </span>
                    </span>
                    <span className="mt-1.5 block text-sm leading-5 font-medium sm:truncate">
                      {pullRequest.title}
                    </span>
                    <span className="text-fog mt-1 block text-xs">
                      by {pullRequest.authorLogin} ·{" "}
                      <span className="text-lime">
                        +{pullRequest.additions}
                      </span>{" "}
                      <span className="text-red-700 dark:text-red-300">
                        −{pullRequest.deletions}
                      </span>
                    </span>
                    <PullRequestLabelPills labels={pullRequest.labels} />
                  </span>
                  <span
                    className={cn(
                      "col-start-2 flex min-w-0 flex-col items-end text-right",
                      !compact && "sm:col-auto sm:ml-auto sm:shrink-0",
                    )}
                  >
                    <span className="text-mist flex items-center justify-end gap-2 text-[10px]">
                      <span className="min-w-0 truncate">
                        {progressLabel(pullRequest, kind)}
                      </span>
                      <ArrowUpRight className="hidden size-3.5 shrink-0 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 sm:block" />
                    </span>
                    {kind === "active" && (
                      <span className="text-fog mt-1 block text-[10px]">
                        {pullRequest.totalUnits === 0
                          ? "No supported review units"
                          : pullRequest.signedUnits > 0
                            ? `${pullRequest.signedUnits}/${pullRequest.totalUnits} units reviewed`
                            : `${pullRequest.totalUnits} review units`}
                      </span>
                    )}
                    {(kind === "reviewed" ||
                      (kind === "active" && pullRequest.signedUnits > 0)) && (
                      <span className="bg-surface-subtle mt-2 block h-1.5 w-28 overflow-hidden rounded-full">
                        <span
                          className={cn(
                            "block h-full rounded-full",
                            kind === "reviewed" ? "bg-lime" : "bg-cyan",
                          )}
                          style={{
                            width: `${kind === "reviewed" ? 100 : progress}%`,
                          }}
                        />
                      </span>
                    )}
                  </span>
                </Link>

                <div className="flex shrink-0 items-start gap-0.5 border-l border-line px-1.5 pt-4 sm:items-center sm:px-2 sm:pt-0">
                  {showAiReview && (
                    <button
                      type="button"
                      aria-label={`${aiReviewStatusLabel(aiRun)}: ${pullRequest.title}`}
                      title={aiReviewStatusLabel(aiRun)}
                      onClick={() => setPullRequestToReview(pullRequest)}
                      className={cn(
                        "hover:text-violet hover:bg-violet/[.06] flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs transition",
                        aiRun ? "text-violet" : "text-mist",
                      )}
                    >
                      {aiRunning ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {aiRun && <span>{aiReviewStatusLabel(aiRun)}</span>}
                    </button>
                  )}
                  {kind === "removed" ? (
                    <button
                      type="button"
                      aria-label={`Restore ${pullRequest.title} to my queue`}
                      title="Restore to my queue"
                      disabled={pending}
                      onClick={() => onRestore?.(pullRequest)}
                      className="text-mist hover:text-cloud hover:bg-surface-subtle grid size-9 place-items-center rounded-lg transition disabled:opacity-50"
                    >
                      {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RotateCcw className="size-4" />
                      )}
                    </button>
                  ) : kind === "closed" ? (
                    <a
                      href={pullRequest.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${pullRequest.title} on ${providerLabel(pullRequest.provider)}`}
                      title={`Open on ${providerLabel(pullRequest.provider)}`}
                      className="text-mist hover:text-cloud hover:bg-surface-subtle grid size-9 place-items-center rounded-lg transition"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${pullRequest.title} from my queue`}
                      title="Remove from my queue"
                      disabled={pending}
                      onClick={() => setPullRequestToRemove(pullRequest)}
                      className="text-mist hover:text-coral hover:bg-coral/[.06] grid size-9 place-items-center rounded-lg transition disabled:opacity-50"
                    >
                      {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ArchiveX className="size-4" />
                      )}
                    </button>
                  )}
                </div>
              </article>
            </Fragment>
          );
        })}
      </div>
      {pullRequestToRemove && (
        <ConfirmationDialog
          title="Remove this pull request from your queue?"
          description={
            <>
              <span className="text-cloud font-medium">
                {pullRequestToRemove.title}
              </span>{" "}
              stays under Removed and can be restored at any time. Automatic
              intake may bring it back after a new revision.
            </>
          }
          confirmLabel="Remove from queue"
          confirmVariant="danger"
          icon={<ArchiveX className="text-coral size-4" />}
          onCancel={() => setPullRequestToRemove(undefined)}
          onConfirm={() => {
            const target = pullRequestToRemove;
            setPullRequestToRemove(undefined);
            onRemove?.(target);
          }}
        />
      )}
      {pullRequestToReview && (
        <AiReviewStatusDialog
          pullRequestId={pullRequestToReview.id}
          startDisabled={aiReviewDisabled}
          onClose={() => setPullRequestToReview(undefined)}
        />
      )}
    </>
  );
}
