import { describe, expect, it } from "vitest";
import { terminalPullRequestState } from "./webhook-pull-request";

describe("terminal pull-request webhooks", () => {
  it("classifies a merged GitHub pull request", () => {
    expect(
      terminalPullRequestState({
        provider: "github",
        event: "pull_request",
        action: "closed",
        state: "closed",
        merged: true,
      }),
    ).toBe("merged");
  });

  it("classifies a closed but unmerged GitHub pull request", () => {
    expect(
      terminalPullRequestState({
        provider: "github",
        event: "pull_request",
        action: "closed",
        state: "closed",
        merged: false,
      }),
    ).toBe("closed");
  });

  it("leaves GitHub revision events eligible for synchronization", () => {
    expect(
      terminalPullRequestState({
        provider: "github",
        event: "pull_request",
        action: "synchronize",
        state: "open",
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ action: "merge", state: "merged" }, "merged"],
    [{ action: "close", state: "closed" }, "closed"],
  ] as const)("classifies GitLab terminal events", (event, expected) => {
    expect(
      terminalPullRequestState({
        provider: "gitlab",
        event: "Merge Request Hook",
        ...event,
      }),
    ).toBe(expected);
  });

  it.each([
    [{ event: "git.pullrequest.merged", state: "completed" }, "merged"],
    [{ event: "git.pullrequest.updated", state: "abandoned" }, "closed"],
  ] as const)("classifies Azure terminal events", (event, expected) => {
    expect(
      terminalPullRequestState({
        provider: "azure_devops",
        ...event,
      }),
    ).toBe(expected);
  });

  it("leaves open provider events eligible for synchronization", () => {
    expect(
      terminalPullRequestState({
        provider: "gitlab",
        event: "Merge Request Hook",
        action: "update",
        state: "opened",
      }),
    ).toBeUndefined();
    expect(
      terminalPullRequestState({
        provider: "azure_devops",
        event: "git.pullrequest.updated",
        state: "active",
      }),
    ).toBeUndefined();
  });
});
