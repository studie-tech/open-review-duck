import "server-only";

import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { pullRequests, repositories } from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import type { db as database } from "~/server/db";
import { startPullRequestSync } from "~/server/workflows/service";
import { providerConnectionErrorMessage } from "./connection-error";
import type { ConnectionAccess } from "./credentials";

type Database = typeof database;
type Repository = typeof repositories.$inferSelect;
type TrackedPullRequest = typeof pullRequests.$inferSelect;
const STATE_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
/** Pooled handles one repository pass takes for its own writes and syncs. */
const RECONCILIATION_WRITE_CONCURRENCY = 3;

/** Reports whether the stored row already carries every refreshed column. */
function isPullRequestCurrent(
  stored: TrackedPullRequest,
  refreshed: Partial<TrackedPullRequest>,
) {
  return Object.entries(refreshed).every(
    ([column, value]) =>
      // An undefined column is omitted from the statement, so it cannot differ.
      value === undefined ||
      stored[column as keyof TrackedPullRequest] === value,
  );
}

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
    const providerTracked = tracked.filter(
      // Repository monitors use a synthetic pull-request row numbered zero.
      // It has no provider counterpart and must never enter PR reconciliation.
      (pullRequest) => pullRequest.number !== 0,
    );
    const openByNumber = new Map(
      openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
    );
    const remoteByNumber = new Map(openByNumber);
    const absent = providerTracked.filter(
      (pullRequest) => !openByNumber.has(pullRequest.number),
    );
    const detailFailures: unknown[] = [];
    const absentRemotes = await mapWithLimit(absent, 4, async (pullRequest) => {
      try {
        return await provider.getPullRequest(
          repository.externalId,
          pullRequest.number,
        );
      } catch (cause) {
        detailFailures.push(cause);
        return undefined;
      }
    });
    for (const pullRequest of absentRemotes) {
      if (pullRequest) remoteByNumber.set(pullRequest.number, pullRequest);
    }

    let changed = 0;
    const stale: { id: string; refreshed: Partial<TrackedPullRequest> }[] = [];
    const toResync: number[] = [];
    for (const trackedPullRequest of providerTracked) {
      const remote = remoteByNumber.get(trackedPullRequest.number);
      if (!remote) continue;
      const revisionChanged =
        trackedPullRequest.headSha !== remote.headSha ||
        trackedPullRequest.baseSha !== remote.baseSha;
      const providerStateChanged = trackedPullRequest.state !== remote.state;
      const summaryOnly = openByNumber.has(trackedPullRequest.number);
      if (revisionChanged || providerStateChanged) changed += 1;
      const refreshed = {
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
      };
      // `lastSyncedAt` is bookkeeping no reader consults, so a row the provider
      // still agrees with is left alone rather than rewritten every pass.
      if (!isPullRequestCurrent(trackedPullRequest, refreshed)) {
        stale.push({ id: trackedPullRequest.id, refreshed });
      }
      if (
        revisionChanged &&
        (remote.state === "open" || remote.state === "draft")
      ) {
        toResync.push(remote.number);
      }
    }
    await mapWithLimit(
      stale,
      RECONCILIATION_WRITE_CONCURRENCY,
      async (pullRequest) => {
        await db
          .update(pullRequests)
          .set({ ...pullRequest.refreshed, lastSyncedAt: new Date() })
          .where(eq(pullRequests.id, pullRequest.id));
      },
    );
    await mapWithLimit(
      toResync,
      RECONCILIATION_WRITE_CONCURRENCY,
      async (pullRequestNumber) => {
        await startPullRequestSync(db, {
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
          pullRequestNumber,
          queue:
            repository.reviewIntakeMode !== "manual" && repository.intakeOwnerId
              ? {
                  userId: repository.intakeOwnerId,
                  source: repository.reviewIntakeMode,
                  explicit: false,
                }
              : undefined,
        });
      },
    );
    const [detailFailure] = detailFailures;
    if (detailFailure) throw detailFailure;
    await db
      .update(repositories)
      .set({ pullRequestStateLastError: null })
      .where(eq(repositories.id, repository.id));
    return { checked: true, changed, queued: toResync.length };
  } catch (cause) {
    const message = providerConnectionErrorMessage(connection.provider, cause);
    await db
      .update(repositories)
      .set({ pullRequestStateLastError: message.slice(0, 1_000) })
      .where(eq(repositories.id, repository.id));
    throw cause;
  }
}
