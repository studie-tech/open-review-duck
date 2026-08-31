import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { cache } from "react";
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

/** Creates or returns the caller's personal workspace and their role in it. */
async function resolvePersonalWorkspace(db: Database, userId: string) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
    with: { workspace: true, user: { columns: { isAdmin: true } } },
  });
  const local = isLocalDeployment();
  if (membership) {
    // Existing local owners predate the admin column, so promote them here
    // rather than only on insert. SaaS stays false unless set by hand.
    if (local && membership.role === "owner" && !membership.user.isAdmin) {
      await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    }
    return { role: membership.role, workspace: membership.workspace };
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
    if (existing) {
      return { role: existing.role, workspace: existing.workspace };
    }

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
    return { role: "owner", workspace };
  });
}

/**
 * Resolves the caller's personal workspace once per React render pass.
 *
 * Nearly every protected procedure opens by asking for the workspace, and a
 * server-rendered route awaits several of them across its layout and page, so
 * an uncached resolver repeats the same member-workspace read for each one.
 * React's render cache collapses those into a single read. Route handlers and
 * workers install no cache dispatcher, so there `cache` calls straight
 * through and each caller reads for itself.
 */
export const personalWorkspace = cache(resolvePersonalWorkspace);

/** Creates or returns the authenticated user's personal workspace. */
export async function ensurePersonalWorkspace(db: Database, userId: string) {
  const { workspace } = await personalWorkspace(db, userId);
  return workspace;
}
