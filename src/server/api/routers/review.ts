import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  reviewComments,
  reviewQueueItems,
  reviewSessions,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
  syncRuns,
  users,
  workflowRuns,
  workspaceMembers,
} from "@/drizzle/schema";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  importPathCandidates,
} from "~/lib/import-navigation";
import { CURRENT_AI_AGENT_VERSION } from "~/server/ai/service";
import { analyzeFiles } from "~/server/analysis/engine";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { providerForConnection } from "~/server/providers/credentials";
import { ProviderError } from "~/server/providers/types";
import {
  claimCommentForPublicationRetry,
  findEquivalentUserComment,
  providerCommentBody,
  publicationAttemptKey,
  publishedThreadForComment,
  visibleProviderCommentBody,
} from "~/server/review/comments";
import { reviewCompletionCounts } from "~/server/review/completion";
import {
  removePullRequestFromQueue,
  restorePullRequestToQueue,
} from "~/server/review/queue";
import {
  assignProviderThreadsToUnits,
  hasNewProviderActivity,
  providerActivityForUnit,
} from "~/server/review/waiting";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import {
  persistedSyncErrorMessage,
  providerSyncErrorMessage,
} from "~/server/sync/error";
import {
  cancelWorkflowRun,
  startPullRequestSync,
} from "~/server/workflows/service";
import {
  awaitResponseSchema,
  importTargetSchema,
  providerReviewDecisionSchema,
  publishReviewCommentSchema,
  replyToReviewThreadSchema,
  reviewUnitSchema,
  reviewWorkspaceSchema,
  type SignOffInput,
  signOffBatchSchema,
  signOffSchema,
  syncPullRequestSchema,
  unreviewSchema,
} from "~/validators/review";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/** Builds the workspace-scoped query used to authorize pull-request access. */
const accessiblePullRequest = (userId: string, pullRequestId: string) =>
  and(eq(pullRequests.id, pullRequestId), eq(workspaceMembers.userId, userId));

/** Resolves a source provider only after loading its authorized connection. */
async function providerForScope(db: typeof database, connectionId: string) {
  const connection = await db.query.providerConnections.findFirst({
    where: eq(providerConnections.id, connectionId),
  });
  if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
  return providerForConnection(db, connection);
}

/** Checks one provider-side line against a unit's disjoint review ranges. */
function reviewUnitContainsLine(
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
async function providerScopeForUnit(
  db: typeof database,
  userId: string,
  unitId: string,
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
      provider: providerConnections.provider,
      connectionId: providerConnections.id,
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
      message: "Synchronize the pull request before publishing a comment",
    });
  }
  return scope;
}

/** Resolves the authorized provider and latest snapshot for one pull request. */
async function providerScopeForPullRequest(
  db: typeof database,
  userId: string,
  pullRequestId: string,
) {
  const [scope] = await db
    .select({
      pullRequestId: pullRequests.id,
      pullRequestNumber: pullRequests.number,
      pullRequestState: pullRequests.state,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
      repositoryExternalId: repositories.externalId,
      provider: providerConnections.provider,
      connectionId: providerConnections.id,
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
    .limit(1);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
    orderBy: [desc(reviewSnapshots.version)],
  });
  return { ...scope, snapshot };
}

/** Converts a live provider failure into a safe user-facing review message. */
function providerDecisionError(
  provider: "github" | "gitlab" | "azure_devops",
  cause: unknown,
) {
  if (cause instanceof TRPCError) return cause;
  const label =
    provider === "azure_devops"
      ? "Azure DevOps"
      : provider === "gitlab"
        ? "GitLab"
        : "GitHub";
  const permissionDenied =
    cause instanceof ProviderError &&
    (cause.status === 401 || cause.status === 403);
  return new TRPCError({
    code: permissionDenied ? "FORBIDDEN" : "BAD_GATEWAY",
    message: permissionDenied
      ? `${label} did not allow this review decision. Reconnect it with code-review write permission and confirm that you are an eligible reviewer.`
      : `${label} review state could not be synchronized`,
    cause,
  });
}

type ReviewTransaction = Parameters<
  Parameters<(typeof database)["transaction"]>[0]
>[0];

interface PersistedSignOff {
  added: boolean;
  experience: number;
  input: SignOffInput;
  pullRequestId: string;
  signOff: typeof signOffs.$inferSelect;
  snapshotId: string;
}

/** Persists one authorized sign-off without recomputing aggregate statistics. */
async function persistSignOff(
  tx: ReviewTransaction,
  userId: string,
  input: SignOffInput,
): Promise<PersistedSignOff> {
  const [requestedUnit] = await tx
    .select({
      id: reviewUnits.id,
      stableKey: reviewUnits.stableKey,
      semanticHash: reviewUnits.semanticHash,
      complexity: reviewUnits.complexity,
      snapshotId: reviewUnits.snapshotId,
      pullRequestId: pullRequests.id,
      currentHeadSha: pullRequests.headSha,
      currentBaseSha: pullRequests.baseSha,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(reviewUnits.id, input.unitId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!requestedUnit) throw new TRPCError({ code: "NOT_FOUND" });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${requestedUnit.pullRequestId}:${userId}`}))`,
  );
  const [unit] = await tx
    .select({
      id: reviewUnits.id,
      semanticHash: reviewUnits.semanticHash,
      complexity: reviewUnits.complexity,
      snapshotId: reviewUnits.snapshotId,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .where(
      and(
        eq(reviewSnapshots.pullRequestId, requestedUnit.pullRequestId),
        eq(reviewSnapshots.headSha, requestedUnit.currentHeadSha),
        eq(reviewSnapshots.baseSha, requestedUnit.currentBaseSha),
        eq(reviewUnits.stableKey, requestedUnit.stableKey),
      ),
    )
    .orderBy(desc(reviewSnapshots.version))
    .limit(1);
  if (!unit || unit.semanticHash !== requestedUnit.semanticHash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This review unit changed in the latest revision",
    });
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${unit.id}:${userId}`}))`,
  );
  const existingSignOff = await tx.query.signOffs.findFirst({
    where: and(
      eq(signOffs.unitId, unit.id),
      eq(signOffs.userId, userId),
      eq(signOffs.semanticHash, unit.semanticHash),
      isNull(signOffs.invalidatedAt),
    ),
  });
  const experience = reviewExperience(unit.complexity, input.durationSeconds);
  if (existingSignOff) {
    return {
      added: false,
      experience,
      input,
      pullRequestId: requestedUnit.pullRequestId,
      signOff: existingSignOff,
      snapshotId: unit.snapshotId,
    };
  }

  await tx
    .update(signOffs)
    .set({ invalidatedAt: new Date() })
    .where(
      and(
        eq(signOffs.unitId, unit.id),
        eq(signOffs.userId, userId),
        sql`${signOffs.invalidatedAt} is null`,
      ),
    );
  const [signOff] = await tx
    .insert(signOffs)
    .values({
      unitId: unit.id,
      userId,
      semanticHash: unit.semanticHash,
      note: input.note,
      durationSeconds: input.durationSeconds,
    })
    .returning();
  if (!signOff) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The sign-off could not be saved",
    });
  }
  return {
    added: true,
    experience,
    input,
    pullRequestId: requestedUnit.pullRequestId,
    signOff,
    snapshotId: unit.snapshotId,
  };
}

/** Applies aggregate user and review-session updates once per sign-off request. */
async function finalizeSignOffs(
  tx: ReviewTransaction,
  userId: string,
  writes: PersistedSignOff[],
) {
  const added = writes.filter((write) => write.added);
  if (added.length === 0) return;
  await recomputeReviewStats(tx, userId);

  const sessionGroups = new Map<string, PersistedSignOff[]>();
  for (const write of added) {
    if (!write.input.sessionId) continue;
    const key = `${write.input.sessionId}:${write.snapshotId}:${write.pullRequestId}`;
    sessionGroups.set(key, [...(sessionGroups.get(key) ?? []), write]);
  }
  for (const writesForSession of sessionGroups.values()) {
    const first = writesForSession[0];
    if (!first?.input.sessionId) continue;
    const [updatedSession] = await tx
      .update(reviewSessions)
      .set({
        reviewedUnits: sql`${reviewSessions.reviewedUnits} + ${writesForSession.length}`,
        experienceAwarded: sql`${reviewSessions.experienceAwarded} + ${writesForSession.reduce((total, write) => total + write.experience, 0)}`,
      })
      .where(
        and(
          eq(reviewSessions.id, first.input.sessionId),
          eq(reviewSessions.userId, userId),
          eq(reviewSessions.snapshotId, first.snapshotId),
          eq(reviewSessions.pullRequestId, first.pullRequestId),
        ),
      )
      .returning({ id: reviewSessions.id });
    if (!updatedSession) continue;
    const completion = await reviewCompletionCounts(
      tx,
      first.snapshotId,
      userId,
    );
    if (completion.total > 0 && completion.signed >= completion.total) {
      await tx
        .update(reviewSessions)
        .set({ completedAt: new Date() })
        .where(eq(reviewSessions.id, updatedSession.id));
    }
  }
}

export const reviewRouter = createTRPCRouter({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        authorLogin: pullRequests.authorLogin,
        authorAvatarUrl: pullRequests.authorAvatarUrl,
        state: pullRequests.state,
        webUrl: pullRequests.webUrl,
        updatedAt: pullRequests.updatedAt,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        queueState: reviewQueueItems.state,
        queueSource: reviewQueueItems.source,
        removedAt: reviewQueueItems.removedAt,
      })
      .from(pullRequests)
      .innerJoin(
        reviewQueueItems,
        and(
          eq(reviewQueueItems.pullRequestId, pullRequests.id),
          eq(reviewQueueItems.userId, ctx.auth.userId),
        ),
      )
      .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .innerJoin(
        workspaceMembers,
        eq(repositories.workspaceId, workspaceMembers.workspaceId),
      )
      .where(eq(workspaceMembers.userId, ctx.auth.userId))
      .orderBy(desc(pullRequests.updatedAt));
    if (rows.length === 0) return [];
    const snapshots = await ctx.db
      .selectDistinctOn([reviewSnapshots.pullRequestId], {
        id: reviewSnapshots.id,
        pullRequestId: reviewSnapshots.pullRequestId,
      })
      .from(reviewSnapshots)
      .where(
        inArray(
          reviewSnapshots.pullRequestId,
          rows.map(({ id }) => id),
        ),
      )
      .orderBy(reviewSnapshots.pullRequestId, desc(reviewSnapshots.version));
    if (snapshots.length === 0) {
      return rows.map((row) => ({
        ...row,
        totalUnits: 0,
        signedUnits: 0,
        carriedSignOffs: 0,
      }));
    }
    const units = await ctx.db
      .select({
        id: reviewUnits.id,
        snapshotId: reviewUnits.snapshotId,
        createdAt: reviewUnits.createdAt,
        kind: reviewUnits.kind,
      })
      .from(reviewUnits)
      .where(
        inArray(
          reviewUnits.snapshotId,
          snapshots.map(({ id }) => id),
        ),
      );
    const reviewableUnits = units.filter(({ kind }) => kind !== "file");
    const unitIds = reviewableUnits.map(({ id }) => id);
    const currentSignOffs =
      unitIds.length > 0
        ? await ctx.db
            .select({
              unitId: signOffs.unitId,
              signedOffAt: signOffs.signedOffAt,
            })
            .from(signOffs)
            .where(
              and(
                eq(signOffs.userId, ctx.auth.userId),
                inArray(signOffs.unitId, unitIds),
                isNull(signOffs.invalidatedAt),
              ),
            )
        : [];
    const signOffByUnit = new Map(
      currentSignOffs.map((signOff) => [signOff.unitId, signOff]),
    );
    const unitsBySnapshot = new Map<string, typeof units>();
    for (const unit of reviewableUnits) {
      unitsBySnapshot.set(unit.snapshotId, [
        ...(unitsBySnapshot.get(unit.snapshotId) ?? []),
        unit,
      ]);
    }
    const snapshotByPullRequest = new Map(
      snapshots.map((snapshot) => [snapshot.pullRequestId, snapshot.id]),
    );
    return rows.map((row) => {
      const snapshotUnits =
        unitsBySnapshot.get(snapshotByPullRequest.get(row.id) ?? "") ?? [];
      const signedUnits = snapshotUnits.filter((unit) =>
        signOffByUnit.has(unit.id),
      );
      return {
        ...row,
        totalUnits: snapshotUnits.length,
        signedUnits: signedUnits.length,
        carriedSignOffs: signedUnits.filter((unit) => {
          const signOff = signOffByUnit.get(unit.id);
          return signOff && signOff.signedOffAt < unit.createdAt;
        }).length,
      };
    });
  }),

  removeFromQueue: protectedProcedure
    .input(z.object({ pullRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      const removed = await removePullRequestFromQueue(ctx.db, {
        pullRequestId: input.pullRequestId,
        userId: ctx.auth.userId,
      });
      if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
      return removed;
    }),

  restoreToQueue: protectedProcedure
    .input(z.object({ pullRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      const restored = await restorePullRequestToQueue(ctx.db, {
        pullRequestId: input.pullRequestId,
        userId: ctx.auth.userId,
      });
      if (!restored) throw new TRPCError({ code: "NOT_FOUND" });
      return restored;
    }),

  workspace: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      const [pullRequest] = await ctx.db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          description: pullRequests.description,
          authorLogin: pullRequests.authorLogin,
          sourceBranch: pullRequests.sourceBranch,
          targetBranch: pullRequests.targetBranch,
          headSha: pullRequests.headSha,
          baseSha: pullRequests.baseSha,
          webUrl: pullRequests.webUrl,
          repositoryId: repositories.id,
          repositoryOwner: repositories.owner,
          repositoryName: repositories.name,
          repositoryWebUrl: repositories.webUrl,
          provider: providerConnections.provider,
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
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!pullRequest) throw new TRPCError({ code: "NOT_FOUND" });
      const [snapshot, previousSnapshot] =
        await ctx.db.query.reviewSnapshots.findMany({
          where: eq(reviewSnapshots.pullRequestId, pullRequest.id),
          orderBy: [desc(reviewSnapshots.version)],
          limit: 2,
        });
      if (!snapshot)
        return {
          pullRequest,
          snapshot: null,
          previousSnapshot: null,
          units: [],
          fileContexts: [],
          sourceDelivery: isLocalDeployment()
            ? ("inline" as const)
            : ("direct" as const),
        };
      const storedUnits = await ctx.db.query.reviewUnits.findMany({
        where: eq(reviewUnits.snapshotId, snapshot.id),
        orderBy: [reviewUnits.reviewOrder],
      });
      const allUnits = isLocalDeployment()
        ? await hydrateReviewUnits(ctx.db, storedUnits)
        : storedUnits.map((unit) => ({
            ...unit,
            source: "",
            previousSource: null,
          }));
      const units = allUnits.filter(({ kind }) => kind !== "file");
      const fileContexts = allUnits.filter(({ kind }) => kind === "file");
      const dependencyRows = units.length
        ? await ctx.db
            .select({
              unitId: reviewUnitDependencies.unitId,
              dependencyId: reviewUnitDependencies.dependencyId,
            })
            .from(reviewUnitDependencies)
            .where(
              inArray(
                reviewUnitDependencies.unitId,
                units.map(({ id }) => id),
              ),
            )
        : [];
      const dependenciesByUnit = new Map<string, string[]>();
      for (const { unitId, dependencyId } of dependencyRows) {
        dependenciesByUnit.set(unitId, [
          ...(dependenciesByUnit.get(unitId) ?? []),
          dependencyId,
        ]);
      }
      const [userSignOffs, userWaits] = units.length
        ? await Promise.all([
            ctx.db
              .select({ unitId: signOffs.unitId })
              .from(signOffs)
              .where(
                and(
                  eq(signOffs.userId, ctx.auth.userId),
                  inArray(
                    signOffs.unitId,
                    units.map((unit) => unit.id),
                  ),
                  isNull(signOffs.invalidatedAt),
                ),
              ),
            ctx.db
              .select({
                unitId: reviewWaits.unitId,
                waitingSince: reviewWaits.waitingSince,
              })
              .from(reviewWaits)
              .where(
                and(
                  eq(reviewWaits.userId, ctx.auth.userId),
                  inArray(
                    reviewWaits.unitId,
                    units.map((unit) => unit.id),
                  ),
                ),
              ),
          ])
        : [[], []];
      const signedUnitIds = new Set(
        userSignOffs.map((signOff) => signOff.unitId),
      );
      const waitByUnitId = new Map(
        userWaits.map((wait) => [wait.unitId, wait]),
      );
      const priorSignedUnits =
        snapshot.version > 1
          ? await ctx.db
              .selectDistinct({ stableKey: reviewUnits.stableKey })
              .from(signOffs)
              .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
              .innerJoin(
                reviewSnapshots,
                eq(reviewUnits.snapshotId, reviewSnapshots.id),
              )
              .where(
                and(
                  eq(signOffs.userId, ctx.auth.userId),
                  isNull(signOffs.invalidatedAt),
                  eq(reviewSnapshots.pullRequestId, pullRequest.id),
                  lt(reviewSnapshots.version, snapshot.version),
                ),
              )
          : [];
      const previouslySignedStableKeys = new Set(
        priorSignedUnits.map(({ stableKey }) => stableKey),
      );
      return {
        pullRequest,
        snapshot,
        sourceDelivery: isLocalDeployment()
          ? ("inline" as const)
          : ("direct" as const),
        previousSnapshot: previousSnapshot
          ? {
              id: previousSnapshot.id,
              headSha: previousSnapshot.headSha,
              version: previousSnapshot.version,
            }
          : null,
        fileContexts,
        units: units.map((unit) => {
          const wait = waitByUnitId.get(unit.id);
          return {
            ...unit,
            dependencies: dependenciesByUnit.get(unit.id) ?? [],
            status: wait
              ? ("waiting" as const)
              : signedUnitIds.has(unit.id)
                ? ("signed_off" as const)
                : unit.requiresReReview &&
                    previouslySignedStableKeys.has(unit.stableKey)
                  ? ("changed" as const)
                  : ("pending" as const),
            waitingSince: wait?.waitingSince ?? null,
            changedSinceSignOff:
              unit.requiresReReview &&
              previouslySignedStableKeys.has(unit.stableKey),
          };
        }),
      };
    }),

  providerReviewState: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `provider-review-state:${ctx.auth.userId}`,
        60,
        60_000,
      );
      const scope = await providerScopeForPullRequest(
        ctx.db,
        ctx.auth.userId,
        input.pullRequestId,
      );
      await enforceRateLimit(
        ctx.db,
        `provider-review-state-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );
      try {
        const provider = await providerForScope(ctx.db, scope.connectionId);
        const [state, remotePullRequest] = await Promise.all([
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        const revisionCurrent =
          remotePullRequest.headSha === scope.headSha &&
          remotePullRequest.baseSha === scope.baseSha &&
          scope.snapshot?.headSha === scope.headSha &&
          scope.snapshot?.baseSha === scope.baseSha;
        return {
          ...state,
          provider: scope.provider,
          revisionCurrent,
          syncedAt: new Date(),
          canApprove: revisionCurrent && state.canApprove,
          canRequestChanges: revisionCurrent && state.canRequestChanges,
          canClear: revisionCurrent && state.canClear,
          unavailableReason: revisionCurrent
            ? state.unavailableReason
            : "The provider has a newer revision. Synchronize this pull request before changing its review decision.",
        };
      } catch (cause) {
        throw providerDecisionError(scope.provider, cause);
      }
    }),

  setProviderReviewDecision: protectedProcedure
    .input(providerReviewDecisionSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `provider-review-decision:${ctx.auth.userId}`,
        20,
        10 * 60_000,
      );
      const scope = await providerScopeForPullRequest(
        ctx.db,
        ctx.auth.userId,
        input.pullRequestId,
      );
      if (
        !scope.snapshot ||
        scope.snapshot.headSha !== scope.headSha ||
        scope.snapshot.baseSha !== scope.baseSha
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Synchronize the pull request before changing its review decision",
        });
      }
      const completion = await reviewCompletionCounts(
        ctx.db,
        scope.snapshot.id,
        ctx.auth.userId,
      );
      if (completion.total === 0 || completion.signed < completion.total) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Complete every review unit before changing the provider review decision",
        });
      }
      if (
        scope.pullRequestState !== "open" &&
        scope.pullRequestState !== "draft"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This pull request is no longer open for review",
        });
      }
      try {
        const provider = await providerForScope(ctx.db, scope.connectionId);
        const [remotePullRequest, currentState] = await Promise.all([
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        if (
          remotePullRequest.headSha !== scope.headSha ||
          remotePullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The provider has a newer revision. Synchronize it before changing the review decision.",
          });
        }
        const body = input.body?.trim();
        const allowed =
          input.action === "approve"
            ? currentState.canApprove
            : input.action === "request_changes"
              ? currentState.canRequestChanges
              : currentState.canClear;
        const alreadyApplied =
          (input.action === "approve" &&
            currentState.decision === "approved") ||
          (input.action === "request_changes" &&
            currentState.decision === "changes_requested") ||
          (input.action === "clear" && currentState.decision === "none");
        if (alreadyApplied) {
          return {
            ...currentState,
            provider: scope.provider,
            revisionCurrent: true,
            syncedAt: new Date(),
            unavailableReason: currentState.unavailableReason,
          };
        }
        if (!allowed) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              currentState.unavailableReason ??
              "The connected provider account cannot submit that review decision",
          });
        }
        if (
          input.action === "request_changes" &&
          currentState.requestChangesRequiresBody &&
          !body
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Add a reason before requesting changes",
          });
        }
        await provider.setPullRequestReviewDecision({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
          action: input.action,
          body,
        });
        const [updatedState, updatedPullRequest] = await Promise.all([
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        if (
          updatedPullRequest.headSha !== scope.headSha ||
          updatedPullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The pull request changed while the review decision was being submitted. Synchronize it now.",
          });
        }
        return {
          ...updatedState,
          provider: scope.provider,
          revisionCurrent: true,
          syncedAt: new Date(),
          unavailableReason: updatedState.unavailableReason,
        };
      } catch (cause) {
        throw providerDecisionError(scope.provider, cause);
      }
    }),

  poll: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-poll:${ctx.auth.userId}`,
        60,
        60_000,
      );
      const [current] = await ctx.db
        .select({
          repositoryId: repositories.id,
          workspaceId: repositories.workspaceId,
          number: pullRequests.number,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-poll-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );

      return {
        changed: true,
        ...(await startPullRequestSync(ctx.db, {
          workspaceId: current.workspaceId,
          repositoryId: current.repositoryId,
          pullRequestNumber: current.number,
        })),
      };
    }),

  reset: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-reset:${ctx.auth.userId}`,
        10,
        60_000,
      );
      const [current] = await ctx.db
        .select({
          repositoryId: repositories.id,
          workspaceId: repositories.workspaceId,
          number: pullRequests.number,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });

      const invalidated = await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${input.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const activeSignOffs = await tx
          .select({ id: signOffs.id })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, input.pullRequestId),
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
            ),
          );
        if (activeSignOffs.length > 0) {
          await tx
            .update(signOffs)
            .set({ invalidatedAt: new Date() })
            .where(
              inArray(
                signOffs.id,
                activeSignOffs.map(({ id }) => id),
              ),
            );
        }
        await tx
          .update(reviewSessions)
          .set({
            reviewedUnits: 0,
            experienceAwarded: 0,
          })
          .where(
            and(
              eq(reviewSessions.pullRequestId, input.pullRequestId),
              eq(reviewSessions.userId, ctx.auth.userId),
              isNull(reviewSessions.completedAt),
            ),
          );
        await recomputeReviewStats(tx, ctx.auth.userId);
        return activeSignOffs.length;
      });

      return {
        invalidated,
        ...(await startPullRequestSync(ctx.db, {
          workspaceId: current.workspaceId,
          repositoryId: current.repositoryId,
          pullRequestNumber: current.number,
        })),
      };
    }),

  providerConversations: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-conversations:${ctx.auth.userId}`,
        60,
        60_000,
      );
      const [scope] = await ctx.db
        .select({
          pullRequestId: pullRequests.id,
          pullRequestNumber: pullRequests.number,
          repositoryExternalId: repositories.externalId,
          provider: providerConnections.provider,
          connectionId: providerConnections.id,
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
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-conversations-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );

      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) {
        return {
          provider: scope.provider,
          threads: [],
          syncedAt: new Date(),
          reopenedUnitIds: [],
        };
      }
      const allUnits = await ctx.db
        .select({
          id: reviewUnits.id,
          path: reviewUnits.path,
          kind: reviewUnits.kind,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
        })
        .from(reviewUnits)
        .where(eq(reviewUnits.snapshotId, snapshot.id));
      const units = allUnits.filter(({ kind }) => kind !== "file");
      const paths = new Set(units.map(({ path }) => path));
      try {
        if (!scope.connectionId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Provider connection not found",
          });
        }
        const provider = await providerForScope(ctx.db, scope.connectionId);
        const threads = await provider.listInlineCommentThreads(
          scope.repositoryExternalId,
          scope.pullRequestNumber,
        );
        const [waits, localComments] = units.length
          ? await Promise.all([
              ctx.db
                .select()
                .from(reviewWaits)
                .where(
                  and(
                    eq(reviewWaits.userId, ctx.auth.userId),
                    inArray(
                      reviewWaits.unitId,
                      units.map(({ id }) => id),
                    ),
                  ),
                ),
              ctx.db
                .select({
                  unitId: reviewComments.unitId,
                  providerExternalId: reviewComments.providerExternalId,
                })
                .from(reviewComments)
                .where(
                  and(
                    eq(reviewComments.status, "published"),
                    inArray(
                      reviewComments.unitId,
                      units.map(({ id }) => id),
                    ),
                  ),
                ),
            ])
          : [[], []];
        const explicitUnitByThreadId = new Map(
          localComments.flatMap((comment) =>
            comment.providerExternalId
              ? [[comment.providerExternalId, comment.unitId] as const]
              : [],
          ),
        );
        const assignedThreads = assignProviderThreadsToUnits(
          threads,
          units,
          explicitUnitByThreadId,
        );
        const unitById = new Map(units.map((unit) => [unit.id, unit]));
        const reopenedWaitIds: string[] = [];
        const reopenedUnitIds: string[] = [];
        for (const wait of waits) {
          const unit = unitById.get(wait.unitId);
          if (!unit) continue;
          const tracked = new Set(wait.providerThreadIds);
          const activity = providerActivityForUnit(
            assignedThreads.filter(
              (thread) =>
                thread.unitId === wait.unitId || tracked.has(thread.externalId),
            ),
            unit,
            wait.providerThreadIds,
          );
          if (
            hasNewProviderActivity(
              wait.observedCommentIds,
              activity.observedCommentIds,
            )
          ) {
            reopenedWaitIds.push(wait.id);
            reopenedUnitIds.push(wait.unitId);
          }
        }
        if (reopenedWaitIds.length) {
          await ctx.db
            .delete(reviewWaits)
            .where(
              and(
                eq(reviewWaits.userId, ctx.auth.userId),
                inArray(reviewWaits.id, reopenedWaitIds),
              ),
            );
        }
        return {
          provider: scope.provider,
          threads: assignedThreads
            .filter((thread) => paths.has(thread.path))
            .map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                body: visibleProviderCommentBody(comment.body),
              })),
            })),
          syncedAt: new Date(),
          reopenedUnitIds,
        };
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `${scope.provider === "azure_devops" ? "Azure DevOps" : scope.provider === "gitlab" ? "GitLab" : "GitHub"} conversations could not be loaded`,
          cause,
        });
      }
    }),

  awaitResponse: protectedProcedure
    .input(awaitResponseSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-await:${ctx.auth.userId}`,
        40,
        60_000,
      );
      const [scope] = await ctx.db
        .select({
          unitId: reviewUnits.id,
          path: reviewUnits.path,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
          snapshotId: reviewUnits.snapshotId,
          snapshotHeadSha: reviewSnapshots.headSha,
          snapshotBaseSha: reviewSnapshots.baseSha,
          pullRequestNumber: pullRequests.number,
          headSha: pullRequests.headSha,
          baseSha: pullRequests.baseSha,
          repositoryExternalId: repositories.externalId,
          provider: providerConnections.provider,
          connectionId: providerConnections.id,
        })
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .leftJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(reviewUnits.id, input.unitId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-await-resource:${ctx.auth.userId}:${input.unitId}`,
        20,
        60_000,
      );
      if (
        scope.snapshotHeadSha !== scope.headSha ||
        scope.snapshotBaseSha !== scope.baseSha
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Synchronize the pull request before waiting for a response",
        });
      }

      if (!scope.connectionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Local comments do not have provider response threads",
        });
      }
      const provider = await providerForScope(ctx.db, scope.connectionId);
      let threads: Awaited<
        ReturnType<typeof provider.listInlineCommentThreads>
      >;
      try {
        threads = await provider.listInlineCommentThreads(
          scope.repositoryExternalId,
          scope.pullRequestNumber,
        );
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `${scope.provider === "azure_devops" ? "Azure DevOps" : scope.provider === "gitlab" ? "GitLab" : "GitHub"} conversations could not be loaded`,
          cause,
        });
      }
      const allSnapshotUnits = await ctx.db
        .select({
          id: reviewUnits.id,
          path: reviewUnits.path,
          kind: reviewUnits.kind,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
        })
        .from(reviewUnits)
        .where(eq(reviewUnits.snapshotId, scope.snapshotId));
      const snapshotUnits = allSnapshotUnits.filter(
        ({ kind }) => kind !== "file",
      );
      const localComments = await ctx.db
        .select({
          unitId: reviewComments.unitId,
          providerExternalId: reviewComments.providerExternalId,
        })
        .from(reviewComments)
        .where(
          and(
            eq(reviewComments.status, "published"),
            inArray(
              reviewComments.unitId,
              snapshotUnits.map(({ id }) => id),
            ),
          ),
        );
      const explicitlyAssignedUnitByThreadId = new Map(
        localComments.flatMap((comment) =>
          comment.providerExternalId
            ? [[comment.providerExternalId, comment.unitId] as const]
            : [],
        ),
      );
      const assignedThreads = assignProviderThreadsToUnits(
        threads,
        snapshotUnits,
        explicitlyAssignedUnitByThreadId,
      );
      const unitThreads = assignedThreads.filter(
        (thread) => thread.unitId === scope.unitId,
      );
      const activity = providerActivityForUnit(unitThreads, scope);
      if (activity.providerThreadIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This unit needs a live provider conversation before it can await a response",
        });
      }

      return ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${scope.unitId}:${ctx.auth.userId}:wait`}))`,
        );
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            and(
              eq(signOffs.unitId, scope.unitId),
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
            ),
          );
        const [wait] = await tx
          .insert(reviewWaits)
          .values({
            unitId: scope.unitId,
            userId: ctx.auth.userId,
            providerThreadIds: activity.providerThreadIds,
            observedCommentIds: activity.observedCommentIds,
            waitingSince: new Date(),
          })
          .onConflictDoUpdate({
            target: [reviewWaits.unitId, reviewWaits.userId],
            set: {
              providerThreadIds: activity.providerThreadIds,
              observedCommentIds: activity.observedCommentIds,
              waitingSince: new Date(),
            },
          })
          .returning();
        if (!wait) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The waiting state could not be saved",
          });
        }
        return wait;
      });
    }),

  importTarget: protectedProcedure
    .input(importTargetSchema)
    .query(async ({ ctx, input }) => {
      const [scope] = await ctx.db
        .select({
          pullRequestId: pullRequests.id,
          repositoryExternalId: repositories.externalId,
          provider: providerConnections.provider,
          connectionId: providerConnections.id,
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
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });

      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });

      const candidates = importPathCandidates(
        input.sourcePath,
        input.specifier,
        input.sourceLanguage,
      );
      if (candidates.length === 0) {
        return {
          kind: "unresolved" as const,
          reason: "external" as const,
        };
      }

      const storedUnits = await hydrateReviewUnits(
        ctx.db,
        await ctx.db.query.reviewUnits.findMany({
          where: and(
            eq(reviewUnits.snapshotId, snapshot.id),
            inArray(reviewUnits.path, candidates),
          ),
          orderBy: [reviewUnits.reviewOrder],
        }),
      );
      const storedTarget = findImportTargetUnit(
        input.sourcePath,
        input.sourceLanguage,
        input,
        storedUnits,
      );
      if (storedTarget) {
        if (storedTarget.exactUnit) {
          return {
            kind: "unit" as const,
            unitId: storedTarget.exactUnit.id,
          };
        }
        const moduleUnit = storedTarget.moduleUnit;
        if (moduleUnit) {
          return {
            kind: "preview" as const,
            path: moduleUnit.path,
            language: moduleUnit.language,
            name: input.imported,
            source: moduleUnit.source,
            startLine: moduleUnit.startLine,
            endLine: moduleUnit.endLine,
            focusLine: findImportedDeclarationLine(
              moduleUnit.source,
              input.imported,
              moduleUnit.language,
              moduleUnit.startLine,
            ),
            inReviewPath: true,
          };
        }
      }

      const provider = await providerForScope(ctx.db, scope.connectionId);
      for (const path of candidates) {
        let content: string | undefined;
        try {
          content = await provider.getFileContent(
            scope.repositoryExternalId,
            path,
            snapshot.headSha,
            150_000,
          );
        } catch (cause) {
          if (cause instanceof ProviderError && cause.status === 404) continue;
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "The imported source could not be loaded from the provider",
            cause,
          });
        }
        if (content === undefined) {
          return {
            kind: "unresolved" as const,
            reason: "too_large" as const,
          };
        }
        const analyzed = analyzeFiles([
          { path, content, changeType: "modified" },
        ]).units;
        const exactTarget =
          input.kind === "named"
            ? analyzed.find(
                (unit) =>
                  unit.kind !== "module" &&
                  unit.kind !== "file" &&
                  unit.name === input.imported,
              )
            : undefined;
        const target =
          exactTarget ??
          analyzed.find((unit) => unit.kind === "file") ??
          analyzed.find((unit) => unit.kind === "module");
        if (!target) continue;
        return {
          kind: "preview" as const,
          path,
          language: target.language,
          name: input.imported,
          source: target.source,
          startLine: target.startLine,
          endLine: target.endLine,
          focusLine:
            exactTarget?.startLine ??
            findImportedDeclarationLine(
              target.source,
              input.imported,
              target.language,
              target.startLine,
            ),
          inReviewPath: false,
        };
      }
      return {
        kind: "unresolved" as const,
        reason: "not_found" as const,
      };
    }),

  unitDiscussion: protectedProcedure
    .input(reviewUnitSchema)
    .query(async ({ ctx, input }) => {
      const [unit] = await ctx.db
        .select({
          id: reviewUnits.id,
          path: reviewUnits.path,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
          changeType: reviewUnits.changeType,
          snapshotId: reviewUnits.snapshotId,
          pullRequestId: pullRequests.id,
        })
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(reviewUnits.id, input.unitId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!unit) throw new TRPCError({ code: "NOT_FOUND" });

      const [comments, reviewJob, pathUnits] = await Promise.all([
        ctx.db.query.reviewComments.findMany({
          where: eq(reviewComments.unitId, unit.id),
          orderBy: [reviewComments.createdAt],
        }),
        ctx.db.query.aiJobs.findFirst({
          where: and(
            eq(aiJobs.pullRequestId, unit.pullRequestId),
            eq(aiJobs.snapshotId, unit.snapshotId),
            eq(aiJobs.userId, ctx.auth.userId),
            eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
            eq(aiJobs.kind, "review"),
            eq(aiJobs.status, "completed"),
            isNull(aiJobs.unitId),
          ),
          orderBy: [desc(aiJobs.createdAt)],
        }),
        ctx.db.query.reviewUnits.findMany({
          where: and(
            eq(reviewUnits.snapshotId, unit.snapshotId),
            eq(reviewUnits.path, unit.path),
          ),
        }),
      ]);
      const findings =
        reviewJob?.result?.findings.flatMap((finding, index) => {
          if (finding.path !== unit.path || finding.line === undefined)
            return [];
          const target = pathUnits
            .filter(
              (candidate) =>
                finding.line !== undefined &&
                reviewUnitContainsLine(candidate, finding.line),
            )
            .sort((left, right) => {
              const spanDifference =
                left.endLine -
                left.startLine -
                (right.endLine - right.startLine);
              if (spanDifference !== 0) return spanDifference;
              const leftRank =
                left.kind === "file" ? 2 : left.kind === "module" ? 1 : 0;
              const rightRank =
                right.kind === "file" ? 2 : right.kind === "module" ? 1 : 0;
              return leftRank - rightRank;
            })[0];
          return target?.id === unit.id
            ? [{ ...finding, index, aiJobId: reviewJob.id }]
            : [];
        }) ?? [];
      return { comments, findings };
    }),

  publishComment: protectedProcedure
    .input(publishReviewCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await providerScopeForUnit(
        ctx.db,
        ctx.auth.userId,
        input.unitId,
      );
      if (!reviewUnitContainsLine(scope, input.line)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The selected line is outside this review unit",
        });
      }

      let body = input.body;
      let source: "user" | "ai" = "user";
      const aiResultIndex = input.aiFindingIndex ?? input.aiCommentIndex;
      if (input.aiJobId !== undefined && aiResultIndex !== undefined) {
        source = "ai";
        const job = await ctx.db.query.aiJobs.findFirst({
          where: and(
            eq(aiJobs.id, input.aiJobId),
            eq(aiJobs.userId, ctx.auth.userId),
            eq(aiJobs.pullRequestId, scope.pullRequestId),
            eq(aiJobs.snapshotId, scope.snapshotId),
            eq(aiJobs.status, "completed"),
          ),
        });
        if (input.aiFindingIndex !== undefined) {
          const finding = job?.result?.findings[input.aiFindingIndex];
          if (
            job?.kind !== "review" ||
            !finding ||
            finding.path !== scope.path ||
            finding.line !== input.line
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This AI finding no longer matches the selected code",
            });
          }
          body = `**${finding.title}**\n\n${finding.body}`;
        } else {
          const proposal =
            job?.result?.commentProposals?.[input.aiCommentIndex ?? -1];
          if (
            job?.kind !== "explain" ||
            !job.question ||
            !proposal ||
            proposal.path !== scope.path ||
            proposal.line !== input.line
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This AI comment proposal no longer matches the selected code",
            });
          }
          body = input.body ?? proposal.body;
        }
      }
      if (!body) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Comment text is required",
        });
      }

      let retryingPublication = false;
      let comment =
        source === "user"
          ? await findEquivalentUserComment(ctx.db, {
              unitId: scope.unitId,
              userId: ctx.auth.userId,
              body,
              line: input.line,
            })
          : undefined;
      const equivalentUserCommentFound = comment !== undefined;
      if (comment?.status === "published") return comment;
      if (comment?.status === "failed" || comment?.status === "publishing") {
        comment = await claimCommentForPublicationRetry(ctx.db, comment.id);
        retryingPublication = comment !== undefined;
      }
      if (!comment && !equivalentUserCommentFound) {
        const publicationLeaseToken = randomUUID();
        [comment] = await ctx.db
          .insert(reviewComments)
          .values({
            unitId: scope.unitId,
            userId: ctx.auth.userId,
            aiJobId: input.aiJobId,
            aiFindingIndex: aiResultIndex,
            source,
            body,
            line: input.line,
            status: "publishing",
            publicationLeaseToken,
          })
          .onConflictDoNothing()
          .returning();
      }
      if (!comment) {
        comment =
          input.aiJobId !== undefined
            ? await ctx.db.query.reviewComments.findFirst({
                where: and(
                  eq(reviewComments.aiJobId, input.aiJobId),
                  eq(reviewComments.aiFindingIndex, aiResultIndex ?? -1),
                ),
              })
            : undefined;
        if (comment?.status === "published") return comment;
        if (comment?.status === "failed" || comment?.status === "publishing") {
          comment = await claimCommentForPublicationRetry(ctx.db, comment.id);
          retryingPublication = comment !== undefined;
        }
      }
      if (!comment) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This comment is already being published",
        });
      }
      if (!comment.publicationLeaseToken) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This comment publication lease is unavailable",
        });
      }
      const publicationLeaseToken = comment.publicationLeaseToken;

      try {
        const provider = await providerForScope(ctx.db, scope.connectionId);
        const existingThread = retryingPublication
          ? publishedThreadForComment(
              await provider.listInlineCommentThreads(
                scope.repositoryExternalId,
                scope.pullRequestNumber,
              ),
              comment.id,
            )
          : undefined;
        const published = existingThread
          ? { externalId: existingThread.externalId }
          : await provider.publishInlineComment({
              repositoryExternalId: scope.repositoryExternalId,
              pullRequestNumber: scope.pullRequestNumber,
              headSha: scope.headSha,
              path: scope.path,
              line: input.line,
              side: scope.changeType === "deleted" ? "left" : "right",
              body: providerCommentBody(body, comment.id),
              idempotencyKey: publicationAttemptKey(comment.id),
            });
        const [updated] = await ctx.db
          .update(reviewComments)
          .set({
            status: "published",
            providerExternalId: published.externalId,
            publicationLeaseToken: null,
            error: null,
            publishedAt: new Date(),
          })
          .where(
            and(
              eq(reviewComments.id, comment.id),
              eq(reviewComments.status, "publishing"),
              eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
            ),
          )
          .returning();
        if (!updated) {
          throw new Error("Comment publication lease was superseded");
        }
        return updated;
      } catch (cause) {
        const message = providerSyncErrorMessage(scope.provider, cause);
        await ctx.db
          .update(reviewComments)
          .set({
            status: "failed",
            publicationLeaseToken: null,
            error: message,
          })
          .where(
            and(
              eq(reviewComments.id, comment.id),
              eq(reviewComments.status, "publishing"),
              eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
            ),
          );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message,
          cause,
        });
      }
    }),

  replyToThread: protectedProcedure
    .input(replyToReviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await providerScopeForUnit(
        ctx.db,
        ctx.auth.userId,
        input.unitId,
      );
      await enforceRateLimit(
        ctx.db,
        `review-reply:${ctx.auth.userId}:${scope.pullRequestId}`,
        30,
        60_000,
      );
      const provider = await providerForScope(ctx.db, scope.connectionId);
      try {
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
        const parentCommentExternalId = thread?.comments[0]?.externalId;
        if (!thread || !parentCommentExternalId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "This provider conversation is no longer attached to the current review unit",
          });
        }
        return await provider.replyToInlineThread({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          parentCommentExternalId,
          body: input.body,
        });
      } catch (cause) {
        if (cause instanceof TRPCError) throw cause;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: providerSyncErrorMessage(scope.provider, cause),
          cause,
        });
      }
    }),

  beginSession: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ snapshotId: reviewSnapshots.id })
        .from(reviewSnapshots)
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .orderBy(desc(reviewSnapshots.version))
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${accessible.snapshotId}:${ctx.auth.userId}:session`}))`,
        );
        const existing = await tx.query.reviewSessions.findFirst({
          where: and(
            eq(reviewSessions.pullRequestId, input.pullRequestId),
            eq(reviewSessions.snapshotId, accessible.snapshotId),
            eq(reviewSessions.userId, ctx.auth.userId),
            isNull(reviewSessions.completedAt),
          ),
        });
        if (existing) return existing;
        const [session] = await tx
          .insert(reviewSessions)
          .values({
            pullRequestId: input.pullRequestId,
            snapshotId: accessible.snapshotId,
            userId: ctx.auth.userId,
          })
          .returning();
        return session;
      });
    }),

  sync: protectedProcedure
    .input(syncPullRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-sync:${ctx.auth.userId}`,
        40,
        60_000,
      );
      const [access] = await ctx.db
        .select({
          id: repositories.id,
          workspaceId: repositories.workspaceId,
        })
        .from(repositories)
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!access) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-sync-resource:${ctx.auth.userId}:${input.repositoryId}`,
        20,
        60_000,
      );
      return startPullRequestSync(ctx.db, {
        workspaceId: access.workspaceId,
        repositoryId: access.id,
        pullRequestNumber: input.number,
        queue: {
          userId: ctx.auth.userId,
          source: "manual",
          explicit: true,
        },
      });
    }),

  syncStatus: protectedProcedure
    .input(z.object({ syncId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [sync] = await ctx.db
        .select({ sync: syncRuns, providerRunId: workflowRuns.providerRunId })
        .from(syncRuns)
        .innerJoin(
          workspaceMembers,
          eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
        )
        .leftJoin(workflowRuns, eq(syncRuns.workflowRunId, workflowRuns.id))
        .where(
          and(
            eq(syncRuns.id, input.syncId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!sync) throw new TRPCError({ code: "NOT_FOUND" });
      return { ...sync.sync, providerRunId: sync.providerRunId };
    }),

  activeSyncs: protectedProcedure.query(async ({ ctx }) =>
    ctx.db
      .select({
        id: syncRuns.id,
        repositoryId: syncRuns.repositoryId,
        pullRequestNumber: syncRuns.pullRequestNumber,
        status: syncRuns.status,
        progress: syncRuns.progress,
        createdAt: syncRuns.createdAt,
        startedAt: syncRuns.startedAt,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        title: pullRequests.title,
      })
      .from(syncRuns)
      .innerJoin(repositories, eq(syncRuns.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .leftJoin(
        pullRequests,
        and(
          eq(pullRequests.repositoryId, syncRuns.repositoryId),
          eq(pullRequests.number, syncRuns.pullRequestNumber),
        ),
      )
      .innerJoin(
        workspaceMembers,
        eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
      )
      .where(
        and(
          eq(workspaceMembers.userId, ctx.auth.userId),
          inArray(syncRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(syncRuns.createdAt)),
  ),

  recentSyncFailures: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: syncRuns.id,
        repositoryId: syncRuns.repositoryId,
        pullRequestNumber: syncRuns.pullRequestNumber,
        status: syncRuns.status,
        progress: syncRuns.progress,
        completedAt: syncRuns.completedAt,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        title: pullRequests.title,
        error: syncRuns.error,
      })
      .from(syncRuns)
      .innerJoin(repositories, eq(syncRuns.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .leftJoin(
        pullRequests,
        and(
          eq(pullRequests.repositoryId, syncRuns.repositoryId),
          eq(pullRequests.number, syncRuns.pullRequestNumber),
        ),
      )
      .innerJoin(
        workspaceMembers,
        eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
      )
      .where(
        and(
          eq(workspaceMembers.userId, ctx.auth.userId),
          gte(syncRuns.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1_000)),
        ),
      )
      .orderBy(desc(syncRuns.createdAt))
      .limit(100);

    const seenPullRequests = new Set<string>();
    const failures = [];
    for (const row of rows) {
      const key = `${row.repositoryId}:${row.pullRequestNumber}`;
      if (seenPullRequests.has(key)) continue;
      seenPullRequests.add(key);
      if (row.status !== "failed") continue;
      const { error, ...failure } = row;
      failures.push({
        ...failure,
        message: persistedSyncErrorMessage(row.provider, error),
      });
      if (failures.length === 3) break;
    }
    return failures;
  }),

  cancelSync: protectedProcedure
    .input(z.object({ syncId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [sync] = await ctx.db
        .select({ runId: workflowRuns.providerRunId })
        .from(syncRuns)
        .innerJoin(
          workspaceMembers,
          eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
        )
        .innerJoin(workflowRuns, eq(syncRuns.workflowRunId, workflowRuns.id))
        .where(
          and(
            eq(syncRuns.id, input.syncId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!sync) throw new TRPCError({ code: "NOT_FOUND" });
      await cancelWorkflowRun(ctx.db, sync.runId);
      await ctx.db
        .update(syncRuns)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(syncRuns.id, input.syncId));
      return { status: "cancelled" as const };
    }),

  signOff: protectedProcedure
    .input(signOffSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const write = await persistSignOff(tx, ctx.auth.userId, input);
        await finalizeSignOffs(tx, ctx.auth.userId, [write]);
        return write.signOff;
      }),
    ),

  signOffBatch: protectedProcedure
    .input(signOffBatchSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const writes: PersistedSignOff[] = [];
        const results = new Map<
          string,
          | { ok: true; unitId: string }
          | {
              code: "CONFLICT" | "NOT_FOUND";
              message: string;
              ok: false;
              unitId: string;
            }
        >();
        const ordered = [...input.signOffs].sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        );
        for (const signOffInput of ordered) {
          try {
            const write = await persistSignOff(
              tx,
              ctx.auth.userId,
              signOffInput,
            );
            writes.push(write);
            results.set(signOffInput.unitId, {
              ok: true,
              unitId: signOffInput.unitId,
            });
          } catch (cause) {
            if (
              cause instanceof TRPCError &&
              (cause.code === "CONFLICT" || cause.code === "NOT_FOUND")
            ) {
              results.set(signOffInput.unitId, {
                code: cause.code,
                message: cause.message,
                ok: false,
                unitId: signOffInput.unitId,
              });
              continue;
            }
            throw cause;
          }
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        return input.signOffs.map(
          ({ unitId }) =>
            results.get(unitId) ?? {
              code: "NOT_FOUND" as const,
              message: "The review unit could not be saved",
              ok: false as const,
              unitId,
            },
        );
      }),
    ),

  unreview: protectedProcedure
    .input(unreviewSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [unit] = await tx
          .select({
            id: reviewUnits.id,
            snapshotId: reviewUnits.snapshotId,
            semanticHash: reviewUnits.semanticHash,
            complexity: reviewUnits.complexity,
            stableKey: reviewUnits.stableKey,
            pullRequestId: pullRequests.id,
          })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .innerJoin(
            pullRequests,
            eq(reviewSnapshots.pullRequestId, pullRequests.id),
          )
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(
            and(
              eq(reviewUnits.id, input.unitId),
              eq(reviewSnapshots.headSha, pullRequests.headSha),
              eq(reviewSnapshots.baseSha, pullRequests.baseSha),
              eq(workspaceMembers.userId, ctx.auth.userId),
            ),
          )
          .limit(1);
        if (!unit) throw new TRPCError({ code: "NOT_FOUND" });

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${unit.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${unit.id}:${ctx.auth.userId}`}))`,
        );
        const activeSignOff = await tx.query.signOffs.findFirst({
          where: and(
            eq(signOffs.unitId, unit.id),
            eq(signOffs.userId, ctx.auth.userId),
            eq(signOffs.semanticHash, unit.semanticHash),
            isNull(signOffs.invalidatedAt),
          ),
          orderBy: [desc(signOffs.signedOffAt)],
        });
        if (!activeSignOff) return { unreviewed: false };

        const lineageUnits = await tx
          .select({ id: reviewUnits.id })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, unit.pullRequestId),
              eq(reviewUnits.stableKey, unit.stableKey),
            ),
          );
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            and(
              inArray(
                signOffs.unitId,
                lineageUnits.map(({ id }) => id),
              ),
              eq(signOffs.userId, ctx.auth.userId),
              eq(signOffs.semanticHash, activeSignOff.semanticHash),
              eq(signOffs.signedOffAt, activeSignOff.signedOffAt),
              isNull(signOffs.invalidatedAt),
            ),
          );

        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, unit.snapshotId),
            ),
          });
          if (session && activeSignOff.signedOffAt >= session.startedAt) {
            const experience = reviewExperience(
              unit.complexity,
              activeSignOff.durationSeconds,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - 1, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }

        await recomputeReviewStats(tx, ctx.auth.userId);
        return { unreviewed: true };
      }),
    ),

  gamification: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.auth.userId),
    });
    const reviewEvents = await ctx.db
      .selectDistinct({
        semanticHash: signOffs.semanticHash,
        signedOffAt: signOffs.signedOffAt,
        durationSeconds: signOffs.durationSeconds,
      })
      .from(signOffs)
      .where(
        and(
          eq(signOffs.userId, ctx.auth.userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    return {
      currentStreak: user?.currentStreak ?? 0,
      longestStreak: user?.longestStreak ?? 0,
      experiencePoints: user?.experiencePoints ?? 0,
      totalSignOffs: reviewEvents.length,
      reviewSeconds: reviewEvents.reduce(
        (total, event) => total + event.durationSeconds,
        0,
      ),
    };
  }),
});

/** Calculates experience awarded for a completed review unit. */
function reviewExperience(complexity: number, durationSeconds: number) {
  return Math.min(
    75,
    5 + complexity * 3 + Math.round(Math.min(durationSeconds, 600) / 30),
  );
}

/** Recalculates review achievements and streaks from persisted activity. */
async function recomputeReviewStats(
  tx: Parameters<Parameters<(typeof database)["transaction"]>[0]>[0],
  userId: string,
) {
  const events = await tx
    .selectDistinct({
      semanticHash: signOffs.semanticHash,
      signedOffAt: signOffs.signedOffAt,
      durationSeconds: signOffs.durationSeconds,
      complexity: reviewUnits.complexity,
    })
    .from(signOffs)
    .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
    .where(and(eq(signOffs.userId, userId), isNull(signOffs.invalidatedAt)));
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const reviewDays = [
    ...new Set(
      events.map(({ signedOffAt }) =>
        Date.UTC(
          signedOffAt.getUTCFullYear(),
          signedOffAt.getUTCMonth(),
          signedOffAt.getUTCDate(),
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  let runningStreak = 0;
  let longestStreak = 0;
  let previousDay: number | undefined;
  for (const day of reviewDays) {
    runningStreak = previousDay === day - 86_400_000 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = day;
  }
  const latestDay = reviewDays.at(-1);
  const currentStreak =
    latestDay === today || latestDay === today - 86_400_000 ? runningStreak : 0;
  const lastReviewDate = events.reduce<Date | null>(
    (latest, event) =>
      !latest || event.signedOffAt > latest ? event.signedOffAt : latest,
    null,
  );
  const experiencePoints = events.reduce(
    (total, event) =>
      total + reviewExperience(event.complexity, event.durationSeconds),
    0,
  );

  await tx
    .update(users)
    .set({
      experiencePoints,
      currentStreak,
      longestStreak,
      lastReviewDate,
    })
    .where(eq(users.id, userId));
}
