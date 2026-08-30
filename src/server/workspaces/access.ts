import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { workspaceMembers } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { personalWorkspace } from "./service";

type Database = typeof database;

/** Rejects roles that may not change credentials or shared workspace state. */
function assertAdministrativeRole(role: string) {
  if (role !== "owner" && role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace administrator access required",
    });
  }
}

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
  assertAdministrativeRole(membership.role);
  return membership;
}

/** Requires administrator rights in the caller's own personal workspace. */
export async function requirePersonalWorkspaceAdministrator(
  db: Database,
  userId: string,
) {
  const { role, workspace } = await personalWorkspace(db, userId);
  assertAdministrativeRole(role);
  return workspace;
}
