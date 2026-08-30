import "server-only";

import { and, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewQueueItems,
  syncRuns,
} from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { assignPullRequestToQueue } from "~/server/review/queue";
import { pullRequestsMissingSnapshotSources } from "~/server/storage/snapshot-sources";
import { startPullRequestSync } from "../workflows/service";
import { providerConnectionErrorMessage } from "./connection-error";
import { providerForConnection } from "./credentials";
import {
  automaticSyncSlots,
  shouldRetryFailedAutomaticSync,
  supportsAssignedIntake,
} from "./intake-policy";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";

type Database = typeof database;

const AUTOMATIC_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const MAX_REPOSITORIES_PER_PASS = 10;
// Repository passes are independent, so a few run together to keep the
// workspace reconciliation short without flooding the provider.
const REPOSITORY_PASS_CONCURRENCY = 3;

/** Reconciles one repository's configured PR intake policy. */
export async function reconcileRepositoryIntake(
  db: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    force?: boolean;
    retryFailed?: boolean;
  },
) {
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.id, input.repositoryId),
      eq(repositories.workspaceId, input.workspaceId),
    ),
  });
  if (!repository) throw new Error("Repository not found");
  if (repository.reviewIntakeMode === "manual") {
    return {
      mode: "manual" as const,
      considered: 0,
      queued: 0,
      alreadyCurrent: 0,
      deferred: 0,
      failed: 0,
      skipped: true,
    };
  }

  const now = new Date();
  if (!input.force) {
    const dueBefore = new Date(
      now.getTime() - AUTOMATIC_RECONCILIATION_INTERVAL_MS,
    );
    const [claimed] = await db
      .update(repositories)
      .set({ intakeLastAttemptAt: now })
      .where(
        and(
          eq(repositories.id, repository.id),
          ne(repositories.reviewIntakeMode, "manual"),
          or(
            isNull(repositories.intakeLastAttemptAt),
            lt(repositories.intakeLastAttemptAt, dueBefore),
          ),
        ),
      )
      .returning({ id: repositories.id });
    if (!claimed) {
      return {
        mode: repository.reviewIntakeMode,
        considered: 0,
        queued: 0,
        alreadyCurrent: 0,
        deferred: 0,
        failed: 0,
        skipped: true,
      };
    }
  } else {
    await db
      .update(repositories)
      .set({ intakeLastAttemptAt: now })
      .where(eq(repositories.id, repository.id));
  }

  const connection = await db.query.providerConnections.findFirst({
    where: eq(providerConnections.id, repository.connectionId),
  });
  if (!connection) throw new Error("Provider connection not found");
  if (
    repository.reviewIntakeMode === "assigned" &&
    !supportsAssignedIntake(connection)
  ) {
    throw new Error(
      "This connection cannot identify an individual reviewer for assigned pull requests",
    );
  }
  if (!repository.intakeOwnerId) {
    throw new Error("Automatic intake does not have a queue owner");
  }

  try {
    const provider = await providerForConnection(db, connection);
    const candidates = await provider.listOpenPullRequests(
      repository.externalId,
      repository.reviewIntakeMode === "assigned"
        ? { reviewerExternalAccountId: connection.externalAccountId }
        : undefined,
    );
    const [knownPullRequests, activeSyncs, latestSyncs, queueItems] =
      await Promise.all([
        db
          .select({
            id: pullRequests.id,
            number: pullRequests.number,
            headSha: pullRequests.headSha,
            baseSha: pullRequests.baseSha,
            state: pullRequests.state,
          })
          .from(pullRequests)
          .where(eq(pullRequests.repositoryId, repository.id)),
        db
          .select({ number: syncRuns.pullRequestNumber })
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.repositoryId, repository.id),
              inArray(syncRuns.status, ["queued", "running"]),
            ),
          ),
        db
          .selectDistinctOn([syncRuns.pullRequestNumber], {
            number: syncRuns.pullRequestNumber,
            status: syncRuns.status,
          })
          .from(syncRuns)
          .where(eq(syncRuns.repositoryId, repository.id))
          .orderBy(syncRuns.pullRequestNumber, desc(syncRuns.createdAt)),
        db
          .select({
            number: pullRequests.number,
            state: reviewQueueItems.state,
          })
          .from(reviewQueueItems)
          .innerJoin(
            pullRequests,
            eq(reviewQueueItems.pullRequestId, pullRequests.id),
          )
          .where(
            and(
              eq(reviewQueueItems.userId, repository.intakeOwnerId),
              eq(pullRequests.repositoryId, repository.id),
            ),
          ),
      ]);
    const knownByNumber = new Map(
      knownPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
    );
    const activeNumbers = new Set(activeSyncs.map((sync) => sync.number));
    const latestStatusByNumber = new Map(
      latestSyncs.map((sync) => [sync.number, sync.status]),
    );
    const queueStateByNumber = new Map(
      queueItems.map((item) => [item.number, item.state]),
    );
    /** Reports whether a candidate's revision moved past intake's copy. */
    const revisionDiffersFromKnown = (
      candidate: (typeof candidates)[number],
    ) => {
      const known = knownByNumber.get(candidate.number);
      return (
        !known ||
        known.headSha !== candidate.headSha ||
        known.baseSha !== candidate.baseSha ||
        known.state !== candidate.state
      );
    };
    const sourceRepairNumbers = new Set<number>();
    if (isLocalDeployment()) {
      // A candidate whose revision already moved is queued either way, so only
      // the unchanged ones are worth the stored-source probe.
      const unchanged = candidates.flatMap((candidate) => {
        const known = knownByNumber.get(candidate.number);
        return known && !revisionDiffersFromKnown(candidate)
          ? [{ number: candidate.number, pullRequestId: known.id }]
          : [];
      });
      const missingSources = await pullRequestsMissingSnapshotSources(
        db,
        unchanged.map((entry) => entry.pullRequestId),
      );
      for (const entry of unchanged) {
        if (missingSources.has(entry.pullRequestId)) {
          sourceRepairNumbers.add(entry.number);
        }
      }
    }
    /** Reports whether a candidate differs from what intake already holds. */
    const differsFromKnown = (candidate: (typeof candidates)[number]) =>
      revisionDiffersFromKnown(candidate) ||
      sourceRepairNumbers.has(candidate.number);
    const changedCandidates = candidates.filter(
      (candidate) =>
        !activeNumbers.has(candidate.number) && differsFromKnown(candidate),
    );
    const retryFailed = shouldRetryFailedAutomaticSync(input);
    const eligible = retryFailed
      ? changedCandidates
      : changedCandidates.filter(
          (candidate) =>
            sourceRepairNumbers.has(candidate.number) ||
            latestStatusByNumber.get(candidate.number) !== "failed",
        );
    const toQueue = eligible.slice(0, automaticSyncSlots(activeNumbers.size));

    for (const candidate of toQueue) {
      await startPullRequestSync(db, {
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        pullRequestNumber: candidate.number,
        queue: {
          userId: repository.intakeOwnerId,
          source: repository.reviewIntakeMode,
          explicit: false,
        },
      });
    }
    let directlyAssigned = 0;
    for (const candidate of candidates) {
      const known = knownByNumber.get(candidate.number);
      // Direct assignment is for a pull request intake already holds
      // unchanged. One counted here as well as queued would be reported
      // twice, and would subtract itself out of `alreadyCurrent`.
      if (
        !known ||
        differsFromKnown(candidate) ||
        queueStateByNumber.get(candidate.number) === "active"
      ) {
        continue;
      }
      const queueItem = await assignPullRequestToQueue(db, {
        pullRequestId: known.id,
        userId: repository.intakeOwnerId,
        source: repository.reviewIntakeMode,
        headSha: candidate.headSha,
        explicit: false,
      });
      if (queueItem?.state === "active") directlyAssigned += 1;
    }
    await db
      .update(repositories)
      .set({
        intakeLastReconciledAt: new Date(),
        intakeLastError: null,
      })
      .where(eq(repositories.id, repository.id));
    return {
      mode: repository.reviewIntakeMode,
      considered: candidates.length,
      queued: toQueue.length + directlyAssigned,
      alreadyCurrent:
        candidates.length - changedCandidates.length - directlyAssigned,
      deferred: eligible.length - toQueue.length,
      failed: changedCandidates.length - eligible.length,
      skipped: false,
    };
  } catch (cause) {
    const message = providerConnectionErrorMessage(connection.provider, cause);
    await db
      .update(repositories)
      .set({ intakeLastError: message.slice(0, 1_000) })
      .where(eq(repositories.id, repository.id));
    throw cause;
  }
}

/** Refreshes tracked PR state and runs bounded automatic intake for one workspace. */
export async function reconcileWorkspaceIntake(
  db: Database,
  workspaceId: string,
  options?: { intakeOwnerId?: string },
) {
  if (options?.intakeOwnerId) {
    await db
      .update(repositories)
      .set({ intakeOwnerId: options.intakeOwnerId })
      .where(
        and(
          eq(repositories.workspaceId, workspaceId),
          ne(repositories.reviewIntakeMode, "manual"),
          or(
            isNull(repositories.intakeOwnerId),
            ne(repositories.intakeOwnerId, options.intakeOwnerId),
          ),
        ),
      );
  }
  const workspaceRepositories = await db.query.repositories.findMany({
    where: eq(repositories.workspaceId, workspaceId),
    limit: MAX_REPOSITORIES_PER_PASS,
    columns: { id: true, reviewIntakeMode: true },
  });
  const passes = await mapWithLimit(
    workspaceRepositories,
    REPOSITORY_PASS_CONCURRENCY,
    async (repository) => {
      const pass = { checked: 0, queued: 0, stateChanges: 0 };
      try {
        const stateResult = await refreshRepositoryPullRequestStates(db, {
          workspaceId,
          repositoryId: repository.id,
        });
        pass.stateChanges = stateResult.changed;
        pass.queued = stateResult.queued;
      } catch {
        // The repository row records the provider-state failure for diagnostics.
      }
      if (repository.reviewIntakeMode === "manual") return pass;
      try {
        const result = await reconcileRepositoryIntake(db, {
          workspaceId,
          repositoryId: repository.id,
        });
        if (!result.skipped) pass.checked = 1;
        pass.queued += result.queued;
      } catch {
        // The repository row records the safe failure summary for the settings UI.
      }
      return pass;
    },
  );
  return {
    checked: passes.reduce((total, pass) => total + pass.checked, 0),
    queued: passes.reduce((total, pass) => total + pass.queued, 0),
    stateChanges: passes.reduce((total, pass) => total + pass.stateChanges, 0),
  };
}
