import { and, eq, inArray } from "drizzle-orm";
import { userProviderCredentials } from "@/drizzle/schema";
import { viewerOwnsPullRequest } from "~/lib/pull-request-involvement";
import type { db as database } from "~/server/db";

type Database = typeof database;

type InvolvementRow = {
  assigneeExternalIds: readonly string[] | null;
  authorExternalId: string | null;
  authorLogin: string;
  connectionAccountId: string;
  connectionDisplayName: string;
  connectionId: string;
  queueSource: string | null;
  reviewerExternalIds: readonly string[] | null;
};

/**
 * Replaces stored participant ids with whether this reviewer opened or is
 * assigned each pull request. The client never receives the account ids.
 */
export async function withViewerInvolvement<T extends InvolvementRow>(
  db: Database,
  userId: string,
  rows: readonly T[],
) {
  const connectionIds = [
    ...new Set(rows.map((row) => row.connectionId).filter(Boolean)),
  ];
  const credentials =
    connectionIds.length === 0
      ? []
      : await db
          .select({
            connectionId: userProviderCredentials.connectionId,
            displayLogin: userProviderCredentials.displayLogin,
            externalAccountId: userProviderCredentials.externalAccountId,
          })
          .from(userProviderCredentials)
          .where(
            and(
              eq(userProviderCredentials.userId, userId),
              inArray(userProviderCredentials.connectionId, connectionIds),
            ),
          );
  const credentialByConnection = new Map(
    credentials.map((credential) => [credential.connectionId, credential]),
  );
  return rows.map((row) => {
    const credential = credentialByConnection.get(row.connectionId);
    const {
      assigneeExternalIds,
      authorExternalId,
      connectionAccountId,
      connectionDisplayName,
      connectionId: _connectionId,
      reviewerExternalIds,
      ...rest
    } = row;
    return {
      ...rest,
      ...viewerOwnsPullRequest({
        accountIds: [connectionAccountId, credential?.externalAccountId],
        assigneeExternalIds,
        authorExternalId,
        authorLogin: row.authorLogin,
        logins: [connectionDisplayName, credential?.displayLogin],
        queueSource: row.queueSource,
        reviewerExternalIds,
      }),
    };
  });
}
