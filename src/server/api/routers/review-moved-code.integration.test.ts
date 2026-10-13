import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewSnapshots, users } from "@/drizzle/schema";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { createMovedCodeFixture } from "~/test/moved-code-fixture";
import { reviewRouter } from "./review";

let fixture: Awaited<ReturnType<typeof createMovedCodeFixture>>;
let other: Awaited<ReturnType<typeof createMovedCodeFixture>>;
const createCaller = createCallerFactory(reviewRouter);

beforeAll(async () => {
  fixture = await createMovedCodeFixture();
  other = await createMovedCodeFixture(fixture.ownerId);
});
afterAll(async () => {
  for (const entry of [fixture, other]) {
    if (entry)
      await db
        .delete(reviewSnapshots)
        .where(eq(reviewSnapshots.id, entry.snapshotId));
  }
  if (fixture) await db.delete(users).where(eq(users.id, fixture.ownerId));
});

/** Creates a caller using a real workspace's owner or an unrelated identity. */
function caller(userId: string | null) {
  return createCaller({
    db,
    auth: { userId, has: () => true },
    headers: new Headers(),
  });
}

describe("moved code snapshot metadata", () => {
  it("matches stored deleted-file contexts and returns ranges without private source", async () => {
    const result = await caller(fixture.ownerId).movedCode({
      pullRequestId: fixture.pullRequestId,
      snapshotId: fixture.snapshotId,
    });
    expect(
      result.find((file) => file.path === "src/pricing/shipping.ts"),
    ).toEqual({
      path: "src/pricing/shipping.ts",
      previous: [],
      current: [
        { startLine: 1, endLine: 1 },
        { startLine: 3, endLine: 4 },
      ],
    });
    expect(
      result.find((file) => file.path === "src/checkout-helpers.ts")?.previous,
    ).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 9 },
    ]);
    expect(JSON.stringify(result)).not.toContain("return");
    expect(JSON.stringify(result)).not.toContain("source");
  });
  it("rejects callers outside the workspace before reading source", async () => {
    await expect(
      caller(`unrelated-${randomUUID()}`).movedCode({
        pullRequestId: fixture.pullRequestId,
        snapshotId: fixture.snapshotId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(null).movedCode({
        pullRequestId: fixture.pullRequestId,
        snapshotId: fixture.snapshotId,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("does not accept another pull request's snapshot even for the same owner", async () => {
    await expect(
      caller(fixture.ownerId).movedCode({
        pullRequestId: fixture.pullRequestId,
        snapshotId: other.snapshotId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
