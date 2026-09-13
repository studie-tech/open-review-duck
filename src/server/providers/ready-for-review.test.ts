import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";

vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: (url: string, init: RequestInit) =>
    globalThis.fetch(url, init),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const input = { repositoryExternalId: "42", pullRequestNumber: 12 };

/** Queues provider JSON responses and records the HTTP requests. */
function responses(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies)
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("mark ready for review", () => {
  it("uses the GitHub node ID and checks the mutation result", async () => {
    const fetch = responses(
      { node_id: "PR_node" },
      {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      },
    );
    await new GitHubProvider("test-token").markPullRequestReadyForReview(input);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/graphql");
    const body = JSON.parse(fetch.mock.calls[1]?.[1].body);
    expect(body.variables).toEqual({ pullRequestId: "PR_node" });
    expect(body.query).toContain("markPullRequestReadyForReview");
  });
  it("reports GitHub GraphQL permission failures instead of claiming success", async () => {
    responses(
      { node_id: "PR_node" },
      { errors: [{ type: "FORBIDDEN", message: "Permission denied" }] },
    );
    await expect(
      new GitHubProvider("test-token").markPullRequestReadyForReview(input),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a GitHub response that leaves the PR in draft", async () => {
    responses(
      { node_id: "PR_node" },
      {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: true } },
        },
      },
    );
    await expect(
      new GitHubProvider("test-token").markPullRequestReadyForReview(input),
    ).rejects.toThrow("did not mark");
  });
  it("changes only the Azure draft flag", async () => {
    const fetch = responses({ isDraft: false });
    await new AzureDevOpsProvider(
      "test-token",
      "https://dev.azure.com/acme",
    ).markPullRequestReadyForReview(input);
    expect(fetch.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      isDraft: false,
    });
  });
  it("removes the GitLab draft prefix without changing the actual title", async () => {
    const fetch = responses(
      { title: "Draft: Improve draft handling" },
      { draft: false },
    );
    await new GitLabProvider("test-token").markPullRequestReadyForReview(input);
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({
      title: "Improve draft handling",
    });
  });
});
