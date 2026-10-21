import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github";

vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: (url: string, init: RequestInit) =>
    globalThis.fetch(url, init),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Returns a successful JSON response for the mergeability API fixtures. */
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Models independently settling REST and GraphQL responses for one revision. */
function fixture(
  options: {
    rest?: Record<string, unknown>;
    graphql?: Record<string, unknown>;
    graphqlError?: boolean;
    rebaseOnly?: boolean;
    push?: boolean;
  } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/pulls/12")) {
      return json({
        state: "open",
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        mergeable: null,
        mergeable_state: "unknown",
        ...options.rest,
      });
    }
    if (url.endsWith("/repositories/42")) {
      return json({
        full_name: "acme/review",
        permissions: { push: options.push ?? true },
        allow_merge_commit: !options.rebaseOnly,
        allow_squash_merge: false,
        allow_rebase_merge: true,
      });
    }
    if (url.endsWith("/graphql")) {
      const { query } = JSON.parse(String(init?.body));
      for (const field of [
        "headRefOid",
        "baseRefOid",
        "mergeable",
        "mergeStateStatus",
      ]) {
        expect(query).toContain(field);
      }
      return json({
        data: {
          repository: {
            pullRequest: {
              headRefOid: "head-sha",
              baseRefOid: "base-sha",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              viewerCanMergeAsAdmin: false,
              ...options.graphql,
            },
          },
        },
        ...(options.graphqlError
          ? { errors: [{ message: "Unavailable" }] }
          : {}),
      });
    }
    if (url.includes("/check-runs")) return json({ check_runs: [] });
    if (url.endsWith("/status")) return json({ statuses: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return new GitHubProvider("token");
}

describe("GitHub mergeability refresh", () => {
  it.each([
    { mergeable: null, mergeable_state: "unknown" },
    { mergeable: true, mergeable_state: "unknown" },
    { mergeable: null, mergeable_state: "clean" },
    { mergeable: undefined, mergeable_state: undefined },
  ])("uses settled GraphQL readiness when REST is %j", async (rest) => {
    const provider = fixture({ rest });
    await expect(
      provider.getPullRequestLifecycle("42", 12),
    ).resolves.toMatchObject({
      headSha: "head-sha",
      mergeable: true,
      canMerge: true,
      mergeBlockedReason: undefined,
    });
  });

  it.each([
    { headRefOid: "new-head" },
    { baseRefOid: "new-base" },
    { headRefOid: undefined },
    { baseRefOid: undefined },
    { mergeable: "UNKNOWN" },
    { mergeStateStatus: "UNKNOWN" },
    { mergeStateStatus: "DRAFT" },
    { mergeStateStatus: "UNRECOGNIZED" },
  ])(
    "keeps waiting for matching, settled GraphQL data: %j",
    async (graphql) => {
      const provider = fixture({ graphql });
      await expect(
        provider.getPullRequestLifecycle("42", 12),
      ).resolves.toMatchObject({
        mergeable: null,
        canMerge: false,
        mergeBlockedReason: "Mergeability is still being computed",
      });
    },
  );

  it("falls back to REST when GraphQL returns errors", async () => {
    const provider = fixture({ graphqlError: true });
    await expect(
      provider.getPullRequestLifecycle("42", 12),
    ).resolves.toMatchObject({
      mergeable: null,
      canMerge: false,
    });
  });

  it.each([
    {
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      reason: "Has merge conflicts",
    },
    {
      mergeStateStatus: "BEHIND",
      reason: "Branch is behind the target and must be updated",
    },
    {
      mergeStateStatus: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      reason: "Required approvals are missing",
    },
  ])(
    "preserves GitHub's settled merge block: $reason",
    async ({ reason, ...graphql }) => {
      const provider = fixture({ graphql });
      await expect(
        provider.getPullRequestLifecycle("42", 12),
      ).resolves.toMatchObject({
        canMerge: false,
        canBypassMergeRequirements: false,
        mergeBlockedReason: reason,
      });
    },
  );

  it.each([
    { rest: { mergeable: false, mergeable_state: "dirty" } },
    { rest: { mergeable: false, mergeable_state: "unknown" } },
    { rest: { mergeable: true, mergeable_state: "behind" } },
    { rest: { draft: true } },
    { rest: { state: "closed" } },
    { rest: { merged_at: "2026-10-21T09:00:00Z" } },
    { push: false },
    { rebaseOnly: true, rest: { rebaseable: false } },
    { rebaseOnly: true, rest: { rebaseable: null } },
  ])(
    "keeps existing merge restrictions with GraphQL readiness: %j",
    async (options) => {
      const provider = fixture(options);
      await expect(
        provider.getPullRequestLifecycle("42", 12),
      ).resolves.toMatchObject({
        canMerge: false,
        canBypassMergeRequirements: false,
      });
    },
  );

  it("keeps settled REST readiness when GraphQL has not settled", async () => {
    const provider = fixture({
      rest: { mergeable: true, mergeable_state: "clean" },
      graphql: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    });
    await expect(
      provider.getPullRequestLifecycle("42", 12),
    ).resolves.toMatchObject({
      mergeable: true,
      canMerge: true,
    });
  });

  it("picks up settled mergeability on the next read without a new revision", async () => {
    const graphql = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    const provider = fixture({ graphql });
    await expect(
      provider.getPullRequestLifecycle("42", 12),
    ).resolves.toMatchObject({
      headSha: "head-sha",
      canMerge: false,
    });
    Object.assign(graphql, {
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    await expect(
      provider.getPullRequestLifecycle("42", 12),
    ).resolves.toMatchObject({
      headSha: "head-sha",
      canMerge: true,
    });
  });

  it.each([
    { mergeStateStatus: "BEHIND", canBypass: true },
    { mergeStateStatus: "BLOCKED", canBypass: true },
    { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", canBypass: false },
    { headRefOid: "new-head", canBypass: false },
  ])(
    "keeps bypass eligibility scoped to verified requirements: %j",
    async ({ canBypass, ...graphql }) => {
      const provider = fixture({
        graphql: {
          viewerCanMergeAsAdmin: true,
          reviewDecision: "REVIEW_REQUIRED",
          ...graphql,
        },
      });
      await expect(
        provider.getPullRequestLifecycle("42", 12),
      ).resolves.toMatchObject({
        canMerge: false,
        canBypassMergeRequirements: canBypass,
      });
    },
  );
});
