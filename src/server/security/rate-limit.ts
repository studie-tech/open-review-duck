import { TRPCError } from "@trpc/server";
import { lt, sql } from "drizzle-orm";
import { rateLimits } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;

/** Deletes limiter windows that can no longer reject a request. */
export async function pruneExpiredRateLimits(db: Database) {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, new Date()))
    .returning({ key: rateLimits.key });
  return deleted.length;
}

/** Applies an atomic database-backed fixed-window rate limit. */
export async function enforceRateLimit(
  db: Database,
  key: string,
  limit: number,
  windowMilliseconds: number,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMilliseconds);
  const [entry] = await db
    .insert(rateLimits)
    .values({ key, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.expiresAt} <= ${now} then 1 else ${rateLimits.count} + 1 end`,
        expiresAt: sql`case when ${rateLimits.expiresAt} <= ${now} then ${expiresAt} else ${rateLimits.expiresAt} end`,
      },
    })
    .returning();
  if (entry && entry.count > limit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Wait a moment and try again.",
    });
  }
}
