import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users, workspaceMembers, workspaces } from "@/drizzle/schema";
import { db } from "~/server/db";
import { ensurePersonalWorkspace } from "./service";

const fixture = {
  userId: `workspace-promotion-${randomUUID()}`,
  workspaceId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId, isAdmin: false });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Workspace promotion workspace",
    slug: `workspace-promotion-${randomUUID()}`,
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "owner",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("local owner promotion", () => {
  it("promotes an existing local owner on the users row", async () => {
    await expect(
      ensurePersonalWorkspace(db, fixture.userId),
    ).resolves.toMatchObject({ id: fixture.workspaceId });
    await expect(
      db.query.users.findFirst({ where: eq(users.id, fixture.userId) }),
    ).resolves.toMatchObject({ isAdmin: true });
  });
});
