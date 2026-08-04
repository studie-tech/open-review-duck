import "server-only";

import { lt } from "drizzle-orm";
import { aiStreamLeases } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;

/** Deletes stream leases that can no longer count against concurrency. */
export async function pruneExpiredAiStreamLeases(db: Database) {
  const deleted = await db
    .delete(aiStreamLeases)
    .where(lt(aiStreamLeases.expiresAt, new Date()))
    .returning({ id: aiStreamLeases.id });
  return deleted.length;
}
