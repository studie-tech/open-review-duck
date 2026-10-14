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

/** Returns a paginated GitHub JSON response without reaching the network. */
function response(data: unknown, next?: string) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      ...(next ? { link: `<${next}>; rel="next"` } : {}),
    },
  });
}

/** Builds a general PR comment containing a representative screenshot. */
function comment(id: number) {
  return {
    id,
    body: "Verified the profile setting.\n\n![Profile](https://raw.githubusercontent.com/acme/app/screenshots/profile.jpg)",
    created_at: "2026-10-13T19:34:02Z",
    html_url: `https://github.com/acme/app/pull/1873#issuecomment-${id}`,
    user: {
      login: "reviewer",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    },
  };
}

describe("GitHub PR conversation comments", () => {
  it("paginates both comment sources, preserves images, and excludes blank or pending reviews", async () => {
    const base = "https://api.github.com/repositories/42";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${base}/issues/1873/comments?per_page=100`)
        return response(
          [comment(10)],
          `${base}/issues/1873/comments?per_page=100&page=2`,
        );
      if (url === `${base}/issues/1873/comments?per_page=100&page=2`)
        return response([{ ...comment(11), user: null }]);
      if (url === `${base}/pulls/1873/reviews?per_page=100`)
        return response(
          [
            {
              id: 10,
              state: "COMMENTED",
              body: "**Review summary**",
              submitted_at: "2026-10-13T20:00:00Z",
              html_url:
                "https://github.com/acme/app/pull/1873#pullrequestreview-10",
              user: { login: "reviewer" },
            },
            {
              id: 12,
              state: "APPROVED",
              body: " \n",
              user: { login: "reviewer" },
            },
            {
              id: 13,
              state: "PENDING",
              body: "Private draft",
              user: { login: "reviewer" },
            },
          ],
          `${base}/pulls/1873/reviews?per_page=100&page=2`,
        );
      if (url === `${base}/pulls/1873/reviews?per_page=100&page=2`)
        return response([
          {
            id: 14,
            state: "CHANGES_REQUESTED",
            body: "Please fix the timeout",
            submitted_at: "2026-10-13T20:05:00Z",
            user: { login: "another-reviewer" },
          },
        ]);
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const comments = await new GitHubProvider("token").listPullRequestComments(
      "42",
      1873,
    );
    expect(comments.map(({ externalId }) => externalId)).toEqual([
      "issue-comment:10",
      "issue-comment:11",
      "review:10",
      "review:14",
    ]);
    expect(comments[0]).toMatchObject({
      kind: "comment",
      body: comment(10).body,
      author: "reviewer",
      webUrl: comment(10).html_url,
    });
    expect(comments[1]?.author).toBe("Deleted user");
    expect(comments[2]).toMatchObject({
      kind: "review",
      body: "**Review summary**",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reads edited commentary again on refresh without caching a previous body", async () => {
    let edited = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        response(
          url.includes("/issues/")
            ? [
                {
                  ...comment(10),
                  body: edited
                    ? "Updated screenshot and commentary"
                    : "Original commentary",
                },
              ]
            : [],
        ),
      ),
    );
    const provider = new GitHubProvider("token");
    expect((await provider.listPullRequestComments("42", 1873))[0]?.body).toBe(
      "Original commentary",
    );
    edited = true;
    expect((await provider.listPullRequestComments("42", 1873))[0]?.body).toBe(
      "Updated screenshot and commentary",
    );
  });

  it("preserves enterprise API prefixes and refuses cross-origin pagination", async () => {
    const url =
      "https://github.example/api/v3/repositories/42/issues/1873/comments?per_page=100";
    const fetchMock = vi.fn(async (input: string) =>
      input === url
        ? response([comment(10)], "https://attacker.example/comments?page=2")
        : response([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new GitHubProvider(
        "token",
        "https://github.example/api/v3",
      ).listPullRequestComments("42", 1873),
    ).rejects.toThrow("unsafe pagination URL");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        new URL(input).origin === "https://attacker.example",
      ),
    ).toBe(false);
  });
});
