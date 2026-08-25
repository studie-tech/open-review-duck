type PriorityInboxGroupId = "continue" | "ready" | "unreviewable";
export type PriorityInboxView = "all" | PriorityInboxGroupId;

export interface PriorityInboxItem {
  additions: number;
  authorLogin: string;
  deletions: number;
  id: string;
  number: number;
  provider: "github" | "gitlab" | "azure_devops";
  repositoryName: string;
  repositoryOwner: string;
  signedUnits: number;
  state: "open" | "draft" | "merged" | "closed";
  title: string;
  totalUnits: number;
}

export interface PriorityInboxGroup {
  id: PriorityInboxGroupId;
  label: string;
  description: string;
  rank: number;
}

const groups = {
  continue: {
    id: "continue",
    label: "Continue reviewing",
    description: "Pick up where you left off",
    rank: 0,
  },
  ready: {
    id: "ready",
    label: "Ready to start",
    description: "Prepared changes waiting for a first pass",
    rank: 1,
  },
  unreviewable: {
    id: "unreviewable",
    label: "Not reviewable here",
    description: "No supported review units were found",
    rank: 2,
  },
} satisfies Record<PriorityInboxGroupId, PriorityInboxGroup>;

/** Compares display text identically in server and browser runtimes. */
export function comparePriorityInboxText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Identifies the next useful action for one unfinished review. */
export function priorityInboxGroup(
  pullRequest: Pick<PriorityInboxItem, "signedUnits" | "totalUnits">,
): PriorityInboxGroup {
  if (pullRequest.signedUnits > 0) return groups.continue;
  if (pullRequest.totalUnits > 0) return groups.ready;
  return groups.unreviewable;
}

/** Produces a stable repository identity across providers and organizations. */
export function priorityInboxRepositoryKey(
  pullRequest: Pick<
    PriorityInboxItem,
    "provider" | "repositoryName" | "repositoryOwner"
  >,
) {
  return `${pullRequest.provider}:${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`;
}

/** Orders reviews by next action, then by stable repository context. */
export function prioritizeInbox<T extends PriorityInboxItem>(
  pullRequests: readonly T[],
) {
  return [...pullRequests].sort((left, right) => {
    const groupOrder =
      priorityInboxGroup(left).rank - priorityInboxGroup(right).rank;
    if (groupOrder !== 0) return groupOrder;
    const repositoryOrder = [
      comparePriorityInboxText(left.provider, right.provider),
      comparePriorityInboxText(left.repositoryOwner, right.repositoryOwner),
      comparePriorityInboxText(left.repositoryName, right.repositoryName),
    ].find((order) => order !== 0);
    if (repositoryOrder !== undefined) return repositoryOrder;
    const numberOrder = right.number - left.number;
    if (numberOrder !== 0) return numberOrder;
    return comparePriorityInboxText(left.title, right.title);
  });
}

/** Applies the inbox's composable view, provider, repository, and text filters. */
export function filterPriorityInbox<T extends PriorityInboxItem>(
  pullRequests: readonly T[],
  filters: {
    includeDrafts?: boolean;
    provider: "all" | PriorityInboxItem["provider"];
    repository: "all" | string;
    search: string;
    view: PriorityInboxView;
  },
) {
  const searchTerms = filters.search
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.replace(/^[#!]/u, ""))
    .filter(Boolean);
  return pullRequests.filter((pullRequest) => {
    if (filters.includeDrafts === false && pullRequest.state === "draft") {
      return false;
    }
    if (
      filters.view !== "all" &&
      priorityInboxGroup(pullRequest).id !== filters.view
    ) {
      return false;
    }
    if (
      filters.provider !== "all" &&
      pullRequest.provider !== filters.provider
    ) {
      return false;
    }
    if (
      filters.repository !== "all" &&
      priorityInboxRepositoryKey(pullRequest) !== filters.repository
    ) {
      return false;
    }
    if (searchTerms.length === 0) return true;
    const haystack = [
      pullRequest.title,
      pullRequest.authorLogin,
      pullRequest.repositoryOwner,
      pullRequest.repositoryName,
      `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`,
      String(pullRequest.number),
      pullRequest.provider.replace("_", " "),
      `${pullRequest.provider}:${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`,
    ]
      .join(" ")
      .toLowerCase();
    return searchTerms.every((term) => haystack.includes(term));
  });
}
