import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceBlobs, users, workspaces } from "@/drizzle/schema";
import { db } from "~/server/db";
import {
  persistSourceBlob,
  readSourceBlob,
  sourceDigest,
} from "./source-blobs";

const fixture = {
  userId: `source-blob-integration-${randomUUID()}`,
  workspaceId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Source blob integration workspace",
    slug: `source-blob-${randomUUID()}`,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("source blob persistence", () => {
  it("rejects a second row for the same workspace digest", async () => {
    const bytes = new TextEncoder().encode(`unique-${randomUUID()}`);
    const digest = sourceDigest(bytes);
    await persistSourceBlob(db, { workspaceId: fixture.workspaceId, bytes });

    await expect(
      db.insert(sourceBlobs).values({
        workspaceId: fixture.workspaceId,
        digest,
        storage: "local",
        state: "uploading",
        byteLength: bytes.byteLength,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const rows = await db.query.sourceBlobs.findMany({
      where: and(
        eq(sourceBlobs.workspaceId, fixture.workspaceId),
        eq(sourceBlobs.digest, digest),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("ready");
  });

  it("deduplicates concurrent uploads of identical content", async () => {
    const bytes = new TextEncoder().encode(`concurrent-${randomUUID()}`);
    const digest = sourceDigest(bytes);

    const [first, second] = await Promise.all([
      persistSourceBlob(db, {
        workspaceId: fixture.workspaceId,
        bytes,
        digest,
      }),
      persistSourceBlob(db, {
        workspaceId: fixture.workspaceId,
        bytes,
        digest,
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.state).toBe("ready");
    expect(first.objectKey).toBeTruthy();
    const rows = await db.query.sourceBlobs.findMany({
      where: and(
        eq(sourceBlobs.workspaceId, fixture.workspaceId),
        eq(sourceBlobs.digest, digest),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(await readSourceBlob(first)).toEqual(bytes);
  });

  it("reclaims an uploading row whose lease expired", async () => {
    const bytes = new TextEncoder().encode(`expired-lease-${randomUUID()}`);
    const digest = sourceDigest(bytes);
    const [stale] = await db
      .insert(sourceBlobs)
      .values({
        workspaceId: fixture.workspaceId,
        digest,
        storage: "local",
        state: "uploading",
        byteLength: bytes.byteLength,
        uploadLeaseToken: randomUUID(),
        uploadLeaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const ready = await persistSourceBlob(db, {
      workspaceId: fixture.workspaceId,
      bytes,
      digest,
    });
    expect(ready.id).toBe(stale?.id);
    expect(ready.state).toBe("ready");
    expect(ready.uploadLeaseToken).toBeNull();
    expect(await readSourceBlob(ready)).toEqual(bytes);
  });

  it("reclaims a failed row on the next persist attempt", async () => {
    const bytes = new TextEncoder().encode(`failed-retry-${randomUUID()}`);
    const digest = sourceDigest(bytes);
    const [failed] = await db
      .insert(sourceBlobs)
      .values({
        workspaceId: fixture.workspaceId,
        digest,
        storage: "local",
        state: "failed",
        byteLength: bytes.byteLength,
        error: "simulated upload failure",
      })
      .returning();

    const ready = await persistSourceBlob(db, {
      workspaceId: fixture.workspaceId,
      bytes,
      digest,
    });
    expect(ready.id).toBe(failed?.id);
    expect(ready.state).toBe("ready");
    expect(ready.error).toBeNull();
    expect(await readSourceBlob(ready)).toEqual(bytes);
  });
});
