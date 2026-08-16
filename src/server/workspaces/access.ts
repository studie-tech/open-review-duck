import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { workspaceMembers } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;

/** Loads a workspace only when the user is an active member. */
async function requireWorkspaceMembership(
  db: Database,
  workspaceId: string,
  userId: string,
) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
    ),
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace access denied",
    });
  }
  return membership;
}

/** Requires permission to change credentials or other shared workspace state. */
export async function requireWorkspaceAdministrator(
  db: Database,
  workspaceId: string,
  userId: string,
) {
  const membership = await requireWorkspaceMembership(db, workspaceId, userId);
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace administrator access required",
    });
  }
  return membership;
}
