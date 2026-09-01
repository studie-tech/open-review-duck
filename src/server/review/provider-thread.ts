import "server-only";

import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  workspaceMembers,
} from "@/drizzle/schema";
import { providerLabel } from "~/lib/provider-labels";
import { providerConnectionRecovery } from "~/lib/provider-permission-recovery";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { providerForConnection } from "~/server/providers/credentials";
import { isProviderPermissionFailure } from "~/server/providers/status-class";
import type {
  ProviderName,
  ProviderPullRequestLifecycle,
  PullRequestProvider,
} from "~/server/providers/types";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { providerSyncErrorMessage } from "~/server/sync/error";

/** Builds the workspace-scoped query used to authorize pull-request access. */
export const accessiblePullRequest = (userId: string, pullRequestId: string) =>
  and(eq(pullRequests.id, pullRequestId), eq(workspaceMembers.userId, userId));

/**
 * Authorizes and rate-limits one management action on a provider conversation.
 *
 * Resolving, editing and deleting all reach the same provider through the same
 * unit, so they share one gate rather than each restating the lookup.
 */
export async function reviewThreadScope(
  db: typeof database,
  userId: string,
  input: { unitId: string },
  action: string,
) {
  // Two gates, as everywhere else provider work is reached from: what one
  // reviewer may ask for at all, and what they may ask of one repository.
  // Both wait on the lookup, so a request that never reaches the provider
  // reports why it was refused rather than spending limiter budget.
  const scope = await providerScopeForUnit(db, userId, input.unitId);
  await Promise.all([
    enforceRateLimit(db, `${action}:${userId}`, 60, 60_000),
    enforceRateLimit(
      db,
      `${action}-resource:${userId}:${scope.pullRequestId}`,
      30,
      60_000,
    ),
  ]);
  return { provider: await providerForConnection(db, scope.connection), scope };
}

/**
 * Finds the named conversation among those anchored to the reviewed unit.
 *
 * A conversation the unit does not own is not the reviewer's to manage from
 * here, so an id that points elsewhere reads as missing rather than as an
 * action on some other part of the pull request.
 */
export async function attachedProviderThread(
  provider: PullRequestProvider,
  scope: Awaited<ReturnType<typeof providerScopeForUnit>>,
  input: { threadExternalId: string },
) {
  const thread = (
    await provider.listInlineCommentThreads(
      scope.repositoryExternalId,
      scope.pullRequestNumber,
    )
  ).find(
    (candidate) =>
      candidate.externalId === input.threadExternalId &&
      candidate.path === scope.path &&
      reviewUnitContainsLine(scope, candidate.line),
  );
  if (!thread) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "This provider conversation is no longer attached to the current review unit",
    });
  }
  return thread;
}

/** Presents a failed conversation action in the provider's own terms. */
export function providerThreadError(provider: ProviderName, cause: unknown) {
  if (cause instanceof TRPCError) return cause;
  return new TRPCError({
    code: "BAD_REQUEST",
    message: providerSyncErrorMessage(provider, cause),
    cause,
  });
}

/** Checks one provider-side line against a unit's disjoint review ranges. */
export function reviewUnitContainsLine(
  unit: Pick<
    typeof reviewUnits.$inferSelect,
    "changeType" | "endLine" | "relatedRanges" | "startLine"
  >,
  line: number,
) {
  const ranges =
    unit.relatedRanges?.flatMap((range) => {
      const start =
        unit.changeType === "deleted"
          ? range.previousStartLine
          : range.startLine;
      const end =
        unit.changeType === "deleted" ? range.previousEndLine : range.endLine;
      return start !== undefined && end !== undefined ? [{ start, end }] : [];
    }) ?? [];
  return ranges.length > 0
    ? ranges.some(({ start, end }) => line >= start && line <= end)
    : line >= unit.startLine && line <= unit.endLine;
}

/** Resolves and authorizes the provider context for one review unit. */
export async function providerScopeForUnit(
  db: typeof database,
  userId: string,
  unitId: string,
  staleRevisionMessage = "Synchronize the pull request before changing its conversations",
) {
  const [scope] = await db
    .select({
      unitId: reviewUnits.id,
      path: reviewUnits.path,
      startLine: reviewUnits.startLine,
      endLine: reviewUnits.endLine,
      relatedRanges: reviewUnits.relatedRanges,
      changeType: reviewUnits.changeType,
      snapshotId: reviewUnits.snapshotId,
      snapshotHeadSha: reviewSnapshots.headSha,
      snapshotBaseSha: reviewSnapshots.baseSha,
      pullRequestId: pullRequests.id,
      pullRequestNumber: pullRequests.number,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
      repositoryExternalId: repositories.externalId,
      connection: providerConnections,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(and(eq(reviewUnits.id, unitId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    scope.snapshotHeadSha !== scope.headSha ||
    scope.snapshotBaseSha !== scope.baseSha
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: staleRevisionMessage,
    });
  }
  return scope;
}

/** Resolves the authorized provider and latest snapshot for one pull request. */
export async function providerScopeForPullRequest(
  db: typeof database,
  userId: string,
  pullRequestId: string,
) {
  // The snapshot is keyed on the id the authorization filters on, so it reads
  // nothing that lookup produces and shares its round trip.
  const [[scope], snapshot] = await Promise.all([
    db
      .select({
        pullRequestId: pullRequests.id,
        pullRequestNumber: pullRequests.number,
        pullRequestState: pullRequests.state,
        headSha: pullRequests.headSha,
        baseSha: pullRequests.baseSha,
        repositoryExternalId: repositories.externalId,
        connection: providerConnections,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .innerJoin(
        workspaceMembers,
        eq(repositories.workspaceId, workspaceMembers.workspaceId),
      )
      .where(accessiblePullRequest(userId, pullRequestId))
      .limit(1),
    db.query.reviewSnapshots.findFirst({
      where: eq(reviewSnapshots.pullRequestId, pullRequestId),
      orderBy: [desc(reviewSnapshots.version)],
    }),
  ]);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  return { ...scope, snapshot };
}

const githubAppMergeRemints = new Map<string, number>();
const GITHUB_APP_MERGE_REMINT_MS = 60_000;

/**
 * Reloads GitHub App lifecycle after Contents write is granted on the install.
 *
 * Cached installation tokens can still be Contents: read from before the
 * grant. Remint at most once a minute so pending-check polling does not mint
 * on every refresh.
 */
export async function providerLifecycleForConnection(
  db: typeof database,
  connection: typeof providerConnections.$inferSelect,
  repositoryExternalId: string,
  pullRequestNumber: number,
) {
  /** Loads merge state, optionally reminting a GitHub App installation token. */
  const load = async (refreshInstallation?: boolean) => {
    const provider = await providerForConnection(db, connection, {
      refreshInstallation,
    });
    const [lifecycle, remotePullRequest] = await Promise.all([
      provider.getPullRequestLifecycle(repositoryExternalId, pullRequestNumber),
      provider.getPullRequest(repositoryExternalId, pullRequestNumber),
    ]);
    return { provider, lifecycle, remotePullRequest };
  };

  const first = await load();
  if (
    first.lifecycle.hasMergePermission !== false ||
    connection.credentialKind !== "github_app" ||
    !connection.installationId
  ) {
    return first;
  }

  const lastRemint = githubAppMergeRemints.get(connection.installationId) ?? 0;
  if (Date.now() - lastRemint < GITHUB_APP_MERGE_REMINT_MS) {
    return first;
  }
  githubAppMergeRemints.set(connection.installationId, Date.now());
  try {
    return await load(true);
  } catch {
    return first;
  }
}

/** Converts a live provider failure into a safe user-facing review message. */
export function providerOperationError(
  provider: ProviderName,
  cause: unknown,
  operation: "review" | "lifecycle" | "merge",
) {
  if (cause instanceof TRPCError) return cause;
  const label = providerLabel(provider);
  const permissionDenied = isProviderPermissionFailure(cause);
  const messages = {
    review: {
      forbidden: `${label} did not allow this review decision. Reconnect it with code-review write permission and confirm that you are an eligible reviewer.`,
      failed: `${label} review state could not be synchronized`,
    },
    lifecycle: {
      forbidden: `${label} did not allow reading checks and merge state. Reconnect it with permission to view pipelines.`,
      failed: `${label} checks and merge state could not be synchronized`,
    },
    merge: {
      forbidden: `${label} did not allow merging this pull request. Reconnect it with merge permission, or finish the merge on ${label}.`,
      failed: `${label} could not merge this pull request`,
    },
  }[operation];
  return new TRPCError({
    code: permissionDenied ? "FORBIDDEN" : "BAD_GATEWAY",
    message: permissionDenied ? messages.forbidden : messages.failed,
    cause,
  });
}

/** Gates merge on the exact revision the reviewer just finished. */
export function scopedProviderLifecycle(
  scope: {
    connection: {
      id: string;
      credentialKind: string;
      provider: ProviderName;
    };
    headSha: string;
    baseSha: string;
    snapshot?: { headSha: string; baseSha: string } | null;
  },
  lifecycle: ProviderPullRequestLifecycle,
  remote: { headSha: string; baseSha: string },
) {
  const revisionCurrent =
    remote.headSha === scope.headSha &&
    remote.baseSha === scope.baseSha &&
    scope.snapshot?.headSha === scope.headSha &&
    scope.snapshot?.baseSha === scope.baseSha;
  return {
    ...lifecycle,
    provider: scope.connection.provider,
    revisionCurrent,
    syncedAt: new Date(),
    canMerge: revisionCurrent && lifecycle.canMerge,
    mergeBlockedReason: revisionCurrent
      ? lifecycle.mergeBlockedReason
      : "The provider has a newer revision. Synchronize this pull request before merging.",
    connection: providerConnectionRecovery(
      isLocalDeployment(),
      scope.connection,
    ),
  };
}
