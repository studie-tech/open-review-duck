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
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo } from "react";

import type { CommandCenterItem } from "~/components/command-center";
import { usePageCommandCenter } from "~/components/page-command-center";
import { Badge } from "~/components/ui/badge";
import { priorityInboxGroup } from "~/lib/priority-inbox";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type PullRequests = RouterOutputs["review"]["dashboard"];
export type PullRequestListKind = "active" | "reviewed" | "closed" | "removed";

const providerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
};

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
}: {
  pullRequests: PullRequests;
  kind: PullRequestListKind;
  pendingPullRequestId?: string;
  onRemove?: (pullRequest: PullRequests[number]) => void;
  onRestore?: (pullRequest: PullRequests[number]) => void;
  showPriorityGroups?: boolean;
}) {
  const router = useRouter();
  const commands = useMemo<CommandCenterItem[]>(
    () =>
      kind === "active"
        ? pullRequests.map((pullRequest, index) => ({
            id: `open-pull-request-${pullRequest.id}`,
            label: `Open pull request ${index + 1}: ${pullRequest.title}`,
            description: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`,
            group: "Pull requests",
            keywords: [
              pullRequest.repositoryOwner,
              pullRequest.repositoryName,
              String(pullRequest.number),
            ],
            shortcut: positionShortcut(index + 1),
            searchOnly: true,
            onSelect: () => router.push(`/review/${pullRequest.id}`),
          }))
        : [],
    [kind, pullRequests, router],
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
    <div className="overflow-hidden rounded-2xl border border-line">
      {pullRequests.map((pullRequest, index) => {
        const position = String(index + 1);
        const matchesTypedPosition =
          !typedPosition || position.startsWith(typedPosition);
        const pending = pendingPullRequestId === pullRequest.id;
        const progress = pullRequest.totalUnits
          ? Math.round((pullRequest.signedUnits / pullRequest.totalUnits) * 100)
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
                <div className="min-w-0 flex-1">
                  <h3 className="block text-[11px] font-semibold tracking-[.08em] uppercase">
                    {priorityGroup.label}
                  </h3>
                  <span className="text-fog mt-0.5 hidden text-[10px] sm:block">
                    {priorityGroup.description}
                  </span>
                </div>
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
                isChoosingPullRequest && !matchesTypedPosition && "opacity-45",
              )}
            >
              <Link
                href={`/review/${pullRequest.id}`}
                className="flex min-w-0 flex-1 flex-col gap-4 p-5 sm:flex-row sm:items-center"
              >
                <span
                  className={cn(
                    "text-mist bg-surface-subtle grid size-10 shrink-0 place-items-center rounded-xl border border-transparent transition",
                    isChoosingPullRequest &&
                      matchesTypedPosition &&
                      "border-coral/40 bg-coral/10 text-coral",
                    kind === "reviewed" && "bg-lime/10 text-lime",
                    kind === "closed" && "bg-cyan/10 text-cyan",
                  )}
                >
                  {isChoosingPullRequest ? (
                    <kbd className="font-mono text-xs font-semibold">
                      {position}
                    </kbd>
                  ) : kind === "reviewed" ? (
                    <CheckCheck className="size-4" />
                  ) : kind === "closed" ? (
                    <GitMerge className="size-4" />
                  ) : (
                    <GitPullRequest className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge>{providerLabel[pullRequest.provider]}</Badge>
                    <span className="text-fog text-xs">
                      {pullRequest.repositoryOwner}/{pullRequest.repositoryName}{" "}
                      #{pullRequest.number}
                    </span>
                  </span>
                  <span className="mt-2 block truncate text-sm font-medium">
                    {pullRequest.title}
                  </span>
                  <span className="text-fog mt-1 block text-xs">
                    by {pullRequest.authorLogin} ·{" "}
                    <span className="text-lime">+{pullRequest.additions}</span>{" "}
                    <span className="text-red-700 dark:text-red-300">
                      −{pullRequest.deletions}
                    </span>
                  </span>
                </span>
                <span className="w-full sm:w-40">
                  <span className="text-mist flex items-center justify-between text-[10px]">
                    <span>{progressLabel(pullRequest, kind)}</span>
                    <ArrowUpRight className="size-3.5 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
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
                    <span className="bg-surface-subtle mt-2 block h-1.5 overflow-hidden rounded-full">
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

              <div className="flex shrink-0 items-center border-l border-line px-2 sm:px-3">
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
                    aria-label={`Open ${pullRequest.title} on ${providerLabel[pullRequest.provider]}`}
                    title={`Open on ${providerLabel[pullRequest.provider]}`}
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
                    onClick={() => onRemove?.(pullRequest)}
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
  );
}
