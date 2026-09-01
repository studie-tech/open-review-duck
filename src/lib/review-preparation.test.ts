import { describe, expect, it } from "vitest";
import { filterReviewPreparations } from "./review-preparation";

const preparations = [
  {
    provider: "github" as const,
    pullRequestNumber: 42,
    repositoryOwner: "reviewduck",
    repositoryName: "app",
    title: "Move progress into the inbox",
  },
  {
    provider: "azure_devops" as const,
    pullRequestNumber: 18_622,
    repositoryOwner: "DSAIE",
    repositoryName: "hub-app",
    title: null,
  },
];

describe("review preparation filters", () => {
  it("matches provider, repository, pull request number, and title", () => {
    expect(
      filterReviewPreparations(preparations, {
        provider: "github",
        repositories: ["github:reviewduck/app"],
        search: "#42 progress",
      }),
    ).toEqual([preparations[0]]);
  });

  it("keeps title-less entries searchable by provider and repository", () => {
    expect(
      filterReviewPreparations(preparations, {
        provider: "all",
        repositories: [],
        search: "azure devops dsaie/hub-app 18622",
      }),
    ).toEqual([preparations[1]]);
  });
});
