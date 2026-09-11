import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops";
import { GitHubProvider } from "./github";

vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: (url: string, init: RequestInit) =>
    globalThis.fetch(url, init),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["github", "azure"] as const)("%s PR comparison base", (kind) => {
  it.each(["modified", "renamed", "deleted"] as const)(
    "keeps %s file content stable when main advances and updates it after a rebase",
    async (changeType) => {
      const provider =
        kind === "github"
          ? new GitHubProvider("token")
          : new AzureDevOpsProvider("token", "https://dev.azure.com/acme");
      let target = "main-one";
      let head = "pr-one";
      let base = "ancestor";
      const sources: Array<{ path: string; ref: string }> = [];
      const oldPath = "old.ts";
      const path = changeType === "renamed" ? "new.ts" : oldPath;
      const fetchMock = vi.fn(async (input: string) => {
        const url = new URL(input);
        /** Returns a provider JSON response for the requested immutable revision. */
        const json = (body: unknown) => new Response(JSON.stringify(body));
        if (url.pathname.includes("/compare/")) {
          expect(url.pathname).toContain(`/compare/${target}...${head}`);
          return json({ merge_base_commit: { sha: base } });
        }
        if (url.pathname.endsWith("/diffs/commits")) {
          expect(Object.fromEntries(url.searchParams)).toMatchObject({
            baseVersion: target,
            targetVersion: head,
            baseVersionType: "commit",
            targetVersionType: "commit",
            diffCommonCommit: "true",
          });
          return json({ commonCommit: base });
        }
        if (url.pathname.endsWith("/files")) {
          return json([
            {
              filename: path,
              previous_filename: changeType === "renamed" ? oldPath : undefined,
              status: changeType === "deleted" ? "removed" : changeType,
            },
          ]);
        }
        if (url.pathname.endsWith("/iterations")) {
          return json({ value: [{ id: 1 }] });
        }
        if (url.pathname.endsWith("/changes")) {
          return json({
            changeEntries: [
              {
                item: { path: `/${path}`, gitObjectType: "blob" },
                originalPath:
                  changeType === "renamed" ? `/${oldPath}` : undefined,
                changeType:
                  changeType === "deleted"
                    ? "delete"
                    : changeType === "renamed"
                      ? "edit, rename"
                      : "edit",
              },
            ],
          });
        }
        if (
          url.pathname.includes("/contents/") ||
          url.pathname.endsWith("/items")
        ) {
          const ref =
            url.searchParams.get("ref") ??
            url.searchParams.get("versionDescriptor.version");
          const requestedPath =
            url.searchParams.get("path")?.replace(/^\//, "") ??
            url.pathname.split("/contents/")[1];
          if (!ref || !requestedPath)
            throw new Error("Missing source revision or path");
          sources.push({ path: requestedPath, ref });
          // Reading main's tip before the rebase would introduce unrelated edits.
          expect([base, head]).toContain(ref);
          return new Response(
            ref === head
              ? "export const value = 2;"
              : `export const value = 1; // ${base}`,
          );
        }
        if (kind === "github") {
          return json({
            id: 1,
            number: 1,
            title: "Change",
            body: null,
            state: "open",
            html_url: "https://github.com/acme/repo/pull/1",
            user: { login: "duck", avatar_url: "" },
            head: { ref: "feature", sha: head },
            base: { ref: "main", sha: target },
          });
        }
        return json({
          pullRequestId: 1,
          title: "Change",
          status: "active",
          isDraft: false,
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          lastMergeSourceCommit: { commitId: head },
          lastMergeTargetCommit: { commitId: target },
          repository: { webUrl: "https://dev.azure.com/acme/repo" },
          createdBy: { displayName: "Duck" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const initial = await provider.getChangedFiles("42", 1);
      target = "main-two";
      expect(await provider.getChangedFiles("42", 1)).toEqual(initial);
      expect(sources).toContainEqual({ path: oldPath, ref: "ancestor" });

      head = "pr-rebased";
      base = target;
      const [rebased] = await provider.getChangedFiles("42", 1);
      expect(
        changeType === "deleted" ? rebased?.content : rebased?.previousContent,
      ).toBe("export const value = 1; // main-two");
    },
  );

  it("refuses a comparison when the provider omits the merge base", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    const provider =
      kind === "github"
        ? new GitHubProvider("token")
        : new AzureDevOpsProvider("token", "https://dev.azure.com/acme");
    await expect(
      provider.getPullRequestDiffBase("42", "main-tip", "pr-head"),
    ).rejects.toThrow("did not return the PR merge base");
  });
});
