import "server-only";

import { inArray, lt } from "drizzle-orm";
import { oauthStates, webhookDeliveries } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;
const CLEANUP_BATCH_SIZE = 1_000;

/** Deletes one bounded batch of expired provider security records. */
export async function pruneExpiredProviderSecurityRecords(db: Database) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [states, deliveries] = await Promise.all([
      tx
        .select({ id: oauthStates.id })
        .from(oauthStates)
        .where(lt(oauthStates.expiresAt, now))
        .limit(CLEANUP_BATCH_SIZE),
      tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(lt(webhookDeliveries.expiresAt, now))
        .limit(CLEANUP_BATCH_SIZE),
    ]);
    if (states.length > 0) {
      await tx.delete(oauthStates).where(
        inArray(
          oauthStates.id,
          states.map(({ id }) => id),
        ),
      );
    }
    if (deliveries.length > 0) {
      await tx.delete(webhookDeliveries).where(
        inArray(
          webhookDeliveries.id,
          deliveries.map(({ id }) => id),
        ),
      );
    }
    return { oauthStates: states.length, webhookDeliveries: deliveries.length };
  });
}
