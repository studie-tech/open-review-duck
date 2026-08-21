import "server-only";

import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import {
  providerConnections,
  repositories,
  repositoryBranchMonitors,
} from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import type { db as database } from "~/server/db";
import { providerConnectionErrorMessage } from "~/server/providers/connection-error";
import { providerForConnection } from "~/server/providers/credentials";
import { startRepositoryBranchSync } from "~/server/workflows/service";

type Database = typeof database;

/** Minimum interval between automatic provider checks for one monitor. */
export const REPOSITORY_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Checks stale monitor heads and queues durable syncs without one failure stopping others. */
export async function reconcileRepositoryBranchMonitors(
  db: Database,
  options: {
    workspaceId?: string;
    staleBefore?: Date;
    deadline?: number;
    limit?: number;
  } = {},
) {
  const rows = await db
    .select({
      monitor: repositoryBranchMonitors,
      repository: repositories,
      connection: providerConnections,
    })
    .from(repositoryBranchMonitors)
    .innerJoin(
      repositories,
      eq(repositoryBranchMonitors.repositoryId, repositories.id),
    )
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .where(
      and(
        options.workspaceId
          ? eq(repositoryBranchMonitors.workspaceId, options.workspaceId)
          : undefined,
        options.staleBefore
          ? or(
              isNull(repositoryBranchMonitors.lastCheckedAt),
              lt(repositoryBranchMonitors.lastCheckedAt, options.staleBefore),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(repositoryBranchMonitors.lastCheckedAt),
      asc(repositoryBranchMonitors.createdAt),
    )
    .limit(Math.min(100, Math.max(1, options.limit ?? 25)));

  const outcomes = await mapWithLimit(rows, 3, async (scope) => {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return "deferred" as const;
    }
    try {
      const branch = await (
        await providerForConnection(db, scope.connection)
      ).getBranch(scope.repository.externalId, scope.monitor.branch);
      await db
        .update(repositoryBranchMonitors)
        .set({ lastCheckedAt: new Date(), lastError: null })
        .where(eq(repositoryBranchMonitors.id, scope.monitor.id));
      if (branch.sha === scope.monitor.currentHeadSha)
        return "checked" as const;
      await startRepositoryBranchSync(db, {
        workspaceId: scope.monitor.workspaceId,
        monitorId: scope.monitor.id,
      });
      return "queued" as const;
    } catch (cause) {
      const error = providerConnectionErrorMessage(
        scope.connection.provider,
        cause,
      ).slice(0, 300);
      await db
        .update(repositoryBranchMonitors)
        .set({ lastCheckedAt: new Date(), lastError: error })
        .where(eq(repositoryBranchMonitors.id, scope.monitor.id));
      return "failed" as const;
    }
  });

  return {
    checked: outcomes.filter((outcome) => outcome !== "deferred").length,
    queued: outcomes.filter((outcome) => outcome === "queued").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    deferred: outcomes.filter((outcome) => outcome === "deferred").length,
  };
}
