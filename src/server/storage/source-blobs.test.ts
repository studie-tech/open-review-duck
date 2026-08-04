import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  sourceObjectStore: vi.fn(async () => ({ kind: "local", put: mocks.put })),
}));

vi.mock("./index", () => ({ sourceObjectStore: mocks.sourceObjectStore }));

import { persistSourceBlob, pruneOrphanSourceBlobs } from "./source-blobs";

describe("source blob pruning", () => {
  it("keeps newly-created unreferenced blobs inside the ingestion grace period", async () => {
    let candidateQuery: { queryChunks?: unknown[] } | undefined;
    const database = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: vi.fn(async (query) => {
            candidateQuery = query as { queryChunks?: unknown[] };
            return { rows: [] };
          }),
        }),
      ),
    };

    await expect(pruneOrphanSourceBlobs(database as never)).resolves.toBe(0);
    expect(JSON.stringify(candidateQuery)).toContain(
      `blob.\\"updatedAt\\" < now() - interval '1 hour'`,
    );
  });

  it("refreshes the reuse timestamp before returning a deduplicated blob", async () => {
    const existing = { id: "blob-id", state: "ready" };
    const returning = vi.fn(async () => [
      { ...existing, updatedAt: new Date() },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const database = {
      query: {
        sourceBlobs: { findFirst: vi.fn(async () => existing) },
      },
      update: vi.fn(() => ({ set })),
    };

    await persistSourceBlob(database as never, {
      workspaceId: "workspace",
      bytes: new TextEncoder().encode("reused"),
    });

    expect(set).toHaveBeenCalledWith({ updatedAt: expect.any(Date) });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("reclaims a failed upload on the next synchronization attempt", async () => {
    mocks.put.mockReset();
    mocks.put.mockResolvedValue({
      storage: "local",
      objectKey: "objects/recovered",
    });
    const failed = {
      id: "blob-id",
      state: "failed",
      uploadLeaseExpiresAt: null,
    };
    const reclaimed = {
      ...failed,
      state: "uploading",
      uploadLeaseToken: "lease",
    };
    const ready = {
      ...reclaimed,
      state: "ready",
      objectKey: "objects/recovered",
    };
    const returning = vi
      .fn()
      .mockResolvedValueOnce([reclaimed])
      .mockResolvedValueOnce([ready]);
    const database = {
      query: {
        sourceBlobs: { findFirst: vi.fn(async () => failed) },
      },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };

    await expect(
      persistSourceBlob(database as never, {
        workspaceId: "workspace",
        bytes: new TextEncoder().encode("retry me"),
      }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(mocks.put).toHaveBeenCalledOnce();
  });
});
