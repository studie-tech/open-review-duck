import "server-only";

import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { pullRequests, repositories } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { startPullRequestSync } from "~/server/workflows/service";
import { providerConnectionErrorMessage } from "./connection-error";
import type { ConnectionAccess } from "./credentials";

type Database = typeof database;
type Repository = typeof repositories.$inferSelect;
const STATE_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

/** Refreshes tracked PR metadata and queues analysis only when an open revision changed. */
export async function refreshRepositoryPullRequestStates(
  db: Database,
  repository: Repository,
  access: ConnectionAccess,
) {
  const now = new Date();
  const dueBefore = new Date(now.getTime() - STATE_RECONCILIATION_INTERVAL_MS);
  const [claimed] = await db
    .update(repositories)
    .set({ pullRequestStateLastCheckedAt: now })
    .where(
      and(
        eq(repositories.id, repository.id),
        or(
          isNull(repositories.pullRequestStateLastCheckedAt),
          lt(repositories.pullRequestStateLastCheckedAt, dueBefore),
        ),
      ),
    )
    .returning({ id: repositories.id });
  if (!claimed) return { checked: false, changed: 0, queued: 0 };
  // The connection is only needed once the throttle claim succeeds, so the
  // frequent no-op pass costs a single round-trip.
  const connection = await access.connection();
  try {
    const provider = await access.provider();
    const [openPullRequests, tracked] = await Promise.all([
      provider.listOpenPullRequests(repository.externalId),
      db.query.pullRequests.findMany({
        where: and(
          eq(pullRequests.repositoryId, repository.id),
          inArray(pullRequests.state, ["open", "draft"]),
        ),
      }),
    ]);
    const openByNumber = new Map(
      openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
    );
    const remoteByNumber = new Map(openByNumber);
    const absent = tracked.filter(
      (pullRequest) => !openByNumber.has(pullRequest.number),
    );
    for (let offset = 0; offset < absent.length; offset += 4) {
      const batch = absent.slice(offset, offset + 4);
      const remote = await Promise.all(
        batch.map((pullRequest) =>
          provider.getPullRequest(repository.externalId, pullRequest.number),
        ),
      );
      for (const pullRequest of remote) {
        remoteByNumber.set(pullRequest.number, pullRequest);
      }
    }

    let changed = 0;
    let queued = 0;
    for (const trackedPullRequest of tracked) {
      const remote = remoteByNumber.get(trackedPullRequest.number);
      if (!remote) continue;
      const revisionChanged =
        trackedPullRequest.headSha !== remote.headSha ||
        trackedPullRequest.baseSha !== remote.baseSha;
      const providerStateChanged = trackedPullRequest.state !== remote.state;
      const summaryOnly = openByNumber.has(trackedPullRequest.number);
      if (revisionChanged || providerStateChanged) changed += 1;
      await db
        .update(pullRequests)
        .set({
          title: remote.title,
          description: remote.description,
          authorLogin: remote.authorLogin,
          authorAvatarUrl: remote.authorAvatarUrl,
          sourceBranch: remote.sourceBranch,
          targetBranch: remote.targetBranch,
          headSha: remote.headSha,
          baseSha: remote.baseSha,
          state: remote.state,
          webUrl: remote.webUrl,
          additions: summaryOnly
            ? trackedPullRequest.additions
            : remote.additions,
          deletions: summaryOnly
            ? trackedPullRequest.deletions
            : remote.deletions,
          changedFiles: summaryOnly
            ? trackedPullRequest.changedFiles
            : remote.changedFiles,
          lastSyncedAt: new Date(),
        })
        .where(eq(pullRequests.id, trackedPullRequest.id));
      if (
        revisionChanged &&
        (remote.state === "open" || remote.state === "draft")
      ) {
        await startPullRequestSync(db, {
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
          pullRequestNumber: remote.number,
          queue:
            repository.reviewIntakeMode !== "manual" && repository.intakeOwnerId
              ? {
                  userId: repository.intakeOwnerId,
                  source: repository.reviewIntakeMode,
                  explicit: false,
                }
              : undefined,
        });
        queued += 1;
      }
    }
    await db
      .update(repositories)
      .set({ pullRequestStateLastError: null })
      .where(eq(repositories.id, repository.id));
    return { checked: true, changed, queued };
  } catch (cause) {
    const message = providerConnectionErrorMessage(connection.provider, cause);
    await db
      .update(repositories)
      .set({ pullRequestStateLastError: message.slice(0, 1_000) })
      .where(eq(repositories.id, repository.id));
    throw cause;
  }
}
