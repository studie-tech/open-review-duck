import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { users } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";

/** Local users may evaluate; SaaS requires the platform administrator flag. */
export async function evaluationAccess(db: typeof database, userId: string) {
  const workspace = await ensurePersonalWorkspace(db, userId);
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { isAdmin: true },
  });
  return { workspace, allowed: isLocalDeployment() || Boolean(user?.isAdmin) };
}

/** Enforces evaluation privileges on every read and write, independently of UI. */
export async function requireEvaluationAccess(
  db: typeof database,
  userId: string,
) {
  const access = await evaluationAccess(db, userId);
  if (!access.allowed)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Evaluations require a platform administrator account",
    });
  return access.workspace;
}
