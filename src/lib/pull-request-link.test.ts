import { describe, expect, it } from "vitest";
import {
  matchesPullRequestRepository,
  parsePullRequestLink,
} from "./pull-request-link";

describe("pull request links", () => {
  it.each([
    [
      "https://github.com/team/repo/pull/42/files?x=1#diff",
      "github",
      "https://github.com/team/repo",
      42,
    ],
    [
      "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/17",
      "gitlab",
      "https://gitlab.example.com/group/subgroup/repo",
      17,
    ],
    [
      "https://dev.azure.com/org/project/_git/repo/pullrequest/9",
      "azure_devops",
      "https://dev.azure.com/org/project/_git/repo",
      9,
    ],
  ])("parses %s", (url, provider, repositoryUrl, number) => {
    expect(parsePullRequestLink(url)).toEqual({
      provider,
      repositoryUrl,
      number,
    });
  });
  it.each([
    "",
    "not a url",
    "javascript:alert(1)",
    "https://user:password@github.com/team/repo/pull/1",
    "https://github.com/team/repo",
    "https://github.com/team/repo/pull/0",
    "https://github.com/team/repo/pull/-1",
    "https://github.com/team/repo/pull/1.5",
    "https://github.com/team/repo/pull/2147483648",
    "https://github.com/team/repo/pull/9007199254740993",
  ])("rejects %s", (url) => {
    expect(parsePullRequestLink(url)).toBeNull();
  });
  it("requires the same host, repository path, and provider", () => {
    const link = parsePullRequestLink("https://github.com/Team/Repo/pull/1");
    expect(link).not.toBeNull();
    if (!link) return;
    expect(
      matchesPullRequestRepository(link, {
        provider: "github",
        webUrl: "https://github.com/team/repo/",
      }),
    ).toBe(true);
    for (const webUrl of [
      "https://evil.example/team/repo",
      "https://github.com/other/repo",
      "https://github.com/team/repo-extra",
      "http://github.com/team/repo",
    ]) {
      expect(
        matchesPullRequestRepository(link, { provider: "github", webUrl }),
      ).toBe(false);
    }
    expect(
      matchesPullRequestRepository(link, {
        provider: "gitlab",
        webUrl: link.repositoryUrl,
      }),
    ).toBe(false);
  });
  it("preserves GitLab project path case", () => {
    const link = parsePullRequestLink(
      "https://gitlab.example/Team/Repo/-/merge_requests/1",
    );
    if (!link) throw new Error("Missing test link");
    expect(
      matchesPullRequestRepository(link, {
        provider: "gitlab",
        webUrl: "https://gitlab.example/team/repo",
      }),
    ).toBe(false);
  });
});
