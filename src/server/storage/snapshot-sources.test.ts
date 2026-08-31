import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  sourceObjectStore: vi.fn(async () => ({
    kind: "local",
    exists: mocks.exists,
  })),
}));

vi.mock("./index", () => ({ sourceObjectStore: mocks.sourceObjectStore }));

import {
  pullRequestsMissingSnapshotSources,
  reviewSnapshotSourcesAvailable,
} from "./snapshot-sources";

/** Builds a stub database answering one batched pull-request source pass. */
function batchedDatabase(input: {
  snapshots: { id: string; pullRequestId: string }[];
  units: {
    snapshotId: string;
    currentBlobId: string | null;
    previousBlobId: string | null;
  }[];
  blobIds: string[];
}) {
  const orderBy = vi.fn(async () => input.snapshots);
  return {
    selectDistinctOn: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy }) }),
    })),
    query: {
      reviewUnits: { findMany: vi.fn(async () => input.units) },
      sourceBlobs: {
        findMany: vi.fn(async () =>
          input.blobIds.map((id) => ({
            id,
            state: "ready",
            storage: "local",
            objectKey: `objects/${id}`,
          })),
        ),
      },
    },
  };
}

/** Builds a stub database whose snapshot references many ready local blobs. */
function databaseWithReadyBlobs(count: number) {
  const ids = Array.from({ length: count }, (_, index) => `blob-${index}`);
  return {
    query: {
      reviewUnits: {
        findMany: vi.fn(async () =>
          ids.map((id) => ({ currentBlobId: id, previousBlobId: null })),
        ),
      },
      sourceBlobs: {
        findMany: vi.fn(async () =>
          ids.map((id) => ({
            id,
            state: "ready",
            storage: "local",
            objectKey: `objects/${id}`,
          })),
        ),
      },
    },
  };
}

describe("snapshot source availability", () => {
  it("rejects a snapshot when a referenced local object is missing", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const database = {
      query: {
        reviewUnits: {
          findMany: vi.fn(async () => [
            { currentBlobId: "current", previousBlobId: "previous" },
          ]),
        },
        sourceBlobs: {
          findMany: vi.fn(async () => [
            {
              id: "current",
              state: "ready",
              storage: "local",
              objectKey: "objects/current",
            },
            {
              id: "previous",
              state: "ready",
              storage: "local",
              objectKey: "objects/previous",
            },
          ]),
        },
      },
    };

    await expect(
      reviewSnapshotSourcesAvailable(database as never, "snapshot"),
    ).resolves.toBe(false);
  });

  it("accepts a snapshot only after every referenced object exists", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValue(true);
    const database = {
      query: {
        reviewUnits: {
          findMany: vi.fn(async () => [
            { currentBlobId: "current", previousBlobId: null },
          ]),
        },
        sourceBlobs: {
          findMany: vi.fn(async () => [
            {
              id: "current",
              state: "ready",
              storage: "local",
              objectKey: "objects/current",
            },
          ]),
        },
      },
    };

    await expect(
      reviewSnapshotSourcesAvailable(database as never, "snapshot"),
    ).resolves.toBe(true);
  });

  it("keeps at most twelve object probes in flight", async () => {
    mocks.exists.mockReset();
    let inFlight = 0;
    let peak = 0;
    mocks.exists.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    });

    await expect(
      reviewSnapshotSourcesAvailable(
        databaseWithReadyBlobs(16) as never,
        "snapshot",
      ),
    ).resolves.toBe(true);
    expect(peak).toBeLessThanOrEqual(12);
    expect(mocks.exists).toHaveBeenCalledTimes(16);
  });

  it("stops probing once one object is known missing", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockImplementation(
      async (objectKey: string) => objectKey !== "objects/blob-0",
    );

    await expect(
      reviewSnapshotSourcesAvailable(
        databaseWithReadyBlobs(16) as never,
        "snapshot",
      ),
    ).resolves.toBe(false);
    expect(mocks.exists.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("reports pull requests that never prepared a snapshot", async () => {
    const database = batchedDatabase({ snapshots: [], units: [], blobIds: [] });

    await expect(
      pullRequestsMissingSnapshotSources(database as never, [
        "pull-request-1",
        "pull-request-2",
      ]),
    ).resolves.toEqual(new Set(["pull-request-1", "pull-request-2"]));
    expect(database.query.reviewUnits.findMany).not.toHaveBeenCalled();
  });

  it("checks many pull requests with three queries and one probe per object", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValue(true);
    const database = batchedDatabase({
      snapshots: [
        { id: "snapshot-1", pullRequestId: "pull-request-1" },
        { id: "snapshot-2", pullRequestId: "pull-request-2" },
      ],
      units: [
        {
          snapshotId: "snapshot-1",
          currentBlobId: "shared",
          previousBlobId: "only-1",
        },
        {
          snapshotId: "snapshot-2",
          currentBlobId: "shared",
          previousBlobId: null,
        },
      ],
      blobIds: ["shared", "only-1"],
    });

    await expect(
      pullRequestsMissingSnapshotSources(database as never, [
        "pull-request-1",
        "pull-request-2",
      ]),
    ).resolves.toEqual(new Set());
    expect(database.selectDistinctOn).toHaveBeenCalledTimes(1);
    expect(database.query.reviewUnits.findMany).toHaveBeenCalledTimes(1);
    expect(database.query.sourceBlobs.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.exists.mock.calls.map(([key]) => key)).toEqual([
      "objects/shared",
      "objects/only-1",
    ]);
  });

  it("reports only the pull requests whose objects are gone", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockImplementation(
      async (objectKey: string) => objectKey !== "objects/only-2",
    );
    const database = batchedDatabase({
      snapshots: [
        { id: "snapshot-1", pullRequestId: "pull-request-1" },
        { id: "snapshot-2", pullRequestId: "pull-request-2" },
      ],
      units: [
        {
          snapshotId: "snapshot-1",
          currentBlobId: "shared",
          previousBlobId: null,
        },
        {
          snapshotId: "snapshot-2",
          currentBlobId: "shared",
          previousBlobId: "only-2",
        },
      ],
      blobIds: ["shared", "only-2"],
    });

    await expect(
      pullRequestsMissingSnapshotSources(database as never, [
        "pull-request-1",
        "pull-request-2",
      ]),
    ).resolves.toEqual(new Set(["pull-request-2"]));
  });

  it("keeps a pull request whose probe failed instead of answering", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockRejectedValue(new Error("probe failed"));
    const database = batchedDatabase({
      snapshots: [{ id: "snapshot-1", pullRequestId: "pull-request-1" }],
      units: [
        {
          snapshotId: "snapshot-1",
          currentBlobId: "kept",
          previousBlobId: null,
        },
      ],
      blobIds: ["kept"],
    });

    await expect(
      pullRequestsMissingSnapshotSources(database as never, ["pull-request-1"]),
    ).resolves.toEqual(new Set());
  });

  it("reports a pull request whose snapshot lost a blob row", async () => {
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValue(true);
    const database = batchedDatabase({
      snapshots: [{ id: "snapshot-1", pullRequestId: "pull-request-1" }],
      units: [
        {
          snapshotId: "snapshot-1",
          currentBlobId: "kept",
          previousBlobId: "pruned",
        },
      ],
      blobIds: ["kept"],
    });

    await expect(
      pullRequestsMissingSnapshotSources(database as never, ["pull-request-1"]),
    ).resolves.toEqual(new Set(["pull-request-1"]));
  });
});
