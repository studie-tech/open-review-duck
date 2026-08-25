import { clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { users, workspaceMembers, workspaces } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";

type Database = typeof database;

/** Converts a workspace label into a stable URL-safe slug. */
function slugify(value: string, suffix: string) {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55);
  return `${base || "workspace"}-${suffix.slice(-6).toLowerCase()}`;
}

/** Creates or returns the authenticated user's personal workspace. */
export async function ensurePersonalWorkspace(db: Database, userId: string) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
    with: { workspace: true },
  });
  const local = isLocalDeployment();
  if (membership) {
    // Existing local owners predate the admin column, so promote them here
    // rather than only on insert. SaaS stays false unless set by hand.
    if (local) {
      await db
        .update(users)
        .set({ isAdmin: true })
        .where(and(eq(users.id, userId), eq(users.isAdmin, false)));
    }
    return membership.workspace;
  }
  const clerkUser = local
    ? undefined
    : await (await clerkClient()).users.getUser(userId);
  const email = clerkUser?.primaryEmailAddress?.emailAddress;
  const fullName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter(Boolean)
    .join(" ");
  const displayName = local
    ? "Local reviewer"
    : fullName.length > 0
      ? fullName
      : (email?.split("@")[0] ?? "Reviewer");

  return db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id: userId,
        email,
        displayName,
        imageUrl: clerkUser?.imageUrl,
        isAdmin: local,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email,
          displayName,
          imageUrl: clerkUser?.imageUrl,
          ...(local ? { isAdmin: true } : {}),
        },
      });

    const existing = await tx.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, userId),
      with: { workspace: true },
    });
    if (existing) return existing.workspace;

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: userId,
        name: `${displayName}'s workspace`,
        slug: slugify(displayName, userId),
      })
      .returning();
    if (!workspace) throw new Error("Could not create workspace");
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId, role: "owner" });
    return workspace;
  });
}

export { requireWorkspaceAdministrator } from "./access";
