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

/** Returns a successful provider JSON response. */
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Models GitHub permissions separately from repository admin access. */
function githubFixture(
  options: {
    permission?: boolean;
    state?: string;
    mergeable?: boolean | null;
    draft?: boolean;
    pullState?: string;
    rebaseable?: boolean | null;
    rebaseOnly?: boolean;
    noMethod?: boolean;
    push?: boolean;
    graphqlError?: boolean;
  } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/repositories/42"))
      return json({
        full_name: "acme/review",
        permissions: {
          admin: options.push !== false,
          push: options.push ?? true,
        },
        allow_merge_commit: !options.rebaseOnly && !options.noMethod,
        allow_squash_merge: false,
        allow_rebase_merge: !options.noMethod,
      });
    if (url.endsWith("/pulls/12"))
      return json({
        state: options.pullState ?? "open",
        draft: options.draft ?? false,
        head: { sha: "reviewed-sha" },
        mergeable: options.mergeable === undefined ? true : options.mergeable,
        mergeable_state: options.state ?? "behind",
        rebaseable: options.rebaseable,
      });
    if (url.endsWith("/graphql")) {
      expect(JSON.parse(String(init?.body)).query).toContain(
        "viewerCanMergeAsAdmin",
      );
      return json({
        data: {
          repository: {
            pullRequest: {
              viewerCanMergeAsAdmin: options.permission,
              reviewDecision: "REVIEW_REQUIRED",
            },
          },
        },
        ...(options.graphqlError ? { errors: [{ message: "Forbidden" }] } : {}),
      });
    }
    if (url.includes("/check-runs")) return json({ check_runs: [] });
    if (url.endsWith("/status")) return json({ statuses: [] });
    if (url.endsWith("/merge")) return json({ merged: true });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { provider: new GitHubProvider("token"), fetchMock };
}

describe("GitHub merge requirements bypass", () => {
  it.each(["behind", "blocked"])(
    "offers explicit bypass for %s only with provider permission",
    async (state) => {
      const { provider } = githubFixture({ state, permission: true });
      expect(await provider.getPullRequestLifecycle("42", 12)).toMatchObject({
        canMerge: false,
        mergeBypassPermission: "allowed",
        canBypassMergeRequirements: true,
      });
    },
  );

  it.each([
    { permission: false, expected: "denied" },
    { permission: undefined, expected: "unknown" },
    { permission: true, graphqlError: true, expected: "unknown" },
  ])(
    "does not infer bypass from admin access: $expected",
    async ({ expected, ...options }) => {
      const { provider } = githubFixture(options);
      expect(await provider.getPullRequestLifecycle("42", 12)).toMatchObject({
        mergeBypassPermission: expected,
        canBypassMergeRequirements: false,
      });
    },
  );

  it.each([
    { draft: true },
    { pullState: "closed" },
    { mergeable: false },
    { mergeable: null },
    { state: "unknown" },
    { state: "dirty" },
    { rebaseOnly: true, rebaseable: false },
    { rebaseOnly: true, rebaseable: null },
    { noMethod: true },
    { push: false },
  ])(
    "keeps physical and lifecycle blockers even with bypass permission: %j",
    async (options) => {
      const { provider } = githubFixture({ ...options, permission: true });
      expect(
        (await provider.getPullRequestLifecycle("42", 12))
          .canBypassMergeRequirements,
      ).toBe(false);
    },
  );

  it("uses the authenticated merge endpoint with the expected SHA for bypass", async () => {
    const { provider, fetchMock } = githubFixture({ permission: true });
    await provider.mergePullRequest({
      repositoryExternalId: "42",
      pullRequestNumber: 12,
      headSha: "reviewed-sha",
      bypassRequirements: true,
    });
    const request = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/merge"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      sha: "reviewed-sha",
      merge_method: "merge",
    });
  });

  it("does not report success for GitHub's merged:false response", async () => {
    const { provider, fetchMock } = githubFixture();
    fetchMock.mockImplementation(async () => json({ merged: false }));
    await expect(
      provider.mergePullRequest({
        repositoryExternalId: "42",
        pullRequestNumber: 12,
        headSha: "reviewed-sha",
      }),
    ).rejects.toThrow("did not merge");
  });
});

/** Models branch-scoped Azure permission evaluation and PR policies. */
function azureFixture(
  options: {
    allowed?: boolean;
    error?: boolean;
    mergeStatus?: string;
    draft?: boolean;
    status?: string;
    branch?: string;
  } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/permissionevaluationbatch")) {
      const request = JSON.parse(String(init?.body));
      expect(request.alwaysAllowAdministrators).toBe(false);
      expect(request.evaluations[0]).toMatchObject({
        permissions: 32768,
        securityNamespaceId: "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87",
      });
      if (options.error) return new Response("Forbidden", { status: 403 });
      return json({
        evaluations: request.evaluations.map((item: object) => ({
          ...item,
          value: options.allowed,
        })),
      });
    }
    if (url.includes("/statuses?")) return json({ value: [] });
    if (url.includes("/policy/evaluations"))
      return json({
        value: [
          {
            status: "rejected",
            configuration: {
              isBlocking: true,
              type: { displayName: "Reviewers" },
            },
          },
        ],
      });
    if (url.includes("/pullRequests/12?"))
      return json({
        status: options.status ?? "active",
        isDraft: options.draft ?? false,
        mergeStatus: options.mergeStatus ?? "rejectedByPolicy",
        targetRefName: `refs/heads/${options.branch ?? "main"}`,
        lastMergeSourceCommit: { commitId: "reviewed-sha" },
        repository: { project: { id: "project-1", name: "Project" } },
      });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    provider: new AzureDevOpsProvider("token", "https://dev.azure.com/acme"),
    fetchMock,
  };
}

describe("Azure merge requirements bypass", () => {
  it("evaluates effective permission on the case-sensitive target branch", async () => {
    const { provider, fetchMock } = azureFixture({
      allowed: true,
      branch: "Release/🚀",
    });
    expect(await provider.getPullRequestLifecycle("repo", 12)).toMatchObject({
      canMerge: false,
      canBypassMergeRequirements: true,
      mergeBypassPermission: "allowed",
    });
    const request = fetchMock.mock.calls.find(([url]) =>
      url.includes("/permissionevaluationbatch"),
    );
    expect(JSON.parse(String(request?.[1]?.body)).evaluations[0].token).toBe(
      "repoV2/project-1/repo/refs/heads/520065006c006500610073006500/3dd880de/",
    );
  });

  it.each([
    { allowed: false, expected: "denied" },
    { expected: "unknown" },
    { error: true, expected: "unknown" },
  ])(
    "fails closed when permission is $expected",
    async ({ expected, ...options }) => {
      const { provider } = azureFixture(options);
      expect(await provider.getPullRequestLifecycle("repo", 12)).toMatchObject({
        canBypassMergeRequirements: false,
        mergeBypassPermission: expected,
      });
    },
  );

  it.each([
    { draft: true },
    { status: "completed" },
    { status: "abandoned" },
    { mergeStatus: "conflicts" },
    { mergeStatus: "failure" },
    { mergeStatus: "queued" },
  ])("does not bypass hard blockers: %j", async (options) => {
    const { provider } = azureFixture({ ...options, allowed: true });
    expect(
      (await provider.getPullRequestLifecycle("repo", 12))
        .canBypassMergeRequirements,
    ).toBe(false);
  });

  it("sends explicit bypass and reason together with the reviewed SHA", async () => {
    const { provider, fetchMock } = azureFixture({ allowed: true });
    await provider.mergePullRequest({
      repositoryExternalId: "repo",
      pullRequestNumber: 12,
      headSha: "reviewed-sha",
      bypassRequirements: true,
      bypassReason: "  Emergency fix  ",
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      lastMergeSourceCommit: { commitId: "reviewed-sha" },
      completionOptions: { bypassPolicy: true, bypassReason: "Emergency fix" },
    });
  });

  it("requires a reason before submitting bypass", async () => {
    const { provider, fetchMock } = azureFixture();
    await expect(
      provider.mergePullRequest({
        repositoryExternalId: "repo",
        pullRequestNumber: 12,
        headSha: "reviewed-sha",
        bypassRequirements: true,
        bypassReason: "  ",
      }),
    ).rejects.toThrow("reason is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitLab merge requirements bypass", () => {
  it("refuses unsupported bypass without mutating project rules", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new GitLabProvider("token").mergePullRequest({
        repositoryExternalId: "42",
        pullRequestNumber: 12,
        headSha: "reviewed-sha",
        bypassRequirements: true,
      }),
    ).rejects.toThrow("does not support bypassing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
