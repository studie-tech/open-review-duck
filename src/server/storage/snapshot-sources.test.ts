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
