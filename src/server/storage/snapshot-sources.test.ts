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
  pullRequestSnapshotSourcesAvailable,
  reviewSnapshotSourcesAvailable,
} from "./snapshot-sources";

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

  it("rejects a pull request with no snapshot", async () => {
    const database = {
      query: {
        reviewSnapshots: { findFirst: vi.fn(async () => undefined) },
      },
    };

    await expect(
      pullRequestSnapshotSourcesAvailable(database as never, "pull-request"),
    ).resolves.toBe(false);
  });
});
