import { describe, expect, it, vi } from "vitest";
import type { db as database } from "~/server/db";
import type { PullRequestProvider } from "~/server/providers/types";
import { downloadRepositoryFiles } from "./sync";

describe("repository branch source download", () => {
  it("stops provider reads in bounded batches once the source budget is full", async () => {
    const paths = Array.from(
      { length: 20 },
      (_value, index) => `src/file-${String(19 - index).padStart(2, "0")}.ts`,
    );
    const source = "x".repeat(2 * 1024 * 1024);
    const getFileContent = vi.fn(async () => source);
    const provider = {
      listRepositoryFiles: vi.fn(async () => paths),
      getFileContent,
    } as unknown as PullRequestProvider;

    const files = await downloadRepositoryFiles(
      {} as typeof database,
      {
        monitorId: "monitor",
        repositoryExternalId: "repository",
        ref: "revision",
      },
      provider,
    );

    expect(files).toHaveLength(20);
    expect(files.map(({ path }) => path)).toEqual([...paths].sort());
    expect(files.filter(({ skipReason }) => !skipReason)).toHaveLength(9);
    expect(
      files.filter(({ skipReason }) => skipReason === "too_large"),
    ).toHaveLength(11);
    // Three four-file batches may already be in flight when the tenth file
    // exhausts the budget; no later batch is downloaded.
    expect(getFileContent).toHaveBeenCalledTimes(12);
  });
});
