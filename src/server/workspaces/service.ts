import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
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
  if (membership) return membership.workspace;

  const local = isLocalDeployment();
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
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email, displayName, imageUrl: clerkUser?.imageUrl },
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
