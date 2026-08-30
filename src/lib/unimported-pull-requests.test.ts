import { describe, expect, it } from "vitest";
import {
  excludeImportedPullRequests,
  filterUnimportedPullRequests,
  sortUnimportedPullRequests,
  type UnimportedPullRequest,
  unimportedPullRequestKey,
  unimportedRepositoryKey,
} from "./unimported-pull-requests";

/** Builds one un-imported pull request with focused test overrides. */
function pullRequest(
  overrides: Partial<UnimportedPullRequest> &
    Pick<UnimportedPullRequest, "number" | "repositoryId">,
): UnimportedPullRequest {
  const { number, repositoryId, ...rest } = overrides;
  return {
    additions: 8,
    authorAvatarUrl: null,
    authorLogin: "mira",
    deletions: 1,
    externalId: `${repositoryId}-${number}`,
    number,
    provider: "github",
    repositoryId,
    repositoryName: "web",
    repositoryOwner: "acme",
    sourceBranch: "feature",
    state: "open",
    targetBranch: "main",
    title: "Prepare metrics",
    webUrl: `https://example.com/pull/${number}`,
    ...rest,
  };
}

describe("unimported pull requests", () => {
  it("keeps only open pull requests that are not already imported", () => {
    expect(
      excludeImportedPullRequests(
        [
          pullRequest({ number: 10, repositoryId: "repo-1" }),
          pullRequest({ number: 11, repositoryId: "repo-1" }),
          pullRequest({ number: 12, repositoryId: "repo-1" }),
        ],
        [11],
      ).map(({ number }) => number),
    ).toEqual([10, 12]);
  });

  it("orders by repository, then newest pull request number", () => {
    expect(
      sortUnimportedPullRequests([
        pullRequest({
          number: 3,
          repositoryId: "repo-b",
          repositoryName: "zebra",
          title: "Older zebra change",
        }),
        pullRequest({
          number: 9,
          repositoryId: "repo-b",
          repositoryName: "zebra",
          title: "Newer zebra change",
        }),
        pullRequest({
          number: 4,
          repositoryId: "repo-a",
          repositoryName: "accounts",
          title: "Accounts change",
        }),
      ]).map(({ title }) => title),
    ).toEqual(["Accounts change", "Newer zebra change", "Older zebra change"]);
  });

  it("reuses inbox search, repository, and draft filters", () => {
    const draft = pullRequest({
      number: 21,
      repositoryId: "repo-1",
      state: "draft",
      title: "Draft checkout",
    });
    const open = pullRequest({
      number: 22,
      repositoryId: "repo-1",
      provider: "gitlab",
      repositoryName: "api",
      repositoryOwner: "payments",
      title: "Retry settlement",
    });

    expect(
      filterUnimportedPullRequests([draft, open], {
        includeDrafts: false,
        provider: "all",
        repositories: [],
        search: "",
      }),
    ).toEqual([open]);
    expect(
      filterUnimportedPullRequests([draft, open], {
        provider: "gitlab",
        repositories: [unimportedRepositoryKey(open)],
        search: "payments/api #22",
      }),
    ).toEqual([open]);
    expect(unimportedPullRequestKey(open)).toBe("repo-1:22");
  });
});
