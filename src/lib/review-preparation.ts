import {
  type PriorityInboxItem,
  priorityInboxRepositoryKey,
} from "~/lib/priority-inbox";

export interface ReviewPreparationItem {
  provider: PriorityInboxItem["provider"];
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
  title: string | null;
}

/** Applies the shared inbox filters to preparation and failure entries. */
export function filterReviewPreparations<T extends ReviewPreparationItem>(
  preparations: readonly T[],
  filters: {
    provider: "all" | PriorityInboxItem["provider"];
    repositories: readonly string[];
    search: string;
  },
) {
  const searchTerms = filters.search
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.replace(/^[#!]/u, ""))
    .filter(Boolean);

  return preparations.filter((preparation) => {
    if (
      filters.provider !== "all" &&
      preparation.provider !== filters.provider
    ) {
      return false;
    }
    if (
      filters.repositories.length > 0 &&
      !filters.repositories.includes(priorityInboxRepositoryKey(preparation))
    ) {
      return false;
    }
    if (searchTerms.length === 0) return true;
    const haystack = [
      preparation.title,
      preparation.repositoryOwner,
      preparation.repositoryName,
      `${preparation.repositoryOwner}/${preparation.repositoryName}`,
      String(preparation.pullRequestNumber),
      preparation.provider.replace("_", " "),
      priorityInboxRepositoryKey(preparation),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return searchTerms.every((term) => haystack.includes(term));
  });
}
