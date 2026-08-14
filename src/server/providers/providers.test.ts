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

/** Stubs fetch with a successful JSON response for provider tests. */
function mockJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Creates a successful JSON response with optional additional headers. */
function jsonResponse(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Extracts a comparable URL string from any supported fetch input. */
function requestUrl(input: string | URL | Request) {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

describe("provider normalization", () => {
  it("normalizes GitHub repositories", async () => {
    mockJson([
      {
        id: 42,
        name: "review-duck",
        full_name: "acme/review-duck",
        private: true,
        html_url: "https://github.com/acme/review-duck",
        default_branch: "main",
      },
    ]);
    const repositories = await new GitHubProvider("token").listRepositories();
    expect(repositories[0]).toMatchObject({
      externalId: "42",
      owner: "acme",
      name: "review-duck",
      isPrivate: true,
    });
  });

  it("normalizes GitLab draft merge requests", async () => {
    mockJson([
      {
        id: 81,
        iid: 9,
        title: "Safer sync",
        description: null,
        state: "opened",
        draft: true,
        web_url: "https://gitlab.com/acme/review/-/merge_requests/9",
        source_branch: "sync",
        target_branch: "main",
        sha: "head",
        diff_refs: { base_sha: "base", head_sha: "head" },
        author: { username: "reviewer", avatar_url: null },
        changes_count: "4",
      },
    ]);
    const pulls = await new GitLabProvider("token").listOpenPullRequests("1");
    expect(pulls[0]).toMatchObject({
      number: 9,
      state: "draft",
      headSha: "head",
      baseSha: "base",
      changedFiles: 4,
    });
  });

  it("filters GitHub assignment without fetching every PR detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          id: 11,
          number: 7,
          title: "Review me",
          body: null,
          state: "open",
          html_url: "https://github.com/acme/review/pull/7",
          user: { id: 1, login: "author", avatar_url: "" },
          requested_reviewers: [{ id: 42, login: "reviewer" }],
          assignees: [],
          head: { ref: "feature", sha: "head" },
          base: { ref: "main", sha: "base" },
        },
        {
          id: 12,
          number: 8,
          title: "Someone else",
          body: null,
          state: "open",
          html_url: "https://github.com/acme/review/pull/8",
          user: { id: 2, login: "other", avatar_url: "" },
          requested_reviewers: [{ id: 99, login: "someone-else" }],
          assignees: [],
          head: { ref: "other", sha: "other-head" },
          base: { ref: "main", sha: "base" },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pulls = await new GitHubProvider("token").listOpenPullRequests("1", {
      reviewerExternalAccountId: "42",
    });

    expect(pulls.map((pull) => pull.number)).toEqual([7]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses provider-native reviewer filters for GitLab and Azure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await new GitLabProvider("token").listOpenPullRequests("1", {
      reviewerExternalAccountId: "42",
    });
    await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).listOpenPullRequests("repo", {
      reviewerExternalAccountId: "reviewer-id",
    });

    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toContain(
      "reviewer_id=42",
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toContain(
      "searchCriteria.reviewerId=reviewer-id",
    );
  });

  it("normalizes merged Azure DevOps pull requests", async () => {
    mockJson({
      pullRequestId: 12,
      title: "Complete review",
      status: "completed",
      isDraft: false,
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "head" },
      lastMergeTargetCommit: { commitId: "base" },
      repository: {
        id: "repo",
        name: "reviewduck",
        project: { name: "platform" },
      },
      createdBy: { displayName: "Alex Reviewer" },
    });
    const pull = await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).getPullRequest("repo", 12);
    expect(pull).toMatchObject({
      state: "merged",
      sourceBranch: "feature",
      targetBranch: "main",
      authorLogin: "Alex Reviewer",
      webUrl:
        "https://dev.azure.com/acme/platform/_git/reviewduck/pullrequest/12",
    });
  });

  it("creates and removes GitLab merge-request webhooks idempotently", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({ id: 91, url: "https://app.test/hook" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitLabProvider("token");

    await provider.ensureRepositoryWebhook({
      repositoryExternalId: "42",
      callbackUrl: "https://app.test/hook",
      secret: "signed-secret",
    });
    await provider.removeRepositoryWebhook({
      repositoryExternalId: "42",
      callbackUrl: "https://app.test/hook",
      remoteHookIds: ["91"],
    });

    const create = fetchMock.mock.calls[1];
    expect(create?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      signing_token: "signed-secret",
      merge_requests_events: true,
      enable_ssl_verification: true,
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(requestUrl(fetchMock.mock.calls[2]?.[0])).toContain("/hooks/91");
  });

  it("keeps a working GitLab hook when duplicate cleanup fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 91, url: "https://app.test/hook" },
          { id: 92, url: "https://app.test/hook" },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 91, url: "https://app.test/hook" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitLabProvider("token").ensureRepositoryWebhook({
        repositoryExternalId: "42",
        callbackUrl: "https://app.test/hook",
        secret: "signed-secret",
      }),
    ).resolves.toEqual(["91"]);

    expect(warning).toHaveBeenCalledWith(
      "Duplicate GitLab webhook cleanup failed",
      expect.objectContaining({ hookId: 92 }),
    );
  });

  it("creates the three required Azure pull-request service hooks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: [] }))
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ id: "subscription" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).ensureRepositoryWebhook({
      repositoryExternalId: "repository",
      callbackUrl: "https://app.test/api/webhooks/azure_devops",
      secret: "signed-secret",
    });

    const creations = fetchMock.mock.calls.slice(1);
    expect(creations).toHaveLength(3);
    expect(
      creations.map((call) => JSON.parse(String(call[1]?.body)).eventType),
    ).toEqual([
      "git.pullrequest.created",
      "git.pullrequest.updated",
      "git.pullrequest.merged",
    ]);
    for (const call of creations) {
      expect(JSON.parse(String(call[1]?.body)).consumerInputs).toEqual({
        url: "https://app.test/api/webhooks/azure_devops",
        basicAuthUsername: "reviewduck",
        basicAuthPassword: "signed-secret",
      });
    }
  });

  it("replaces disabled Azure subscriptions instead of reusing them", async () => {
    const callbackUrl = "https://app.test/api/webhooks/azure_devops";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: "created-active",
              status: "enabled",
              eventType: "git.pullrequest.created",
              consumerInputs: { url: callbackUrl },
              publisherInputs: { repository: "repository" },
            },
            {
              id: "updated-probation",
              status: "onProbation",
              eventType: "git.pullrequest.updated",
              consumerInputs: { url: callbackUrl },
              publisherInputs: { repository: "repository" },
            },
            {
              id: "merged-disabled",
              status: "disabledBySystem",
              eventType: "git.pullrequest.merged",
              consumerInputs: { url: callbackUrl },
              publisherInputs: { repository: "repository" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "merged-replacement" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new AzureDevOpsProvider(
        "token",
        "https://dev.azure.com/acme",
      ).ensureRepositoryWebhook({
        repositoryExternalId: "repository",
        callbackUrl,
        secret: "signed-secret",
      }),
    ).resolves.toEqual([
      "created-active",
      "updated-probation",
      "merged-replacement",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      eventType: "git.pullrequest.merged",
    });
  });

  it("removes only recorded Azure service hooks and tolerates missing hooks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).removeRepositoryWebhook({
      repositoryExternalId: "repository",
      callbackUrl: "https://app.test/api/webhooks/azure_devops?hook=opaque",
      remoteHookIds: ["first", "second"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toContain(
      "/subscriptions/first?",
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toContain(
      "/subscriptions/second?",
    );
  });

  it("follows GitHub Link pagination without guessing a page limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              id: 1,
              name: "first",
              full_name: "acme/first",
              private: false,
              html_url: "https://github.com/acme/first",
              default_branch: "main",
            },
          ],
          {
            Link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"',
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 2,
            name: "second",
            full_name: "acme/second",
            private: true,
            html_url: "https://github.com/acme/second",
            default_branch: "trunk",
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = await new GitHubProvider("token").listRepositories();

    expect(repositories.map(({ name }) => name)).toEqual(["first", "second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc&per_page=100",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/user/repos?per_page=100&page=2",
    );
  });

  it("never forwards GitHub credentials to a pagination URL on another origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([], {
          Link: '<https://attacker.example/collect>; rel="next"',
        }),
      ),
    );

    await expect(
      new GitHubProvider("token").listRepositories(),
    ).rejects.toThrow("unsafe pagination URL");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("follows Azure DevOps continuation tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            value: [
              {
                id: "one",
                name: "first",
                defaultBranch: "refs/heads/main",
                webUrl: "https://dev.azure.com/acme/project/_git/first",
                project: { name: "project" },
              },
            ],
          },
          { "x-ms-continuationtoken": "next cursor" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: "two",
              name: "second",
              defaultBranch: "refs/heads/main",
              webUrl: "https://dev.azure.com/acme/project/_git/second",
              project: { name: "project" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).listRepositories();

    expect(repositories.map(({ externalId }) => externalId)).toEqual([
      "one",
      "two",
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "continuationToken=next+cursor",
    );
  });

  it("retrieves deleted GitHub source from the base revision", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/files?")) {
        return jsonResponse([{ filename: "src/legacy.ts", status: "removed" }]);
      }
      if (url.includes("/contents/")) {
        return new Response("export function legacy() { return true }");
      }
      return jsonResponse({
        id: 11,
        number: 7,
        title: "Remove legacy code",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/review/pull/7",
        user: { login: "reviewer", avatar_url: "" },
        head: { ref: "cleanup", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new GitHubProvider("token").getChangedFiles("42", 7);

    expect(files).toEqual([
      expect.objectContaining({
        path: "src/legacy.ts",
        changeType: "deleted",
        content: "export function legacy() { return true }",
      }),
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        requestUrl(url).includes("ref=base-sha"),
      ),
    ).toBe(true);
  });

  it("loads a repository file at an exact provider revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("export const review = true;", {
        headers: { "Content-Length": "27" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubProvider("token").getFileContent(
        "42",
        "src/review helpers.ts",
        "head sha",
        150_000,
      ),
    ).resolves.toBe("export const review = true;");
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repositories/42/contents/src/review%20helpers.ts?ref=head%20sha",
    );
  });

  it("keeps GitHub base content for precise first-revision comparison", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/files?")) {
        return jsonResponse([
          { filename: "src/format.ts", status: "modified" },
        ]);
      }
      if (url.includes("/contents/") && url.includes("ref=base-sha")) {
        return new Response("export const format = () => 'before';");
      }
      if (url.includes("/contents/") && url.includes("ref=head-sha")) {
        return new Response("export const format = () => 'after';");
      }
      return jsonResponse({
        id: 12,
        number: 8,
        title: "Update formatter",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/review/pull/8",
        user: { login: "reviewer", avatar_url: "" },
        head: { ref: "format", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [file] = await new GitHubProvider("token").getChangedFiles("42", 8);

    expect(file).toMatchObject({
      changeType: "modified",
      content: "export const format = () => 'after';",
      previousContent: "export const format = () => 'before';",
    });
  });

  it("keeps smaller GitHub sources when the pull request exceeds its budget", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/files?")) {
        return jsonResponse(
          ["one.ts", "two.ts", "three.ts"].map((filename) => ({
            filename,
            status: "added",
            sha: `sha-${filename}`,
          })),
        );
      }
      if (url.includes("/contents/")) {
        return new Response(
          url.includes("/one.ts?")
            ? "1234"
            : url.includes("/two.ts?")
              ? "12"
              : "1",
        );
      }
      return jsonResponse({
        id: 13,
        number: 9,
        title: "Large change",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/review/pull/9",
        user: { login: "reviewer", avatar_url: "" },
        head: { ref: "large", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new GitHubProvider("token").getChangedFiles("42", 9, {
      maximumSourceBytes: 4,
    });

    expect(files).toEqual([
      expect.objectContaining({
        path: "one.ts",
        content: "",
        skipReason: "too_large",
      }),
      expect.objectContaining({ path: "two.ts", content: "12" }),
      expect.objectContaining({ path: "three.ts", content: "1" }),
    ]);
  });

  it("publishes GitHub comments on the selected current-revision line", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 901 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubProvider("token").publishInlineComment({
        repositoryExternalId: "42",
        pullRequestNumber: 8,
        headSha: "head-sha",
        path: "src/format.ts",
        line: 17,
        side: "right",
        body: "Could this retain the previous behavior?",
        idempotencyKey: "github-attempt",
      }),
    ).resolves.toEqual({ externalId: "901" });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://api.github.com/repositories/42/pulls/8/comments",
    );
    expect(new Headers(request?.[1]?.headers).get("idempotency-key")).toBe(
      "github-attempt",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      commit_id: "head-sha",
      path: "src/format.ts",
      line: 17,
      side: "RIGHT",
    });
  });

  it("replies to an existing GitHub review conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 902 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubProvider("token").replyToInlineThread({
        repositoryExternalId: "42",
        pullRequestNumber: 8,
        threadExternalId: "901",
        parentCommentExternalId: "901",
        body: "I agree; the retry path should retain the original error.",
      }),
    ).resolves.toEqual({ externalId: "902" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repositories/42/pulls/8/comments/901/replies",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      body: "I agree; the retry path should retain the original error.",
    });
  });

  it("groups GitHub review comment replies into inline conversations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            id: 901,
            body: "Could this retain the previous behavior?",
            path: "src/format.ts",
            line: 17,
            side: "RIGHT",
            created_at: "2026-07-20T10:00:00Z",
            html_url: "https://github.com/acme/review/pull/8#discussion_r901",
            user: { login: "reviewer", avatar_url: "https://avatars/1" },
          },
          {
            id: 902,
            in_reply_to_id: 901,
            body: "Yes, I restored that behavior.",
            path: "src/format.ts",
            line: 17,
            side: "RIGHT",
            created_at: "2026-07-20T10:05:00Z",
            html_url: "https://github.com/acme/review/pull/8#discussion_r902",
            user: { login: "author", avatar_url: "https://avatars/2" },
          },
        ]),
      ),
    );

    await expect(
      new GitHubProvider("token").listInlineCommentThreads("42", 8),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: "901",
        path: "src/format.ts",
        line: 17,
        comments: [
          expect.objectContaining({ externalId: "901", author: "reviewer" }),
          expect.objectContaining({ externalId: "902", author: "author" }),
        ],
      }),
    ]);
  });

  it("enriches GitHub conversations with GraphQL resolution state", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/pulls/8/comments?per_page=100")) {
        return jsonResponse([
          {
            id: 901,
            body: "Could this retain the previous behavior?",
            path: "src/format.ts",
            line: 17,
            side: "RIGHT",
            created_at: "2026-07-20T10:00:00Z",
            html_url: "https://github.com/acme/review/pull/8#discussion_r901",
            user: { login: "reviewer" },
          },
        ]);
      }
      if (url.endsWith("/repositories/42")) {
        return jsonResponse({
          id: 42,
          node_id: "R_kgDOReviewDuck",
          name: "review",
          full_name: "acme/review",
          private: false,
          html_url: "https://github.com/acme/review",
          default_branch: "main",
        });
      }
      if (url === "https://api.github.com/graphql") {
        return jsonResponse({
          data: {
            node: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: true,
                      comments: {
                        // The connection is not documented to be ordered, so
                        // this hands back a reply rather than the root.
                        nodes: [
                          {
                            fullDatabaseId: "902",
                            replyTo: { fullDatabaseId: "901" },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubProvider("token").listInlineCommentThreads("42", 8),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: "901",
        status: "resolved",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("normalizes GitLab repositories and authenticated identity", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/user")) {
        return jsonResponse({ id: 42, username: "duck", name: "" });
      }
      return jsonResponse([
        {
          id: 9,
          path: "review",
          path_with_namespace: "acme/platform/review",
          default_branch: "trunk",
          web_url: "https://gitlab.example/acme/platform/review",
          visibility: "public",
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitLabProvider(
      "token",
      "https://gitlab.example/api/v4",
    );

    await expect(provider.getConnectionIdentity()).resolves.toEqual({
      externalAccountId: "42",
      displayName: "duck",
    });
    await expect(provider.listRepositories()).resolves.toEqual([
      expect.objectContaining({
        externalId: "9",
        owner: "acme/platform",
        name: "review",
        defaultBranch: "trunk",
        isPrivate: false,
      }),
    ]);
  });

  it("retrieves renamed GitLab content from both revisions", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/diffs?")) {
        return jsonResponse([
          {
            old_path: "src/old.ts",
            new_path: "src/new.ts",
            deleted_file: false,
            renamed_file: true,
          },
          {
            old_path: "assets/logo.png",
            new_path: "assets/logo.png",
            deleted_file: false,
          },
        ]);
      }
      if (url.includes("/repository/files/")) {
        return new Response(url.includes("old.ts") ? "before" : "after");
      }
      return jsonResponse({
        id: 81,
        iid: 9,
        title: "Rename utility",
        description: null,
        state: "opened",
        draft: false,
        web_url: "https://gitlab.example/review/9",
        source_branch: "rename",
        target_branch: "main",
        sha: "head",
        diff_refs: { base_sha: "base", head_sha: "head" },
        author: { username: "duck", avatar_url: null },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new GitLabProvider(
      "token",
      "https://gitlab.example/api/v4",
    ).getChangedFiles("group%2Freview", 9);

    expect(files).toEqual([
      expect.objectContaining({
        path: "src/new.ts",
        content: "after",
        previousContent: "before",
        changeType: "renamed",
      }),
      expect.objectContaining({
        path: "assets/logo.png",
        content: "",
        changeType: "modified",
      }),
    ]);
  });

  it("keeps smaller GitLab sources when the merge request exceeds its budget", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/diffs?")) {
        return jsonResponse(
          ["one.ts", "two.ts", "three.ts"].map((path) => ({
            old_path: path,
            new_path: path,
            deleted_file: false,
            new_file: true,
          })),
        );
      }
      if (url.includes("/repository/files/")) {
        return new Response(
          url.includes("/one.ts/")
            ? "1234"
            : url.includes("/two.ts/")
              ? "12"
              : "1",
        );
      }
      return jsonResponse({
        id: 82,
        iid: 10,
        title: "Large change",
        description: null,
        state: "opened",
        draft: false,
        web_url: "https://gitlab.example/review/10",
        source_branch: "large",
        target_branch: "main",
        sha: "head",
        diff_refs: { base_sha: "base", head_sha: "head" },
        author: { username: "duck", avatar_url: null },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new GitLabProvider(
      "token",
      "https://gitlab.example/api/v4",
    ).getChangedFiles("group%2Freview", 10, { maximumSourceBytes: 4 });

    expect(files).toEqual([
      expect.objectContaining({
        path: "one.ts",
        content: "",
        skipReason: "too_large",
      }),
      expect.objectContaining({ path: "two.ts", content: "12" }),
      expect.objectContaining({ path: "three.ts", content: "1" }),
    ]);
  });

  it("rejects an invalid GitLab pagination cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([], {
          "x-next-page": "not-a-page",
        }),
      ),
    );

    await expect(
      new GitLabProvider("token").listRepositories(),
    ).rejects.toThrow("invalid pagination cursor");
  });

  it("publishes GitLab discussions with a diff position", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          diff_refs: {
            base_sha: "base",
            start_sha: "start",
            head_sha: "head",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "discussion-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitLabProvider("token").publishInlineComment({
        repositoryExternalId: "9",
        pullRequestNumber: 4,
        headSha: "head",
        path: "src/check.ts",
        line: 21,
        side: "right",
        body: "This condition looks inverted.",
        idempotencyKey: "gitlab-attempt",
      }),
    ).resolves.toEqual({ externalId: "discussion-1" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      position: {
        base_sha: "base",
        start_sha: "start",
        head_sha: "head",
        new_path: "src/check.ts",
        new_line: 21,
      },
    });
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key"),
    ).toBe("gitlab-attempt");
  });

  it("replies inside an existing GitLab discussion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 17 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitLabProvider("token").replyToInlineThread({
        repositoryExternalId: "9",
        pullRequestNumber: 4,
        threadExternalId: "discussion-1",
        parentCommentExternalId: "16",
        body: "Updated—the condition now preserves the previous behavior.",
      }),
    ).resolves.toEqual({ externalId: "17" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/9/merge_requests/4/discussions/discussion-1/notes",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      body: "Updated—the condition now preserves the previous behavior.",
    });
  });

  it("normalizes GitLab diff discussions and replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            id: "discussion-1",
            notes: [
              {
                id: 1,
                body: "This condition looks inverted.",
                created_at: "2026-07-20T10:00:00Z",
                author: { name: "Reviewer", username: "reviewer" },
                resolvable: true,
                resolved: false,
                position: {
                  new_path: "src/check.ts",
                  new_line: 21,
                },
              },
              {
                id: 2,
                body: "Fixed in the latest push.",
                created_at: "2026-07-20T10:05:00Z",
                author: { name: "Author", username: "author" },
              },
            ],
          },
        ]),
      ),
    );

    await expect(
      new GitLabProvider(
        "token",
        "https://gitlab.example/api/v4",
      ).listInlineCommentThreads("9", 4),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: "discussion-1",
        path: "src/check.ts",
        line: 21,
        status: "open",
        comments: [
          expect.objectContaining({ author: "Reviewer" }),
          expect.objectContaining({ author: "Author" }),
        ],
      }),
    ]);
  });

  it("handles Azure identity and a pull request with no changes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("connectionData")) {
        return jsonResponse({
          authenticatedUser: { id: "user-1", providerDisplayName: "Duck" },
        });
      }
      return jsonResponse({ value: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    );

    await expect(provider.getConnectionIdentity()).resolves.toEqual({
      externalAccountId: "user-1",
      displayName: "Duck",
    });
    await expect(provider.getChangedFiles("repo", 12)).resolves.toEqual([]);
  });

  it("retrieves modified Azure source from both revisions", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/iterations?")) {
        return jsonResponse({ value: [{ id: 3 }] });
      }
      if (url.includes("/iterations/3/changes?")) {
        return jsonResponse({
          changeEntries: [
            {
              item: {
                path: null,
                gitObjectType: "blob",
              },
              changeType: "edit",
            },
            {
              item: {
                path: "/src/sync.py",
                gitObjectType: "blob",
              },
              changeType: "edit",
            },
          ],
        });
      }
      if (url.includes("/items?")) {
        return new Response(
          url.includes("version=base-sha") ? "before()" : "after()",
        );
      }
      return jsonResponse({
        pullRequestId: 12,
        title: "Update sync",
        status: "active",
        isDraft: false,
        sourceRefName: "refs/heads/sync",
        targetRefName: "refs/heads/main",
        lastMergeSourceCommit: { commitId: "head-sha" },
        lastMergeTargetCommit: { commitId: "base-sha" },
        repository: { webUrl: "https://dev.azure.com/acme/repo" },
        createdBy: { displayName: "Duck", uniqueName: "duck@example.com" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).getChangedFiles("repo", 12);

    expect(files).toEqual([
      expect.objectContaining({
        path: "src/sync.py",
        content: "after()",
        previousContent: "before()",
        changeType: "modified",
      }),
    ]);
  });

  it("keeps smaller Azure sources when the pull request exceeds its budget", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes("/iterations?")) {
        return jsonResponse({ value: [{ id: 3 }] });
      }
      if (url.includes("/iterations/3/changes?")) {
        return jsonResponse({
          changeEntries: ["one.ts", "two.ts", "three.ts"].map((path) => ({
            item: { path: `/${path}`, gitObjectType: "blob" },
            changeType: "add",
          })),
        });
      }
      if (url.includes("/items?")) {
        const path = new URL(url).searchParams.get("path");
        return new Response(
          path === "/one.ts" ? "1234" : path === "/two.ts" ? "12" : "1",
        );
      }
      return jsonResponse({
        pullRequestId: 12,
        title: "Large change",
        status: "active",
        isDraft: false,
        sourceRefName: "refs/heads/large",
        targetRefName: "refs/heads/main",
        lastMergeSourceCommit: { commitId: "head-sha" },
        lastMergeTargetCommit: { commitId: "base-sha" },
        repository: { webUrl: "https://dev.azure.com/acme/repo" },
        createdBy: { displayName: "Duck" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const files = await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).getChangedFiles("repo", 12, { maximumSourceBytes: 4 });

    expect(files).toEqual([
      expect.objectContaining({
        path: "one.ts",
        content: "",
        skipReason: "too_large",
      }),
      expect.objectContaining({ path: "two.ts", content: "12" }),
      expect.objectContaining({ path: "three.ts", content: "1" }),
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).includes("/items?"),
      ),
    ).toHaveLength(3);
  });

  it("publishes Azure DevOps threads on the selected line", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 71 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new AzureDevOpsProvider(
        "token",
        "https://dev.azure.com/acme",
      ).publishInlineComment({
        repositoryExternalId: "repo",
        pullRequestNumber: 12,
        headSha: "head",
        path: "src/sync.py",
        line: 8,
        side: "right",
        body: "Should this be awaited?",
        idempotencyKey: "azure-attempt",
      }),
    ).resolves.toEqual({ externalId: "71" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      threadContext: {
        filePath: "/src/sync.py",
        rightFileStart: { line: 8, offset: 1 },
      },
    });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
    ).toBe("azure-attempt");
  });

  it("replies inside an existing Azure DevOps pull-request thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 2,
        content: "It is awaited now.",
        commentType: "text",
        publishedDate: "2026-07-20T10:05:00Z",
        author: { displayName: "Author" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new AzureDevOpsProvider(
        "token",
        "https://dev.azure.com/acme",
      ).replyToInlineThread({
        repositoryExternalId: "repo",
        pullRequestNumber: 12,
        threadExternalId: "71",
        parentCommentExternalId: "1",
        body: "It is awaited now.",
      }),
    ).resolves.toEqual({ externalId: "2" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://dev.azure.com/acme/_apis/git/repositories/repo/pullRequests/12/threads/71/comments?api-version=7.1",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      content: "It is awaited now.",
      parentCommentId: 1,
      commentType: 1,
    });
  });

  it("normalizes Azure DevOps inline threads and replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          value: [
            {
              id: 71,
              status: "active",
              threadContext: {
                filePath: "/src/sync.py",
                rightFileStart: { line: 8, offset: 1 },
              },
              comments: [
                {
                  id: 1,
                  content: "Should this be awaited?",
                  commentType: "text",
                  publishedDate: "2026-07-20T10:00:00Z",
                  author: { displayName: "Reviewer" },
                },
                {
                  id: 2,
                  content: "It is awaited now.",
                  commentType: "text",
                  publishedDate: "2026-07-20T10:05:00Z",
                  author: { displayName: "Author" },
                },
              ],
            },
          ],
        }),
      ),
    );

    await expect(
      new AzureDevOpsProvider(
        "token",
        "https://dev.azure.com/acme",
      ).listInlineCommentThreads("repo", 12),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: "71",
        path: "src/sync.py",
        line: 8,
        status: "open",
        comments: [
          expect.objectContaining({ author: "Reviewer" }),
          expect.objectContaining({ author: "Author" }),
        ],
      }),
    ]);
  });

  it("synchronizes and submits GitHub user review decisions at an exact commit", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/reviews?per_page=100")) {
          return jsonResponse([
            { id: 1, state: "APPROVED", user: { id: 7, login: "duck" } },
            {
              id: 2,
              state: "CHANGES_REQUESTED",
              user: { id: 8, login: "goose" },
            },
          ]);
        }
        if (url.endsWith("/pulls/12")) {
          return jsonResponse({
            id: 12,
            number: 12,
            title: "Review decisions",
            body: null,
            state: "open",
            html_url: "https://github.com/acme/review/pull/12",
            user: { id: 9, login: "author", avatar_url: "" },
            head: { ref: "feature", sha: "head-sha" },
            base: { ref: "main", sha: "base-sha" },
          });
        }
        if (url.endsWith("/user")) {
          return jsonResponse({ id: 7, login: "duck", name: "Duck Reviewer" });
        }
        if (url.endsWith("/reviews") && init?.method === "POST") {
          return jsonResponse({
            id: 3,
            state: "CHANGES_REQUESTED",
            user: { id: 7, login: "duck" },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitHubProvider("token");

    await expect(
      provider.getPullRequestReviewState("42", 12),
    ).resolves.toMatchObject({
      decision: "approved",
      actorName: "Duck Reviewer",
      approvedCount: 1,
      changesRequestedCount: 1,
      canApprove: false,
      canRequestChanges: true,
      requestChangesRequiresBody: true,
    });
    await provider.setPullRequestReviewDecision({
      repositoryExternalId: "42",
      pullRequestNumber: 12,
      headSha: "head-sha",
      action: "request_changes",
      body: "Please cover the failure path.",
    });

    const reviewRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/reviews") && init?.method === "POST",
    );
    expect(JSON.parse(String(reviewRequest?.[1]?.body))).toEqual({
      commit_id: "head-sha",
      event: "REQUEST_CHANGES",
      body: "Please cover the failure path.",
    });
  });

  it("keeps GitHub App installations read-only for personal decisions", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/reviews?per_page=100")) return jsonResponse([]);
      if (url.endsWith("/pulls/12")) {
        return jsonResponse({
          id: 12,
          number: 12,
          title: "Review decisions",
          body: null,
          state: "open",
          html_url: "https://github.com/acme/review/pull/12",
          user: { id: 9, login: "author", avatar_url: "" },
          head: { ref: "feature", sha: "head-sha" },
          base: { ref: "main", sha: "base-sha" },
        });
      }
      if (url.endsWith("/installation")) {
        return jsonResponse({
          id: 17,
          account: { id: 7, login: "acme" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitHubProvider(
      "token",
      "https://api.github.com",
      true,
    );

    await expect(
      provider.getPullRequestReviewState("42", 12),
    ).resolves.toMatchObject({
      decision: "none",
      canApprove: false,
      canRequestChanges: false,
      actorName: "connected GitHub App",
    });
    await expect(
      provider.setPullRequestReviewDecision({
        repositoryExternalId: "42",
        pullRequestNumber: 12,
        headSha: "head-sha",
        action: "approve",
      }),
    ).rejects.toThrow("personal review decision");
  });

  it("synchronizes GitLab approval requirements and sends the exact head SHA", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/approvals")) {
          return jsonResponse({
            approvals_required: 2,
            approvals_left: 1,
            approved_by: [
              { user: { id: 8, name: "Goose", username: "goose" } },
            ],
          });
        }
        if (url.endsWith("/user")) {
          return jsonResponse({ id: 7, name: "Duck", username: "duck" });
        }
        if (url.endsWith("/merge_requests/12")) {
          return jsonResponse({
            id: 12,
            iid: 12,
            title: "Review decisions",
            description: null,
            state: "opened",
            draft: false,
            web_url: "https://gitlab.com/acme/review/-/merge_requests/12",
            source_branch: "feature",
            target_branch: "main",
            sha: "head-sha",
            diff_refs: { base_sha: "base-sha", head_sha: "head-sha" },
            author: { id: 9, username: "author", avatar_url: null },
          });
        }
        if (url.endsWith("/approve") && init?.method === "POST") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitLabProvider("token");

    await expect(
      provider.getPullRequestReviewState("42", 12),
    ).resolves.toMatchObject({
      decision: "none",
      actorName: "Duck",
      approvedCount: 1,
      requiredApprovals: 2,
      approvalsRemaining: 1,
      canApprove: true,
      canRequestChanges: false,
    });
    await provider.setPullRequestReviewDecision({
      repositoryExternalId: "42",
      pullRequestNumber: 12,
      headSha: "head-sha",
      action: "approve",
    });
    const approvalRequest = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/approve"),
    );
    expect(JSON.parse(String(approvalRequest?.[1]?.body))).toEqual({
      sha: "head-sha",
    });
  });

  it("normalizes and changes the connected Azure DevOps reviewer vote", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("connectionData")) {
          return jsonResponse({
            authenticatedUser: {
              id: "reviewer-1",
              providerDisplayName: "Duck",
            },
          });
        }
        if (url.includes("/reviewers?")) {
          return jsonResponse({
            value: [
              { id: "reviewer-1", displayName: "Duck", vote: -5 },
              { id: "reviewer-2", displayName: "Goose", vote: 10 },
            ],
          });
        }
        if (url.includes("/reviewers/reviewer-1") && init?.method === "PUT") {
          return new Response(null, { status: 204 });
        }
        if (url.includes("/pullRequests/12?")) {
          return jsonResponse({
            pullRequestId: 12,
            title: "Review decisions",
            status: "active",
            isDraft: false,
            sourceRefName: "refs/heads/feature",
            targetRefName: "refs/heads/main",
            lastMergeSourceCommit: { commitId: "head-sha" },
            lastMergeTargetCommit: { commitId: "base-sha" },
            repository: { webUrl: "https://dev.azure.com/acme/repo" },
            createdBy: { id: "author-1", displayName: "Author" },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    );

    await expect(
      provider.getPullRequestReviewState("repo", 12),
    ).resolves.toMatchObject({
      decision: "waiting",
      actorName: "Duck",
      approvedCount: 1,
      canApprove: true,
      canRequestChanges: true,
      canClear: true,
    });
    await provider.setPullRequestReviewDecision({
      repositoryExternalId: "repo",
      pullRequestNumber: 12,
      headSha: "head-sha",
      action: "request_changes",
    });
    const voteRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).includes("/reviewers/reviewer-1") &&
        init?.method === "PUT",
    );
    expect(JSON.parse(String(voteRequest?.[1]?.body))).toEqual({
      id: "reviewer-1",
      vote: -10,
    });
  });

  it("resolves a GitHub conversation through its review-thread node", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init) => {
      const url = requestUrl(input);
      requests.push({ url, body: init?.body?.toString() });
      if (url.endsWith("/repositories/42")) {
        return jsonResponse({
          id: 42,
          node_id: "R_kgDOReviewDuck",
          name: "review",
          full_name: "acme/review",
          private: false,
          html_url: "https://github.com/acme/review",
          default_branch: "main",
        });
      }
      if (url === "https://api.github.com/graphql") {
        const body = init?.body?.toString() ?? "";
        if (body.includes("ReviewDuckSetReviewThreadResolution")) {
          return jsonResponse({
            data: { resolveReviewThread: { thread: { isResolved: true } } },
          });
        }
        return jsonResponse({
          data: {
            node: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_thread",
                      isResolved: false,
                      comments: {
                        nodes: [{ fullDatabaseId: "901", replyTo: null }],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubProvider("token").setInlineThreadResolution({
        repositoryExternalId: "42",
        pullRequestNumber: 8,
        threadExternalId: "901",
        resolved: true,
      }),
    ).resolves.toBeUndefined();

    const mutation = requests.at(-1);
    expect(mutation?.body).toContain("resolveReviewThread");
    expect(mutation?.body).toContain("PRRT_thread");
  });

  it("reports a failed thread lookup rather than a missing conversation", async () => {
    // A refused GraphQL request must not read as "no such conversation".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/repositories/42")) {
          return jsonResponse({
            id: 42,
            node_id: "R_kgDOReviewDuck",
            name: "review",
            full_name: "acme/review",
            private: false,
            html_url: "https://github.com/acme/review",
            default_branch: "main",
          });
        }
        // The walk itself is what fails: its result is what a missing thread
        // would otherwise be read from.
        if (url === "https://api.github.com/graphql") {
          return new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      }),
    );

    await expect(
      new GitHubProvider("token").setInlineThreadResolution({
        repositoryExternalId: "42",
        pullRequestNumber: 8,
        threadExternalId: "901",
        resolved: true,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("edits and deletes GitHub review comments on the documented route", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init) => {
      const url = requestUrl(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/repositories/42")) {
        return jsonResponse({
          id: 42,
          name: "review",
          full_name: "acme/review",
          private: false,
          html_url: "https://github.com/acme/review",
          default_branch: "main",
        });
      }
      if (url.includes("/repos/acme/review/pulls/comments/901")) {
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : jsonResponse({ id: 901, body: "Rewritten." });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GitHubProvider("token");
    await provider.editInlineComment({
      repositoryExternalId: "42",
      pullRequestNumber: 8,
      threadExternalId: "901",
      commentExternalId: "901",
      body: "Rewritten.",
    });
    await provider.deleteInlineComment({
      repositoryExternalId: "42",
      pullRequestNumber: 8,
      threadExternalId: "901",
      commentExternalId: "901",
    });

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.github.com/repositories/42",
      "PATCH https://api.github.com/repos/acme/review/pulls/comments/901",
      "DELETE https://api.github.com/repos/acme/review/pulls/comments/901",
    ]);
  });

  it("resolves an Azure DevOps conversation as fixed", async () => {
    let patched: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init) => {
        const url = requestUrl(input);
        if (url.includes("/threads/77")) {
          patched = init?.body?.toString();
          return jsonResponse({ id: 77, status: "fixed" });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      }),
    );

    await new AzureDevOpsProvider(
      "token",
      "https://dev.azure.com/acme",
    ).setInlineThreadResolution({
      repositoryExternalId: "repo",
      pullRequestNumber: 12,
      threadExternalId: "77",
      resolved: true,
    });

    expect(patched).toBe(JSON.stringify({ status: "fixed" }));
  });

  it("resolves a GitLab discussion through its discussion route", async () => {
    let resolved: string | undefined;
    let method: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init) => {
        const url = requestUrl(input);
        if (url.includes("/discussions/abc123")) {
          resolved = init?.body?.toString();
          method = init?.method;
          return jsonResponse({ id: "abc123", notes: [] });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      }),
    );

    await new GitLabProvider("token").setInlineThreadResolution({
      repositoryExternalId: "9",
      pullRequestNumber: 4,
      threadExternalId: "abc123",
      resolved: true,
    });

    expect(method).toBe("PUT");
    expect(resolved).toBe(JSON.stringify({ resolved: true }));
  });
});
