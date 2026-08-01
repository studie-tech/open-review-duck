import "server-only";

import { and, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewQueueItems,
  syncRuns,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { assignPullRequestToQueue } from "~/server/review/queue";
import { startPullRequestSync } from "../workflows/service";
import { providerConnectionErrorMessage } from "./connection-error";
import { providerForConnection } from "./credentials";
import { supportsAssignedIntake } from "./intake-policy";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";

type Database = typeof database;

const AUTOMATIC_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const MAX_REPOSITORIES_PER_PASS = 10;

/** Reconciles one repository's configured PR intake policy. */
export async function reconcileRepositoryIntake(
  db: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    force?: boolean;
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
    const [knownPullRequests, activeSyncs, queueItems] = await Promise.all([
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
    const queueStateByNumber = new Map(
      queueItems.map((item) => [item.number, item.state]),
    );
    const toQueue = candidates.filter((candidate) => {
      if (activeNumbers.has(candidate.number)) return false;
      const known = knownByNumber.get(candidate.number);
      return (
        !known ||
        known.headSha !== candidate.headSha ||
        known.baseSha !== candidate.baseSha ||
        known.state !== candidate.state
      );
    });

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
      if (
        !known ||
        known.headSha !== candidate.headSha ||
        known.baseSha !== candidate.baseSha ||
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
      alreadyCurrent: candidates.length - toQueue.length - directlyAssigned,
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
) {
  const workspaceRepositories = await db.query.repositories.findMany({
    where: eq(repositories.workspaceId, workspaceId),
    limit: MAX_REPOSITORIES_PER_PASS,
    columns: { id: true, reviewIntakeMode: true },
  });
  const results = [];
  let stateChanges = 0;
  let stateSyncs = 0;
  for (const repository of workspaceRepositories) {
    try {
      const stateResult = await refreshRepositoryPullRequestStates(db, {
        workspaceId,
        repositoryId: repository.id,
      });
      stateChanges += stateResult.changed;
      stateSyncs += stateResult.queued;
    } catch {
      // The repository row records the provider-state failure for diagnostics.
    }
    if (repository.reviewIntakeMode === "manual") continue;
    try {
      results.push(
        await reconcileRepositoryIntake(db, {
          workspaceId,
          repositoryId: repository.id,
        }),
      );
    } catch {
      // The repository row records the safe failure summary for the settings UI.
    }
  }
  return {
    checked: results.filter((result) => !result.skipped).length,
    queued:
      stateSyncs + results.reduce((total, result) => total + result.queued, 0),
    stateChanges,
  };
}
