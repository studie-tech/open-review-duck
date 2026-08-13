import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  sourceObjectStore: vi.fn(async () => ({
    kind: "local",
    // The local store names an object after the content it holds, so every
    // writer of one digest derives the same key.
    customId: ({
      workspaceId,
      digest,
    }: {
      workspaceId: string;
      digest: string;
    }) => `${workspaceId}/${digest.slice(0, 2)}/${digest}`,
    put: mocks.put,
    read: mocks.read,
    delete: mocks.remove,
  })),
}));

vi.mock("./index", () => ({ sourceObjectStore: mocks.sourceObjectStore }));

import {
  persistSourceBlob,
  pruneOrphanSourceBlobs,
  sourceDigest,
} from "./source-blobs";

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
    mocks.put.mockReset();
    mocks.read.mockReset();
    const bytes = new TextEncoder().encode("reused");
    mocks.read.mockResolvedValue(bytes);
    const existing = {
      id: "blob-id",
      state: "ready",
      storage: "local",
      objectKey: "objects/reused",
      digest: sourceDigest(bytes),
    };
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
      bytes,
    });

    expect(set).toHaveBeenCalledWith({ updatedAt: expect.any(Date) });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("restores a ready database row whose local object is missing", async () => {
    mocks.put.mockReset();
    mocks.read.mockReset();
    mocks.read.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    mocks.put.mockResolvedValue({
      storage: "local",
      objectKey: "objects/restored",
    });
    const bytes = new TextEncoder().encode("restore me");
    const existing = {
      id: "blob-id",
      state: "ready",
      storage: "local",
      objectKey: "objects/missing",
      digest: sourceDigest(bytes),
    };
    const claimed = {
      ...existing,
      state: "uploading",
      objectKey: null,
      uploadLeaseToken: "lease",
    };
    const ready = {
      ...claimed,
      state: "ready",
      objectKey: "objects/restored",
    };
    const returning = vi
      .fn()
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([ready]);
    const database = {
      query: {
        sourceBlobs: { findFirst: vi.fn(async () => existing) },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };

    await expect(
      persistSourceBlob(database as never, {
        workspaceId: "workspace",
        bytes,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      objectKey: "objects/restored",
    });
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it("keeps a ready row when a presence probe cannot reach the object", async () => {
    // A probe that failed proves nothing. Reading it as absence claims the
    // row, re-uploads, and leaves the object it was naming with no reference.
    mocks.put.mockReset();
    mocks.read.mockReset();
    mocks.sourceObjectStore.mockResolvedValueOnce({
      kind: "local",
      put: mocks.put,
      read: mocks.read,
      exists: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    } as never);
    const bytes = new TextEncoder().encode("still stored");
    const existing = {
      id: "blob-id",
      state: "ready",
      storage: "local",
      objectKey: "objects/present",
      digest: sourceDigest(bytes),
    };
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    }));
    const database = {
      query: { sourceBlobs: { findFirst: vi.fn(async () => existing) } },
      update: vi.fn(() => ({ set })),
    };

    await expect(
      persistSourceBlob(database as never, {
        workspaceId: "workspace",
        bytes,
      }),
    ).rejects.toThrow("provider unavailable");
    expect(set).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("reclaims a failed upload on the next synchronization attempt", async () => {
    mocks.put.mockReset();
    mocks.read.mockReset();
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

  it("waits for a concurrent upload of the same content rather than failing", async () => {
    // Two files of one pull request holding identical bytes is ordinary. The
    // call that loses the race wants the object the winner is already writing,
    // and refusing it spends the whole synchronization on a duplicate file.
    mocks.put.mockReset();
    mocks.read.mockReset();
    const bytes = new TextEncoder().encode("shared by two files");
    mocks.read.mockResolvedValue(bytes);
    const uploading = {
      id: "blob-id",
      state: "uploading",
      storage: "local",
      objectKey: null,
      digest: sourceDigest(bytes),
      uploadLeaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const ready = {
      ...uploading,
      state: "ready",
      objectKey: "objects/shared",
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(uploading)
      .mockResolvedValueOnce(uploading)
      .mockResolvedValue(ready);
    const returning = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ready, updatedAt: new Date() }]);
    const database = {
      query: { sourceBlobs: { findFirst } },
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
        bytes,
      }),
    ).resolves.toMatchObject({ state: "ready", objectKey: "objects/shared" });
    // The winner stored the object, so the waiter must not store it again.
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("dates the upload lease from the claim rather than the call", async () => {
    // Reaching a claim costs a probe of the store, and a contended digest costs
    // the wait for it as well. A lease stamped on the way in is already part
    // spent by the time the row carries it.
    mocks.put.mockReset();
    mocks.read.mockReset();
    mocks.remove.mockReset();
    const bytes = new TextEncoder().encode("slow to reach the claim");
    const probeMilliseconds = 300;
    mocks.read.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, probeMilliseconds));
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    mocks.put.mockResolvedValue({
      storage: "local",
      objectKey: "objects/restored",
    });
    const existing = {
      id: "blob-id",
      state: "ready",
      storage: "local",
      objectKey: "objects/missing",
      digest: sourceDigest(bytes),
    };
    const claimed = {
      ...existing,
      state: "uploading",
      objectKey: null,
      uploadLeaseToken: "lease",
    };
    const returning = vi
      .fn()
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([{ ...claimed, state: "ready" }]);
    const leases: Date[] = [];
    const set = vi.fn((values: { uploadLeaseExpiresAt?: Date | null }) => {
      if (values.uploadLeaseExpiresAt) leases.push(values.uploadLeaseExpiresAt);
      return { where: vi.fn(() => ({ returning })) };
    });
    const database = {
      query: { sourceBlobs: { findFirst: vi.fn(async () => existing) } },
      update: vi.fn(() => ({ set })),
    };

    const startedAt = Date.now();
    await persistSourceBlob(database as never, {
      workspaceId: "workspace",
      bytes,
    });

    const [lease] = leases;
    expect(lease?.getTime() ?? 0).toBeGreaterThan(
      startedAt + 4 * 60_000 + probeMilliseconds - 50,
    );
  });

  it("keeps the object a writer that took the lease stored under the same key", async () => {
    // Both writers derive one key from the content, so the object this call
    // uploaded is the object the row now names. Cleaning up after a lost lease
    // must not take it, or the ready row is left naming nothing.
    mocks.put.mockReset();
    mocks.read.mockReset();
    mocks.remove.mockReset();
    const bytes = new TextEncoder().encode("stored by two writers");
    const digest = sourceDigest(bytes);
    const objectKey = `workspace/${digest.slice(0, 2)}/${digest}`;
    mocks.put.mockResolvedValue({ storage: "local", objectKey });
    const abandoned = {
      id: "blob-id",
      state: "failed" as const,
      digest,
      uploadLeaseExpiresAt: null,
    };
    const claimed = {
      ...abandoned,
      state: "uploading",
      uploadLeaseToken: "lease",
    };
    const takenOver = { ...claimed, state: "ready", objectKey };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(abandoned)
      .mockResolvedValueOnce(abandoned)
      .mockResolvedValue(takenOver);
    const returning = vi
      .fn()
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([]);
    const database = {
      query: { sourceBlobs: { findFirst } },
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
      persistSourceBlob(database as never, { workspaceId: "workspace", bytes }),
    ).rejects.toThrow("Source upload lease expired before completion");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes an uploaded object no row is left to name", async () => {
    // Nothing holds the digest once the row is gone, so this upload is the
    // only reference to the object and nothing else will collect it.
    mocks.put.mockReset();
    mocks.read.mockReset();
    mocks.remove.mockReset();
    const bytes = new TextEncoder().encode("orphaned by pruning");
    const digest = sourceDigest(bytes);
    const objectKey = `workspace/${digest.slice(0, 2)}/${digest}`;
    mocks.put.mockResolvedValue({ storage: "local", objectKey });
    const claimed = {
      id: "blob-id",
      state: "uploading",
      digest,
      uploadLeaseToken: "lease",
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined);
    const returning = vi.fn().mockResolvedValueOnce([]);
    const database = {
      query: { sourceBlobs: { findFirst } },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => [claimed]),
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
      persistSourceBlob(database as never, { workspaceId: "workspace", bytes }),
    ).rejects.toThrow("Source upload lease expired before completion");
    expect(mocks.remove).toHaveBeenCalledWith(objectKey);
  });
});
