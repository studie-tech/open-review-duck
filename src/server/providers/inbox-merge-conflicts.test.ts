import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";

vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: (url: string, init: RequestInit) =>
    globalThis.fetch(url, init),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Returns a real JSON response so provider pagination and decoding are exercised. */
function json(body: unknown) {
  return new Response(JSON.stringify(body));
}

/** Builds the list fields GitHub supplies, including its global GraphQL node ID. */
function githubPull(number: number) {
  return {
    id: number,
    node_id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    body: null,
    state: "open",
    html_url: `https://github.com/acme/app/pull/${number}`,
    user: { id: 1, login: "author", avatar_url: "" },
    head: { ref: "feature", sha: "head" },
    base: { ref: "main", sha: "base" },
  };
}

describe("inbox merge conflicts", () => {
  it("batches GitHub conflicts beyond 100 PRs and matches both branch revisions", async () => {
    const pulls = Array.from({ length: 103 }, (_, i) => githubPull(i + 1));
    const batches: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (!init?.body) return json(pulls);
        const { variables } = JSON.parse(String(init.body));
        batches.push(variables.ids);
        return json({
          data: {
            nodes: variables.ids.map((id: string) => ({
              id,
              headRefOid: id === "PR_3" ? "changed-head" : "head",
              baseRefOid: id === "PR_4" ? "changed-base" : "base",
              mergeable:
                id === "PR_1"
                  ? "MERGEABLE"
                  : id === "PR_2"
                    ? "UNKNOWN"
                    : "CONFLICTING",
            })),
          },
        });
      }),
    );
    const results = await new GitHubProvider("token").listOpenPullRequests(
      "1",
      { includeMergeConflictStatus: true },
    );
    expect(batches.map((batch) => batch.length)).toEqual([100, 3]);
    expect(results).toHaveLength(103);
    expect(results.slice(0, 5).map((pull) => pull.hasMergeConflicts)).toEqual([
      false,
      null,
      null,
      null,
      true,
    ]);
    expect(results[102]?.hasMergeConflicts).toBe(true);
  });

  it("preserves PR visibility when GraphQL fails or omits a node", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json([githubPull(1)]))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const result = await new GitHubProvider("token").listOpenPullRequests("1", {
      includeMergeConflictStatus: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.hasMergeConflicts).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      "GitHub merge-conflict lookup failed",
      {
        batchOffset: 0,
        message: expect.stringContaining("GitHub"),
      },
    );

    fetch
      .mockResolvedValueOnce(json([githubPull(1)]))
      .mockResolvedValueOnce(json({ data: { nodes: [null] } }));
    expect(
      (
        await new GitHubProvider("token").listOpenPullRequests("1", {
          includeMergeConflictStatus: true,
        })
      )[0]?.hasMergeConflicts,
    ).toBeNull();
  });

  it("logs a sanitized diagnostic rather than raw errors or credentials", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json([githubPull(1)]))
        .mockRejectedValueOnce(new Error("Bearer secret-test-token")),
    );
    await new GitHubProvider("secret-test-token").listOpenPullRequests("1", {
      includeMergeConflictStatus: true,
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "secret-test-token",
    );
  });

  it("does not request GitHub conflict status for ordinary intake reads", async () => {
    const fetch = vi.fn().mockResolvedValue(json([githubPull(1)]));
    vi.stubGlobal("fetch", fetch);
    await new GitHubProvider("token").listOpenPullRequests("1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { has_conflicts: true, expected: true },
    { detailed_merge_status: "conflict", expected: true },
    {
      has_conflicts: false,
      detailed_merge_status: "not_approved",
      merge_status: "cannot_be_merged",
      expected: false,
    },
    { detailed_merge_status: "checking", expected: null },
  ])(
    "normalizes GitLab conflicts without confusing other merge blocks: %j",
    async ({ expected, ...status }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          json([
            {
              id: 1,
              iid: 1,
              title: "PR",
              state: "opened",
              draft: false,
              source_branch: "feature",
              target_branch: "main",
              sha: "head",
              author: { username: "author" },
              ...status,
            },
          ]),
        ),
      );
      expect(
        (await new GitLabProvider("token").listOpenPullRequests("1"))[0]
          ?.hasMergeConflicts,
      ).toBe(expected);
    },
  );

  it.each([
    { mergeStatus: "conflicts", expected: true },
    { mergeStatus: "succeeded", expected: false },
    { mergeStatus: "rejectedByPolicy", expected: null },
    { mergeStatus: "queued", expected: null },
  ])(
    "normalizes Azure conflicts without confusing policies: %j",
    async ({ expected, mergeStatus }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          json({
            value: [
              {
                pullRequestId: 1,
                title: "PR",
                status: "active",
                mergeStatus,
                createdBy: { displayName: "Author" },
                repository: { id: "repo" },
                sourceRefName: "refs/heads/feature",
                targetRefName: "refs/heads/main",
                lastMergeSourceCommit: { commitId: "head" },
                lastMergeTargetCommit: { commitId: "base" },
              },
            ],
          }),
        ),
      );
      expect(
        (
          await new AzureDevOpsProvider(
            "token",
            "https://dev.azure.com/acme",
          ).listOpenPullRequests("repo")
        )[0]?.hasMergeConflicts,
      ).toBe(expected);
    },
  );
});
