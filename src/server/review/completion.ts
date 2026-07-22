import { and, eq, ne, sql } from "drizzle-orm";
import { reviewUnits, signOffs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = Pick<typeof database, "select">;

/** Counts only visible review units and their active user sign-offs. */
export async function reviewCompletionCounts(
  db: Database,
  snapshotId: string,
  userId: string,
) {
  const [completion] = await db
    .select({
      total: sql<number>`count(distinct ${reviewUnits.id})`,
      signed: sql<number>`count(distinct case when ${signOffs.userId} = ${userId} and ${signOffs.invalidatedAt} is null then ${signOffs.unitId} end)`,
    })
    .from(reviewUnits)
    .leftJoin(signOffs, eq(signOffs.unitId, reviewUnits.id))
    .where(
      and(eq(reviewUnits.snapshotId, snapshotId), ne(reviewUnits.kind, "file")),
    );
  return {
    total: Number(completion?.total ?? 0),
    signed: Number(completion?.signed ?? 0),
  };
}
