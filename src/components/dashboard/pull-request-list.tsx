"use client";

import { ArrowUpRight, GitPullRequest } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import type { CommandCenterItem } from "~/components/command-center";
import { usePageCommandCenter } from "~/components/page-command-center";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type PullRequests = RouterOutputs["review"]["dashboard"];

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

/** Renders the pull request list interface. */
export function PullRequestList({
  pullRequests,
}: {
  pullRequests: PullRequests;
}) {
  const router = useRouter();
  const commands = useMemo<CommandCenterItem[]>(
    () =>
      pullRequests.map((pullRequest, index) => ({
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
      })),
    [pullRequests, router],
  );
  const pendingShortcut = usePageCommandCenter(commands);
  const isChoosingPullRequest =
    pendingShortcut?.prefix[0]?.key.toLowerCase() === "g";
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

        return (
          <Link
            key={pullRequest.id}
            href={`/review/${pullRequest.id}`}
            className={cn(
              "group bg-surface/70 hover:bg-surface-hover flex flex-col gap-4 border-b border-line p-5 transition last:border-0 sm:flex-row sm:items-center",
              isChoosingPullRequest && !matchesTypedPosition && "opacity-45",
            )}
          >
            <span
              className={cn(
                "text-mist bg-surface-subtle grid size-10 shrink-0 place-items-center rounded-xl border border-transparent transition",
                isChoosingPullRequest &&
                  matchesTypedPosition &&
                  "border-coral/40 bg-coral/10 text-coral",
              )}
            >
              {isChoosingPullRequest ? (
                <kbd className="font-mono text-xs font-semibold">
                  {position}
                </kbd>
              ) : (
                <GitPullRequest className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{providerLabel[pullRequest.provider]}</Badge>
                <span className="text-fog text-xs">
                  {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #
                  {pullRequest.number}
                </span>
              </div>
              <p className="mt-2 truncate text-sm font-medium">
                {pullRequest.title}
              </p>
              <p className="text-fog mt-1 text-xs">
                by {pullRequest.authorLogin} ·{" "}
                <span className="text-lime">+{pullRequest.additions}</span>{" "}
                <span className="text-red-700 dark:text-red-300">
                  −{pullRequest.deletions}
                </span>
              </p>
            </div>
            <div className="w-full sm:w-40">
              <div className="text-mist flex items-center justify-between text-[10px]">
                <span>
                  {pullRequest.totalUnits === 0
                    ? "No supported units"
                    : `${pullRequest.signedUnits}/${pullRequest.totalUnits} reviewed`}
                </span>
                <ArrowUpRight className="size-3.5 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </div>
              <div className="bg-surface-subtle mt-2 h-1.5 overflow-hidden rounded-full">
                <div
                  className="bg-lime h-full rounded-full"
                  style={{
                    width: `${
                      pullRequest.totalUnits
                        ? Math.round(
                            (pullRequest.signedUnits / pullRequest.totalUnits) *
                              100,
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
