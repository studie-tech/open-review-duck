import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreview } from "./create-preview.mjs";

/** Creates an isolated GitHub API with a successful Vercel deployment. */
function fixture() {
  vi.stubEnv("PREVIEW_PUSH_TOKEN", "preview-credential");
  const context = {
    repo: { owner: "owner", repo: "repo" },
    eventName: "issue_comment",
    runId: 1,
    payload: {
      issue: { number: 42, pull_request: {} },
      comment: { body: "/create-preview", user: { login: "contributor" } },
    },
  };
  const github = {
    request: vi.fn(async (route) => ({
      data: route.startsWith("POST") ? { sha: "snapshot" } : {},
    })),
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi
          .fn()
          .mockResolvedValue({ data: { permission: "write" } }),
        listDeployments: vi.fn().mockResolvedValue({
          data: [
            {
              id: 1,
              creator: { login: "vercel[bot]" },
              production_environment: false,
            },
          ],
        }),
        listDeploymentStatuses: vi.fn().mockResolvedValue({
          data: [
            {
              state: "success",
              environment_url: "https://preview.vercel.app",
            },
          ],
        }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { state: "open", head: { sha: "head" } },
        }),
      },
      git: {
        getRef: vi.fn().mockResolvedValue({ data: {} }),
        getCommit: vi
          .fn()
          .mockResolvedValue({ data: { tree: { sha: "tree" } } }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 3 } }),
        updateComment: vi.fn(),
      },
    },
  };
  return { context, github, core: { setFailed: vi.fn() } };
}

afterEach(() => vi.unstubAllEnvs());
describe("command-only previews", () => {
  it("checks live contributor permissions before snapshotting the exact PR tree", async () => {
    const f = fixture();
    await runPreview(f);
    expect(
      f.github.rest.repos.getCollaboratorPermissionLevel,
    ).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      username: "contributor",
    });
    expect(f.github.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/commits",
      expect.objectContaining({ tree: "tree", parents: ["head"] }),
    );
    expect(f.github.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      expect.objectContaining({
        ref: "heads/reviewduck-preview/pr-42",
        sha: "snapshot",
      }),
    );
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("https://preview.vercel.app"),
      }),
    );
  });
  it("refuses read-only actors before reading PR code or using deployment credentials", async () => {
    const f = fixture();
    f.github.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "read" },
    });
    await runPreview(f);
    expect(f.github.request).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.get).not.toHaveBeenCalled();
  });
  it.each([
    "/create-preview-malicious",
    "please /create-preview",
    "/create-preview extra",
  ])("ignores noncommands: %s", async (body) => {
    const f = fixture();
    f.context.payload.comment.body = body;
    await runPreview(f);
    expect(f.github.request).not.toHaveBeenCalled();
    expect(
      f.github.rest.repos.getCollaboratorPermissionLevel,
    ).not.toHaveBeenCalled();
  });
  it("reports missing credentials without pushing", async () => {
    const f = fixture();
    vi.stubEnv("PREVIEW_PUSH_TOKEN", "");
    await runPreview(f);
    expect(f.github.request).not.toHaveBeenCalled();
    expect(f.core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("PREVIEW_PUSH_TOKEN"),
    );
  });
  it("removes the reserved snapshot when the PR closes", async () => {
    const f = fixture();
    f.context.eventName = "pull_request_target";
    f.context.payload.action = "closed";
    await runPreview(f);
    expect(f.github.request).toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.objectContaining({ ref: "heads/reviewduck-preview/pr-42" }),
    );
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
