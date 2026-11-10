import { describe, expect, it, vi } from "vitest";
import type { PullRequestProvider } from "~/server/providers/types";
import { reviewFileSizes } from "./file-sizes";

describe("review file sizes", () => {
  it("uses the reviewed head for live paths and the merge base for deletions", async () => {
    const getRepositoryFileSizes = vi.fn(async (_repo, ref) =>
      ref === "head"
        ? new Map([
            ["renamed.bin", 12_000_000],
            ["empty.txt", 0],
            ["unrelated.bin", 42],
          ])
        : new Map([["deleted.bin", 8_000_000]]),
    );
    const getPullRequestDiffBase = vi.fn().mockResolvedValue("merge-base");
    const result = await reviewFileSizes({
      provider: {
        getRepositoryFileSizes,
        getPullRequestDiffBase,
      } as unknown as PullRequestProvider,
      repositoryExternalId: "42",
      headSha: "head",
      baseSha: "target-tip",
      files: [
        { path: "renamed.bin", changeType: "renamed" },
        { path: "empty.txt", changeType: "added" },
        { path: "deleted.bin", changeType: "deleted" },
        { path: "missing.bin", changeType: "modified" },
      ],
    });
    expect(result).toEqual({
      "renamed.bin": 12_000_000,
      "empty.txt": 0,
      "deleted.bin": 8_000_000,
      "missing.bin": null,
    });
    expect(getRepositoryFileSizes.mock.calls).toEqual([
      ["42", "head"],
      ["42", "merge-base"],
    ]);
    expect(getPullRequestDiffBase).toHaveBeenCalledWith(
      "42",
      "target-tip",
      "head",
    );
  });

  it("keeps successful head sizes when deleted-side metadata fails", async () => {
    const getRepositoryFileSizes = vi.fn(async (_repo, ref) => {
      if (ref === "base") throw new Error("Provider unavailable");
      return new Map([["live.bin", 100]]);
    });
    expect(
      await reviewFileSizes({
        provider: { getRepositoryFileSizes } as unknown as PullRequestProvider,
        repositoryExternalId: "42",
        headSha: "head",
        baseSha: "base",
        files: [
          { path: "live.bin", changeType: "added" },
          { path: "old.bin", changeType: "deleted" },
        ],
      }),
    ).toEqual({ "live.bin": 100, "old.bin": null });
  });

  it("leaves sizes unknown when the provider has no metadata API", async () => {
    expect(
      await reviewFileSizes({
        provider: {} as PullRequestProvider,
        repositoryExternalId: "42",
        headSha: "head",
        baseSha: "base",
        files: [{ path: "binary.bin", changeType: "added" }],
      }),
    ).toEqual({ "binary.bin": null });
  });
});
