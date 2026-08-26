import {
  comparePriorityInboxText,
  filterPriorityInbox,
  type PriorityInboxItem,
  priorityInboxRepositoryKey,
} from "~/lib/priority-inbox";

export interface UnimportedPullRequest {
  additions: number;
  authorAvatarUrl: string | null;
  authorLogin: string;
  deletions: number;
  externalId: string;
  number: number;
  provider: PriorityInboxItem["provider"];
  repositoryId: string;
  repositoryName: string;
  repositoryOwner: string;
  sourceBranch: string;
  state: PriorityInboxItem["state"];
  targetBranch: string;
  title: string;
  webUrl: string;
}

/** Identifies one provider pull request that is not yet in the review queue. */
export function unimportedPullRequestKey(
  pullRequest: Pick<UnimportedPullRequest, "number" | "repositoryId">,
) {
  return `${pullRequest.repositoryId}:${pullRequest.number}`;
}

/** Drops open pull requests that already have a local review row. */
export function excludeImportedPullRequests<T extends { number: number }>(
  openPullRequests: readonly T[],
  importedNumbers: Iterable<number>,
) {
  const imported = new Set(importedNumbers);
  return openPullRequests.filter(
    (pullRequest) => !imported.has(pullRequest.number),
  );
}

/** Orders un-imported pull requests by repository, then newest number. */
export function sortUnimportedPullRequests<T extends UnimportedPullRequest>(
  pullRequests: readonly T[],
) {
  return [...pullRequests].sort((left, right) => {
    const repositoryOrder = [
      comparePriorityInboxText(left.repositoryOwner, right.repositoryOwner),
      comparePriorityInboxText(left.repositoryName, right.repositoryName),
      comparePriorityInboxText(left.provider, right.provider),
    ].find((order) => order !== 0);
    if (repositoryOrder !== undefined) return repositoryOrder;
    const numberOrder = right.number - left.number;
    if (numberOrder !== 0) return numberOrder;
    return comparePriorityInboxText(left.title, right.title);
  });
}

/** Applies the inbox search, provider, repository, and draft filters. */
export function filterUnimportedPullRequests<T extends UnimportedPullRequest>(
  pullRequests: readonly T[],
  filters: {
    includeDrafts?: boolean;
    provider: "all" | PriorityInboxItem["provider"];
    repository: "all" | string;
    search: string;
  },
) {
  const allowed = new Set(
    filterPriorityInbox(pullRequests.map(asPriorityInboxItem), {
      includeDrafts: filters.includeDrafts,
      provider: filters.provider,
      repository: filters.repository,
      search: filters.search,
      view: "all",
    }).map((pullRequest) => pullRequest.id),
  );
  return pullRequests.filter((pullRequest) =>
    allowed.has(unimportedPullRequestKey(pullRequest)),
  );
}

/** Adapts an un-imported pull request to the inbox filter shape. */
function asPriorityInboxItem(
  pullRequest: UnimportedPullRequest,
): PriorityInboxItem {
  return {
    additions: pullRequest.additions,
    authorLogin: pullRequest.authorLogin,
    deletions: pullRequest.deletions,
    id: unimportedPullRequestKey(pullRequest),
    number: pullRequest.number,
    provider: pullRequest.provider,
    repositoryName: pullRequest.repositoryName,
    repositoryOwner: pullRequest.repositoryOwner,
    signedUnits: 0,
    state: pullRequest.state === "draft" ? "draft" : "open",
    title: pullRequest.title,
    totalUnits: 1,
  };
}

/** Returns the stable repository key used by the inbox repository filter. */
export function unimportedRepositoryKey(
  pullRequest: Pick<
    UnimportedPullRequest,
    "provider" | "repositoryName" | "repositoryOwner"
  >,
) {
  return priorityInboxRepositoryKey(pullRequest);
}
