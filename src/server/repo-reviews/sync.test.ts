import { describe, expect, it, vi } from "vitest";
import type { db as database } from "~/server/db";
import type { PullRequestProvider } from "~/server/providers/types";
import {
  downloadRepositoryFiles,
  MAX_REPOSITORY_FILE_BYTES,
  REPOSITORY_SOURCE_BUDGET_BYTES,
  repositoryChangedFileCount,
} from "./sync";

describe("repository branch source download", () => {
  it("counts a newly readable prior source without recounting unknown files", () => {
    expect(
      repositoryChangedFileCount([
        {
          path: "src/readable.ts",
          content: "export const ready = true;",
          changeType: "modified",
          previousSourceUnavailable: true,
        },
        {
          path: "src/still-skipped.ts",
          content: "",
          changeType: "modified",
          previousSourceUnavailable: true,
          skipReason: "too_large",
        },
        {
          path: "assets/logo.png",
          content: "",
          changeType: "modified",
          previousSourceUnavailable: true,
          isBinary: true,
        },
        {
          path: "src/unknown.ts",
          content: "export const unknown = true;",
          changeType: "modified",
        },
      ]),
    ).toBe(1);
  });

  it("keeps a previously skipped text file distinct from binary content", async () => {
    const db = {
      query: {
        snapshotFiles: {
          findMany: vi.fn(async () => [
            {
              path: "src/large.ts",
              changeType: "modified",
              currentBlobId: "blob-1",
              isBinary: false,
              skipReason: "too_large",
            },
          ]),
        },
        sourceBlobs: {
          findMany: vi.fn(async () => [{ id: "blob-1", state: "ready" }]),
        },
      },
    } as unknown as typeof database;
    const provider = {
      listRepositoryFiles: vi.fn(async () => ["src/large.ts"]),
      getFileContent: vi.fn(async () => "export const readable = true;"),
    } as unknown as PullRequestProvider;

    const files = await downloadRepositoryFiles(
      db,
      {
        monitorId: "monitor",
        repositoryExternalId: "repository",
        ref: "revision",
        previousSnapshotId: "snapshot-1",
      },
      provider,
    );

    expect(files).toEqual([
      expect.objectContaining({
        path: "src/large.ts",
        previousSourceUnavailable: true,
      }),
    ]);
    expect(files[0]?.isBinary).toBeUndefined();
    expect(files[0]?.skipReason).toBeUndefined();
    expect(files[0]?.previousContent).toBeUndefined();
  });

  it("stops provider reads in bounded batches once the source budget is full", async () => {
    const paths = Array.from(
      { length: 20 },
      (_value, index) => `src/file-${String(19 - index).padStart(2, "0")}.ts`,
    );
    const source = "x".repeat(MAX_REPOSITORY_FILE_BYTES);
    const getFileContent = vi.fn(
      async (
        _repositoryExternalId: string,
        _path: string,
        _ref: string,
        _maximumBytes?: number,
      ) => source,
    );
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
    const retained = Math.floor(
      REPOSITORY_SOURCE_BUDGET_BYTES / MAX_REPOSITORY_FILE_BYTES,
    );
    expect(files.filter(({ skipReason }) => !skipReason)).toHaveLength(
      retained,
    );
    expect(
      files.filter(({ skipReason }) => skipReason === "too_large"),
    ).toHaveLength(paths.length - retained);
    expect(getFileContent).toHaveBeenCalledTimes(paths.length);
    for (const call of getFileContent.mock.calls) {
      expect(call[3]).toBe(MAX_REPOSITORY_FILE_BYTES);
    }
  });
});
