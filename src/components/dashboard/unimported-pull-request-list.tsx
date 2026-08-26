"use client";

import { ExternalLink, GitPullRequest, Loader2 } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { UnimportedPullRequest } from "~/lib/unimported-pull-requests";
import { unimportedPullRequestKey } from "~/lib/unimported-pull-requests";

const providerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
};

/** Renders open pull requests that still need to be prepared for review. */
export function UnimportedPullRequestList({
  onPrepare,
  pendingKey,
  pullRequests,
}: {
  onPrepare: (pullRequest: UnimportedPullRequest) => void;
  pendingKey?: string;
  pullRequests: UnimportedPullRequest[];
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      {pullRequests.map((pullRequest, index) => {
        const key = unimportedPullRequestKey(pullRequest);
        const pending = pendingKey === key;
        const previous = pullRequests[index - 1];
        const showGroupHeading =
          previous?.repositoryId !== pullRequest.repositoryId;
        const repositoryCount = pullRequests.filter(
          (candidate) => candidate.repositoryId === pullRequest.repositoryId,
        ).length;

        return (
          <div key={key}>
            {showGroupHeading && (
              <div className="bg-surface-subtle/65 flex items-center gap-3 border-b border-line px-5 py-3">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-coral"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="block text-[11px] font-semibold tracking-[.08em] uppercase">
                    {pullRequest.repositoryOwner}/{pullRequest.repositoryName}
                  </h3>
                  <span className="text-fog mt-0.5 hidden text-[10px] sm:block">
                    Choose which changes to prepare for review
                  </span>
                </div>
                <span className="text-fog text-[10px] tabular-nums">
                  {repositoryCount}
                </span>
              </div>
            )}
            <article className="bg-surface/70 hover:bg-surface-hover flex border-b border-line transition last-of-type:border-b-0">
              <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 p-4 sm:flex sm:items-center sm:gap-4 sm:p-5">
                <span className="text-mist bg-surface-subtle grid size-9 shrink-0 place-items-center rounded-xl sm:size-10">
                  <GitPullRequest className="size-4" />
                </span>
                <span className="min-w-0 sm:flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge>{providerLabel[pullRequest.provider]}</Badge>
                    <span className="text-fog truncate text-xs">
                      {pullRequest.repositoryOwner}/{pullRequest.repositoryName}{" "}
                      #{pullRequest.number}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-sm leading-5 font-medium sm:truncate">
                    {pullRequest.title}
                  </span>
                  <span className="text-fog mt-1 block text-xs">
                    by {pullRequest.authorLogin}
                    {pullRequest.state === "draft" ? " · Draft" : ""} ·{" "}
                    {pullRequest.sourceBranch} → {pullRequest.targetBranch}
                  </span>
                </span>
                <span className="col-start-2 flex min-w-0 flex-col items-end text-right sm:col-auto sm:ml-auto sm:shrink-0">
                  <span className="text-mist text-[10px]">
                    <span className="text-lime">+{pullRequest.additions}</span>{" "}
                    <span className="text-red-700 dark:text-red-300">
                      −{pullRequest.deletions}
                    </span>
                  </span>
                  <span className="text-fog mt-1 text-[10px]">
                    Not in your queue
                  </span>
                </span>
              </div>
              <div className="flex shrink-0 items-start gap-1 border-l border-line px-1.5 pt-4 sm:items-center sm:px-3 sm:pt-0">
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
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => onPrepare(pullRequest)}
                >
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Add for review
                </Button>
              </div>
            </article>
          </div>
        );
      })}
    </div>
  );
}
