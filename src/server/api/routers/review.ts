import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  reviewComments,
  reviewConceptDependencies,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewQueueItems,
  reviewSessions,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
  snapshotFiles,
  syncRuns,
  users,
  workflowRuns,
  workspaceMembers,
} from "@/drizzle/schema";
import { conceptStatusFromMembers } from "~/lib/concept-progress";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  importPathCandidates,
} from "~/lib/import-navigation";
import { buildProviderLifecycle } from "~/lib/provider-lifecycle";
import { providerConnectionRecovery } from "~/lib/provider-permission-recovery";
import {
  definitionIsWhereTheNameWasRead,
  localDefinitionForPeek,
  sameFileDeclarationPeek,
} from "~/lib/symbol-peek";
import { managedAiPlanTier } from "~/server/ai/plan";
import {
  proposeSemanticConceptLayout,
  SEMANTIC_CLUSTER_TIMED_OUT,
  SEMANTIC_CLUSTER_TOO_LARGE,
} from "~/server/ai/semantic-clustering";
import { CURRENT_AI_AGENT_VERSION } from "~/server/ai/service";
import {
  MAX_CONCEPT_CHANGED_LINES,
  MAX_CONCEPT_FILES,
} from "~/server/analysis/concepts";
import { analyzeFiles } from "~/server/analysis/engine";
import { sha256 } from "~/server/analysis/hash";
import { importReferenceForLocal } from "~/server/analysis/imports";
import { isLocalDeployment } from "~/server/deployment";
import { providerForConnection } from "~/server/providers/credentials";
import type { ProviderPullRequestLifecycle } from "~/server/providers/types";
import {
  assertCommentIsTheReviewersToChange,
  claimCommentForPublicationRetry,
  findEquivalentUserComment,
  forgetPublishedComments,
  providerCommentBody,
  publicationAttemptKey,
  publishedCommentId,
  publishedThreadForComment,
  rewrittenProviderCommentBody,
  visibleProviderCommentBody,
} from "~/server/review/comments";
import { reviewCompletionCounts } from "~/server/review/completion";
import {
  deepReviewFindingForPublication,
  deepReviewRunPayload,
} from "~/server/review/deep/payload";
import {
  recomputeReviewStats,
  reviewExperience,
} from "~/server/review/experience";
import {
  accessiblePullRequest,
  attachedProviderThread,
  providerLifecycleForConnection,
  providerOperationError,
  providerScopeForPullRequest,
  providerScopeForUnit,
  providerThreadError,
  reviewThreadScope,
  reviewUnitContainsLine,
  scopedProviderLifecycle,
} from "~/server/review/provider-thread";
import {
  removePullRequestFromQueue,
  restorePullRequestToQueue,
} from "~/server/review/queue";
import {
  assertSnapshotIsCurrent,
  beginReviewWaits,
  conceptLayoutSnapshotId,
  conceptMembersForMutation,
  currentSnapshotFileForMember,
  finalizeSignOffs,
  finalizeUnreviews,
  lockConceptLayoutForReviewer,
  lockConceptLayoutScope,
  type PersistedSignOff,
  persistSignOffs,
  persistUnreviews,
  signOffFailure,
} from "~/server/review/sign-off";
import {
  declaredSymbolInSnapshot,
  importCandidateReads,
  importedSymbolDefinition,
  parsedSymbolFile,
} from "~/server/review/symbol-peek";
import { unitsWithoutSource } from "~/server/review/units";
import {
  assignProviderThreadsToUnits,
  hasNewProviderActivity,
  providerActivityForUnit,
} from "~/server/review/waiting";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import {
  connectionUpdateResolvesSyncFailure,
  persistedSyncErrorMessage,
  providerSyncErrorMessage,
} from "~/server/sync/error";
import {
  cancelWorkflowRun,
  startPullRequestSync,
} from "~/server/workflows/service";
import {
  editReviewThreadCommentSchema,
  importTargetSchema,
  improveConceptGroupingSchema,
  providerReviewDecisionSchema,
  publishReviewCommentSchema,
  releaseReviewWaitsSchema,
  replacePersonalConceptLayoutSchema,
  replyToReviewThreadSchema,
  resolveReviewThreadSchema,
  reviewFileActionSchema,
  reviewThreadCommentSchema,
  reviewThreadSchema,
  reviewUnitSchema,
  reviewWorkspaceSchema,
  signOffBatchSchema,
  signOffConceptSchema,
  signOffSchema,
  symbolDefinitionSchema,
  syncPullRequestSchema,
  unreviewBatchSchema,
  unreviewConceptSchema,
  unreviewFileSchema,
  unreviewSchema,
} from "~/validators/review";
import { createTRPCRouter, protectedProcedure } from "../trpc";

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
    const progress = await ctx.db
      .select({
        snapshotId: reviewUnits.snapshotId,
        totalUnits: sql<number>`count(distinct ${reviewUnits.id})`,
        signedUnits: sql<number>`count(distinct ${signOffs.unitId})`,
        carriedSignOffs: sql<number>`count(distinct ${signOffs.unitId}) filter (where ${signOffs.signedOffAt} < ${reviewUnits.createdAt})`,
      })
      .from(reviewUnits)
      .leftJoin(
        signOffs,
        and(
          eq(signOffs.unitId, reviewUnits.id),
          eq(signOffs.userId, ctx.auth.userId),
          isNull(signOffs.invalidatedAt),
        ),
      )
      .where(
        and(
          inArray(
            reviewUnits.snapshotId,
            snapshots.map(({ id }) => id),
          ),
          ne(reviewUnits.kind, "file"),
        ),
      )
      .groupBy(reviewUnits.snapshotId);
    const progressBySnapshot = new Map(
      progress.map((counts) => [counts.snapshotId, counts]),
    );
    const snapshotByPullRequest = new Map(
      snapshots.map((snapshot) => [snapshot.pullRequestId, snapshot.id]),
    );
    return rows.map((row) => {
      const counts = progressBySnapshot.get(
        snapshotByPullRequest.get(row.id) ?? "",
      );
      return {
        ...row,
        totalUnits: Number(counts?.totalUnits ?? 0),
        signedUnits: Number(counts?.signedUnits ?? 0),
        carriedSignOffs: Number(counts?.carriedSignOffs ?? 0),
      };
    });
  }),

  removeFromQueue: protectedProcedure
    .input(reviewWorkspaceSchema)
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
    .input(reviewWorkspaceSchema)
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
      // The two newest snapshots are keyed on the id the authorization filters
      // on, so they read nothing that lookup produces and share its round trip.
      const [[pullRequest], [snapshot, previousSnapshot]] = await Promise.all([
        ctx.db
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
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            providerConnections,
            eq(repositories.connectionId, providerConnections.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
          .limit(1),
        ctx.db.query.reviewSnapshots.findMany({
          where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
          orderBy: [desc(reviewSnapshots.version)],
          limit: 2,
        }),
      ]);
      if (!pullRequest) throw new TRPCError({ code: "NOT_FOUND" });
      if (!snapshot)
        return {
          pullRequest,
          snapshot: null,
          previousSnapshot: null,
          units: [],
          files: [],
          fileContexts: [],
          conceptLayout: null,
          concepts: [],
        };
      // The unit list, the reviewer's concept layouts and their sign-offs on
      // earlier revisions depend only on the snapshot, so they are one round.
      const [storedUnits, storedFiles, layouts, priorSignedUnits, priorUnits] =
        await Promise.all([
          ctx.db.query.reviewUnits.findMany({
            where: eq(reviewUnits.snapshotId, snapshot.id),
            orderBy: [reviewUnits.reviewOrder],
          }),
          ctx.db.query.snapshotFiles.findMany({
            where: eq(snapshotFiles.snapshotId, snapshot.id),
            orderBy: [snapshotFiles.path],
            columns: {
              id: true,
              path: true,
              previousPath: true,
              changeType: true,
              additions: true,
              deletions: true,
              isBinary: true,
              skipReason: true,
            },
          }),
          ctx.db
            .select()
            .from(reviewConceptLayouts)
            .where(
              and(
                eq(reviewConceptLayouts.snapshotId, snapshot.id),
                or(
                  eq(reviewConceptLayouts.userId, ctx.auth.userId),
                  isNull(reviewConceptLayouts.userId),
                ),
              ),
            ),
          snapshot.version > 1
            ? ctx.db
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
            : [],
          previousSnapshot
            ? ctx.db.query.reviewUnits.findMany({
                where: eq(reviewUnits.snapshotId, previousSnapshot.id),
                columns: { stableKey: true },
              })
            : [],
        ]);
      const activeLayout =
        layouts.find(({ userId }) => userId === ctx.auth.userId) ??
        layouts.find(({ userId }) => userId === null);
      // Source hydration, per-unit review state and the concepts of the active
      // layout are all derived from that round and are independent of one
      // another, so they issue together instead of one after the next.
      const reviewableUnitIds = storedUnits
        .filter(({ kind }) => kind !== "file")
        .map(({ id }) => id);
      const [
        allUnits,
        dependencyRows,
        userSignOffs,
        userWaits,
        storedConcepts,
      ] = await Promise.all([
        unitsWithoutSource(storedUnits),
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: reviewUnitDependencies.unitId,
                dependencyId: reviewUnitDependencies.dependencyId,
              })
              .from(reviewUnitDependencies)
              .where(inArray(reviewUnitDependencies.unitId, reviewableUnitIds))
          : [],
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: signOffs.unitId,
                signedOffAt: signOffs.signedOffAt,
              })
              .from(signOffs)
              .where(
                and(
                  eq(signOffs.userId, ctx.auth.userId),
                  inArray(signOffs.unitId, reviewableUnitIds),
                  isNull(signOffs.invalidatedAt),
                ),
              )
          : [],
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: reviewWaits.unitId,
                waitingSince: reviewWaits.waitingSince,
              })
              .from(reviewWaits)
              .where(
                and(
                  eq(reviewWaits.userId, ctx.auth.userId),
                  inArray(reviewWaits.unitId, reviewableUnitIds),
                ),
              )
          : [],
        activeLayout
          ? ctx.db.query.reviewConcepts.findMany({
              where: eq(reviewConcepts.layoutId, activeLayout.id),
              orderBy: [reviewConcepts.reviewOrder],
            })
          : [],
      ]);
      const units = allUnits.filter(({ kind }) => kind !== "file");
      const fileContexts = allUnits.filter(({ kind }) => kind === "file");
      const dependenciesByUnit = new Map<string, string[]>();
      for (const { unitId, dependencyId } of dependencyRows) {
        const existing = dependenciesByUnit.get(unitId);
        if (existing) existing.push(dependencyId);
        else dependenciesByUnit.set(unitId, [dependencyId]);
      }
      const signedUnitIds = new Set(
        userSignOffs.map((signOff) => signOff.unitId),
      );
      const signedOffAtByUnitId = new Map(
        userSignOffs.map((signOff) => [signOff.unitId, signOff.signedOffAt]),
      );
      const layoutLockedByNewSignOff = userSignOffs.some(
        ({ signedOffAt }) => signedOffAt >= snapshot.createdAt,
      );
      const waitByUnitId = new Map(
        userWaits.map((wait) => [wait.unitId, wait]),
      );
      const previouslySignedStableKeys = new Set(
        priorSignedUnits.map(({ stableKey }) => stableKey),
      );
      const previousStableKeys = new Set(
        priorUnits.map(({ stableKey }) => stableKey),
      );
      const workspaceUnits = units.map((unit) => {
        const wait = waitByUnitId.get(unit.id);
        const signedOffAt = signedOffAtByUnitId.get(unit.id);
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
          revisionState:
            snapshot.version === 1
              ? ("initial" as const)
              : !previousStableKeys.has(unit.stableKey)
                ? ("new" as const)
                : unit.requiresReReview
                  ? ("updated" as const)
                  : ("unchanged" as const),
          signOffOrigin: signedOffAt
            ? signedOffAt < snapshot.createdAt
              ? ("preserved" as const)
              : ("current" as const)
            : ("none" as const),
        };
      });
      let conceptLayout: {
        id: string;
        version: number;
        source: "deterministic" | "manual" | "ai";
        locked: boolean;
        personal: boolean;
      } | null = null;
      let concepts: Array<{
        id: string;
        stableKey: string;
        title: string;
        rationale: string | null;
        reviewOrder: number;
        changedLineCount: number;
        fileCount: number;
        oversized: boolean;
        dependencies: string[];
        memberIds: string[];
        status: "pending" | "partial" | "waiting" | "signed_off" | "changed";
        signedMemberCount: number;
      }> = [];
      if (activeLayout) {
        conceptLayout = {
          id: activeLayout.id,
          version: activeLayout.version,
          source: activeLayout.source,
          locked: Boolean(activeLayout.lockedAt) || layoutLockedByNewSignOff,
          personal: Boolean(activeLayout.userId),
        };
        const conceptIds = storedConcepts.map(({ id }) => id);
        const [memberRows, conceptDependencyRows] = conceptIds.length
          ? await Promise.all([
              ctx.db
                .select()
                .from(reviewConceptMembers)
                .where(inArray(reviewConceptMembers.conceptId, conceptIds)),
              ctx.db
                .select()
                .from(reviewConceptDependencies)
                .where(
                  inArray(reviewConceptDependencies.conceptId, conceptIds),
                ),
            ])
          : [[], []];
        const membersByConcept = new Map<string, typeof memberRows>();
        for (const member of memberRows) {
          const existing = membersByConcept.get(member.conceptId);
          if (existing) existing.push(member);
          else membersByConcept.set(member.conceptId, [member]);
        }
        const dependenciesByConcept = new Map<string, string[]>();
        for (const dependency of conceptDependencyRows) {
          const existing = dependenciesByConcept.get(dependency.conceptId);
          if (existing) existing.push(dependency.dependencyId);
          else {
            dependenciesByConcept.set(dependency.conceptId, [
              dependency.dependencyId,
            ]);
          }
        }
        const unitById = new Map(workspaceUnits.map((unit) => [unit.id, unit]));
        concepts = storedConcepts.map((concept) => {
          const memberIds = (membersByConcept.get(concept.id) ?? [])
            .sort((left, right) => left.memberOrder - right.memberOrder)
            .map(({ unitId }) => unitId);
          const members = memberIds
            .map((id) => unitById.get(id))
            .filter((unit): unit is (typeof workspaceUnits)[number] =>
              Boolean(unit),
            );
          const signedMemberCount = members.filter(
            ({ status }) => status === "signed_off",
          ).length;
          return {
            ...concept,
            dependencies: dependenciesByConcept.get(concept.id) ?? [],
            memberIds,
            status: conceptStatusFromMembers(members, memberIds.length),
            signedMemberCount,
          };
        });
      } else {
        // Snapshots produced before concept analysis remain fully reviewable and
        // fail safe as one-unit concepts until their next synchronization.
        concepts = workspaceUnits.map((unit, reviewOrder) => ({
          id: unit.id,
          stableKey: `singleton:${unit.stableKey}`,
          title: unit.name,
          rationale: "This snapshot predates concept grouping.",
          reviewOrder,
          changedLineCount: unit.changedLineCount,
          fileCount: 1,
          oversized: unit.changedLineCount > MAX_CONCEPT_CHANGED_LINES,
          dependencies: [],
          memberIds: [unit.id],
          status: unit.status,
          signedMemberCount: unit.status === "signed_off" ? 1 : 0,
        }));
      }
      return {
        pullRequest,
        snapshot,
        previousSnapshot: previousSnapshot
          ? {
              id: previousSnapshot.id,
              headSha: previousSnapshot.headSha,
              version: previousSnapshot.version,
            }
          : null,
        files: storedFiles,
        fileContexts,
        conceptLayout,
        concepts,
        units: workspaceUnits,
      };
    }),

  providerReviewState: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The reviewer-wide gate reads nothing the lookup produces, so the two
      // share one round trip.
      const [scope] = await Promise.all([
        providerScopeForPullRequest(
          ctx.db,
          ctx.auth.userId,
          input.pullRequestId,
        ),
        enforceRateLimit(
          ctx.db,
          `provider-review-state:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      await enforceRateLimit(
        ctx.db,
        `provider-review-state-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
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
          provider: scope.connection.provider,
          revisionCurrent,
          syncedAt: new Date(),
          canApprove: revisionCurrent && state.canApprove,
          canRequestChanges: revisionCurrent && state.canRequestChanges,
          canClear: revisionCurrent && state.canClear,
          unavailableReason: revisionCurrent
            ? state.unavailableReason
            : "The provider has a newer revision. Synchronize this pull request before changing its review decision.",
          connection: providerConnectionRecovery(
            isLocalDeployment(),
            scope.connection,
          ),
        };
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "review",
        );
      }
    }),

  providerLifecycle: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The reviewer-wide gate reads nothing the lookup produces, so the two
      // share one round trip.
      const [scope] = await Promise.all([
        providerScopeForPullRequest(
          ctx.db,
          ctx.auth.userId,
          input.pullRequestId,
        ),
        enforceRateLimit(
          ctx.db,
          `provider-lifecycle:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      await enforceRateLimit(
        ctx.db,
        `provider-lifecycle-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );
      try {
        const { lifecycle, remotePullRequest } =
          await providerLifecycleForConnection(
            ctx.db,
            scope.connection,
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          );
        return scopedProviderLifecycle(scope, lifecycle, remotePullRequest);
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "lifecycle",
        );
      }
    }),

  mergePullRequest: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `provider-merge:${ctx.auth.userId}`,
        10,
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
          message: "Synchronize the pull request before merging",
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
          message: "Complete every review unit before merging",
        });
      }
      if (
        scope.pullRequestState !== "open" &&
        scope.pullRequestState !== "draft"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This pull request is no longer open",
        });
      }
      try {
        const {
          provider,
          lifecycle: currentLifecycle,
          remotePullRequest,
        } = await providerLifecycleForConnection(
          ctx.db,
          scope.connection,
          scope.repositoryExternalId,
          scope.pullRequestNumber,
        );
        if (
          remotePullRequest.headSha !== scope.headSha ||
          remotePullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The provider has a newer revision. Synchronize it before merging.",
          });
        }
        if (currentLifecycle.pullRequestState === "merged") {
          await ctx.db
            .update(pullRequests)
            .set({ state: "merged", lastSyncedAt: new Date() })
            .where(eq(pullRequests.id, scope.pullRequestId));
          return scopedProviderLifecycle(
            scope,
            currentLifecycle,
            remotePullRequest,
          );
        }
        if (!currentLifecycle.canMerge) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              currentLifecycle.mergeBlockedReason ??
              "The provider is not ready to merge this pull request",
          });
        }
        await provider.mergePullRequest({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
        });
        let updatedLifecycle: ProviderPullRequestLifecycle;
        try {
          updatedLifecycle = await provider.getPullRequestLifecycle(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          );
        } catch {
          updatedLifecycle = buildProviderLifecycle({
            checks: currentLifecycle.checks,
            pullRequestState: "merged",
            headSha: scope.headSha,
            mergeable: true,
            canMerge: false,
            mergeBlockedReason:
              scope.connection.provider === "azure_devops"
                ? "Already completed"
                : "Already merged",
            mergeActionLabel: currentLifecycle.mergeActionLabel,
          });
        }
        if (
          updatedLifecycle.pullRequestState === "merged" ||
          updatedLifecycle.pullRequestState === "closed"
        ) {
          await ctx.db
            .update(pullRequests)
            .set({
              state: updatedLifecycle.pullRequestState,
              lastSyncedAt: new Date(),
            })
            .where(eq(pullRequests.id, scope.pullRequestId));
        }
        return scopedProviderLifecycle(
          scope,
          updatedLifecycle,
          remotePullRequest,
        );
      } catch (cause) {
        throw providerOperationError(scope.connection.provider, cause, "merge");
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
        const provider = await providerForConnection(ctx.db, scope.connection);
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
            provider: scope.connection.provider,
            revisionCurrent: true,
            syncedAt: new Date(),
            unavailableReason: currentState.unavailableReason,
            connection: providerConnectionRecovery(
              isLocalDeployment(),
              scope.connection,
            ),
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
          provider: scope.connection.provider,
          revisionCurrent: true,
          syncedAt: new Date(),
          unavailableReason: updatedState.unavailableReason,
          connection: providerConnectionRecovery(
            isLocalDeployment(),
            scope.connection,
          ),
        };
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "review",
        );
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
      // The reviewer-wide gate and the snapshot both read nothing the lookup
      // produces, so the three share one round trip.
      const [[scope], snapshot] = await Promise.all([
        ctx.db
          .select({
            pullRequestId: pullRequests.id,
            pullRequestNumber: pullRequests.number,
            repositoryExternalId: repositories.externalId,
            connection: providerConnections,
          })
          .from(pullRequests)
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            providerConnections,
            eq(repositories.connectionId, providerConnections.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
          .limit(1),
        ctx.db.query.reviewSnapshots.findFirst({
          where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
          orderBy: [desc(reviewSnapshots.version)],
        }),
        enforceRateLimit(
          ctx.db,
          `review-conversations:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-conversations-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );

      if (!snapshot) {
        return {
          provider: scope.connection.provider,
          threads: [],
          syncedAt: new Date(),
          answeredUnitIds: [],
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
        const provider = await providerForConnection(ctx.db, scope.connection);
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
                  userId: reviewComments.userId,
                  providerExternalId: reviewComments.providerExternalId,
                  providerCommentExternalId:
                    reviewComments.providerCommentExternalId,
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
        // The provider attributes everything ReviewDuck posts to the one
        // workspace connection, so the conversation carries who actually
        // wrote each comment. A control the server would refuse should not
        // be offered in the first place.
        const publisherByProviderId = new Map(
          localComments.flatMap(
            ({ providerCommentExternalId, providerExternalId, userId }) => [
              ...(providerCommentExternalId
                ? [[providerCommentExternalId, userId] as const]
                : []),
              ...(providerExternalId
                ? [[providerExternalId, userId] as const]
                : []),
            ],
          ),
        );
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
        const answeredUnitIds: string[] = [];
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
            answeredUnitIds.push(wait.unitId);
          }
        }
        // The waits stay held: releasing them here would clear the waiting
        // state before the reviewer has seen what answered it. Only the unit
        // whose conversation moved is reported as answered — a sibling in the
        // same concept stays on the review path unless it was paused itself.
        const answeredWaits = waits.filter(({ unitId }) =>
          answeredUnitIds.includes(unitId),
        );
        return {
          provider: scope.connection.provider,
          threads: assignedThreads
            .filter((thread) => paths.has(thread.path))
            .map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment, index) => {
                // A root comment is recorded against the conversation it
                // opened; a reply against itself.
                const publisher =
                  publisherByProviderId.get(comment.externalId) ??
                  (index === 0
                    ? publisherByProviderId.get(thread.externalId)
                    : undefined);
                return {
                  ...comment,
                  body: visibleProviderCommentBody(comment.body),
                  // Absent means nobody here published it, which leaves it as
                  // open to change as the provider itself would leave it.
                  publishedByAnotherReviewer:
                    publisher !== undefined && publisher !== ctx.auth.userId,
                };
              }),
            })),
          syncedAt: new Date(),
          answeredUnitIds: answeredWaits.map(({ unitId }) => unitId),
        };
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: providerSyncErrorMessage(scope.connection.provider, cause),
          cause,
        });
      }
    }),

  awaitResponse: protectedProcedure
    .input(reviewUnitSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-await:${ctx.auth.userId}`,
        40,
        60_000,
      );
      await enforceRateLimit(
        ctx.db,
        `review-await-resource:${ctx.auth.userId}:${input.unitId}`,
        20,
        60_000,
      );
      const [wait] = await beginReviewWaits(ctx.db, ctx.auth.userId, [
        input.unitId,
      ]);
      if (!wait) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The waiting state could not be saved",
        });
      }
      return wait;
    }),

  /**
   * Takes back the waits one reviewer is holding.
   *
   * Deliberately free of the revision check every other concept action makes:
   * a reviewer whose pull request has moved on can neither sign off nor be
   * answered, so refusing to release here would be the one state with no way
   * out at all.
   */
  releaseReviewWaits: protectedProcedure
    .input(releaseReviewWaitsSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-release-wait:${ctx.auth.userId}`,
        40,
        60_000,
      );
      const accessible = await ctx.db
        .selectDistinct({ unitId: reviewUnits.id })
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
            inArray(reviewUnits.id, input.unitIds),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        );
      if (accessible.length === 0) throw new TRPCError({ code: "NOT_FOUND" });
      const released = await ctx.db
        .delete(reviewWaits)
        .where(
          and(
            eq(reviewWaits.userId, ctx.auth.userId),
            inArray(
              reviewWaits.unitId,
              accessible.map(({ unitId }) => unitId),
            ),
          ),
        )
        .returning({ unitId: reviewWaits.unitId });
      return {
        // Both, because a request can name a unit whose row another tab or a
        // poll already removed: it is deleted here by nobody, yet the caller
        // still believes it is paused and still has to be told otherwise.
        authorizedUnitIds: accessible.map(({ unitId }) => unitId),
        releasedUnitIds: released.map(({ unitId }) => unitId),
      };
    }),

  importTarget: protectedProcedure
    .input(importTargetSchema)
    .query(async ({ ctx, input }) => {
      const scope = await providerScopeForPullRequest(
        ctx.db,
        ctx.auth.userId,
        input.pullRequestId,
      );
      const snapshot = scope.snapshot;
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

      const provider = await providerForConnection(ctx.db, scope.connection);
      for await (const read of importCandidateReads(
        provider,
        scope.repositoryExternalId,
        snapshot.headSha,
        candidates,
      )) {
        if (read.kind === "missing") continue;
        if (read.kind === "failed") {
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "The imported source could not be loaded from the provider",
            cause: read.cause,
          });
        }
        if (read.content === undefined) {
          return {
            kind: "unresolved" as const,
            reason: "too_large" as const,
          };
        }
        const analyzed = analyzeFiles([
          { path: read.path, content: read.content, changeType: "modified" },
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
          path: read.path,
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

  /**
   * Finds where a name used in the reviewed code is declared.
   *
   * A reviewer reading a call has to know what it does, and leaving the review
   * to find out is the expensive part. The whole file first answers local
   * declarations and identifies imports the browser has not parsed yet. A
   * known import is followed precisely; names without one can then use the
   * snapshot's unique repository-wide declaration as a safe fallback.
   */
  symbolDefinition: protectedProcedure
    .input(symbolDefinitionSchema)
    .query(async ({ ctx, input }) => {
      // Ahead of the lookup's own reads: a hover the reviewer is over budget
      // for should not pay for a scope and a snapshot query first.
      await enforceRateLimit(
        ctx.db,
        `review-symbol:${ctx.auth.userId}`,
        240,
        60_000,
      );
      // The snapshot is keyed on the id the authorization filters on, so it
      // reads nothing that lookup produces and shares its round trip.
      const [[scope], snapshot] = await Promise.all([
        ctx.db
          .select({
            pullRequestId: pullRequests.id,
            repositoryExternalId: repositories.externalId,
            connection: providerConnections,
          })
          .from(pullRequests)
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            providerConnections,
            eq(repositories.connectionId, providerConnections.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
          .limit(1),
        ctx.db.query.reviewSnapshots.findFirst({
          where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
          orderBy: [desc(reviewSnapshots.version)],
        }),
      ]);
      if (!scope || !snapshot) throw new TRPCError({ code: "NOT_FOUND" });

      const parsedFile = await parsedSymbolFile(ctx.db, snapshot.id, input);
      // Browser-side import parsing is progressive: a reviewer can hover a
      // value before its grammar has loaded. The stored full file is the
      // authoritative fallback, so imported variables do not depend on that
      // client timing while functions already indexed in the review work.
      const fileImport = parsedFile
        ? importReferenceForLocal(parsedFile.imports, input.symbol)
        : undefined;
      const resolvedInput =
        input.specifier || !fileImport
          ? input
          : {
              ...input,
              specifier: fileImport.specifier,
              imported: fileImport.imported,
              kind: fileImport.kind,
            };
      const read = { line: input.line, path: input.sourcePath };
      const analyzedDeclaration = parsedFile?.declarations.get(input.symbol);
      const local = localDefinitionForPeek(
        analyzedDeclaration,
        parsedFile &&
          (!analyzedDeclaration ||
            definitionIsWhereTheNameWasRead(analyzedDeclaration, read))
          ? sameFileDeclarationPeek({
              language: parsedFile.language,
              path: input.sourcePath,
              source: parsedFile.source,
              symbol: input.symbol,
            })
          : undefined,
        read,
      );
      const imported = resolvedInput.specifier
        ? await importedSymbolDefinition(
            ctx.db,
            ctx.auth.userId,
            { headSha: snapshot.headSha, id: snapshot.id },
            scope,
            resolvedInput,
          )
        : undefined;
      const found =
        local ??
        imported ??
        (await declaredSymbolInSnapshot(ctx.db, snapshot.id, input));
      if (!found) {
        return { kind: "unresolved" as const, reason: "not_found" as const };
      }
      if (found.kind === "unresolved") return found;
      if (
        definitionIsWhereTheNameWasRead(found, {
          line: input.line,
          path: input.sourcePath,
        })
      ) {
        return { kind: "unresolved" as const, reason: "self" as const };
      }
      return found;
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
          columns: { id: true },
          // The run's `result` carries its summary, annotations, proposals and
          // concepts for the whole pull request, and this query re-runs on
          // every unit the reviewer opens, so the findings are cut out in
          // Postgres rather than deserialized per navigation.
          extras: {
            findings: sql<
              NonNullable<typeof aiJobs.$inferSelect.result>["findings"] | null
            >`${aiJobs.result} -> 'findings'`.as("findings"),
          },
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
          columns: {
            changeType: true,
            endLine: true,
            id: true,
            kind: true,
            relatedRanges: true,
            startLine: true,
          },
          where: and(
            eq(reviewUnits.snapshotId, unit.snapshotId),
            eq(reviewUnits.path, unit.path),
          ),
        }),
      ]);
      const findings =
        reviewJob?.findings?.flatMap((finding, index) => {
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

  deepReviewFindings: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The snapshot is keyed on the id the authorization filters on, so it
      // reads nothing that lookup produces and shares its round trip.
      const [[accessible], snapshot] = await Promise.all([
        ctx.db
          .select({ id: pullRequests.id })
          .from(pullRequests)
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
          .limit(1),
        ctx.db.query.reviewSnapshots.findFirst({
          columns: { id: true },
          where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
          orderBy: [desc(reviewSnapshots.version)],
        }),
      ]);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      if (!snapshot) return null;

      // The same scope `ai.reviewStatus` resolves a run by, and the only one
      // the findings below inherit: a deep-review parent is the reviewer's own
      // run against this revision, and `parentJobId` excludes its children.
      const job = await ctx.db.query.aiJobs.findFirst({
        columns: {
          id: true,
          status: true,
          createdAt: true,
          completedAt: true,
          completionReason: true,
          deepReviewTerminalState: true,
          runFailureClass: true,
          error: true,
        },
        where: and(
          eq(aiJobs.pullRequestId, input.pullRequestId),
          eq(aiJobs.snapshotId, snapshot.id),
          eq(aiJobs.userId, ctx.auth.userId),
          eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
          eq(aiJobs.kind, "review"),
          isNull(aiJobs.unitId),
          isNull(aiJobs.parentJobId),
        ),
        orderBy: [desc(aiJobs.createdAt)],
      });
      if (!job) return null;
      return await deepReviewRunPayload(ctx.db, job);
    }),

  publishComment: protectedProcedure
    .input(publishReviewCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await providerScopeForUnit(
        ctx.db,
        ctx.auth.userId,
        input.unitId,
        "Synchronize the pull request before publishing a comment",
      );
      if (!reviewUnitContainsLine(scope, input.line)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The selected line is outside this review unit",
        });
      }

      let body = input.body;
      let source: "user" | "ai" = "user";
      let aiResultIndex = input.aiFindingIndex ?? input.aiCommentIndex;
      if (
        input.aiJobId !== undefined &&
        (aiResultIndex !== undefined || input.aiFindingId !== undefined)
      ) {
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
        if (input.aiFindingId !== undefined) {
          // Authorization is the job lookup above, unchanged; the row
          // predicates below only establish that the finding still describes
          // this line.
          if (job?.kind !== "review" || job.parentJobId !== null) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This AI finding does not belong to the selected review",
            });
          }
          const finding = await deepReviewFindingForPublication(ctx.db, {
            findingId: input.aiFindingId,
            parentJobId: job.id,
            path: scope.path,
            line: input.line,
          });
          body = finding.body;
          aiResultIndex = finding.orderIndex;
        } else if (input.aiFindingIndex !== undefined) {
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
        const provider = await providerForConnection(ctx.db, scope.connection);
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
        const message = providerSyncErrorMessage(
          scope.connection.provider,
          cause,
        );
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
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-reply",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        const parentCommentExternalId = thread.comments[0]?.externalId;
        if (!parentCommentExternalId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "This provider conversation is no longer attached to the current review unit",
          });
        }
        const reply = await provider.replyToInlineThread({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          parentCommentExternalId,
          body: input.body,
        });
        // A reply opens no conversation, so this row exists to say who wrote
        // it. Without it the reply would be the one thing ReviewDuck posts
        // that any other member could rewrite or remove.
        await ctx.db.insert(reviewComments).values({
          unitId: input.unitId,
          userId: ctx.auth.userId,
          source: "user",
          body: input.body,
          line: thread.line,
          status: "published",
          providerCommentExternalId: reply.externalId,
          publishedAt: new Date(),
        });
        return reply;
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  setThreadResolution: protectedProcedure
    .input(resolveReviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-resolve-thread",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        await provider.setInlineThreadResolution({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          resolved: input.resolved,
        });
        return { resolved: input.resolved };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  editThreadComment: protectedProcedure
    .input(editReviewThreadCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-edit-comment",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        const edited = thread.comments.find(
          ({ externalId }) => externalId === input.commentExternalId,
        );
        if (!edited) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That comment is no longer part of this conversation",
          });
        }
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          input.commentExternalId,
        );
        await provider.editInlineComment({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          commentExternalId: input.commentExternalId,
          body: rewrittenProviderCommentBody(edited.body, input.body),
        });
        // A root comment is recorded against the conversation it opened and
        // a reply against itself, so the rewrite has to follow whichever key
        // the ledger holds it under.
        const conversationId = publishedCommentId(
          thread,
          input.commentExternalId,
        );
        await ctx.db
          .update(reviewComments)
          .set({ body: input.body })
          .where(
            and(
              eq(reviewComments.unitId, input.unitId),
              conversationId
                ? or(
                    eq(reviewComments.providerExternalId, conversationId),
                    eq(
                      reviewComments.providerCommentExternalId,
                      input.commentExternalId,
                    ),
                  )
                : eq(
                    reviewComments.providerCommentExternalId,
                    input.commentExternalId,
                  ),
            ),
          );
        return { edited: true };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  deleteThreadComment: protectedProcedure
    .input(reviewThreadCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-delete-comment",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        if (
          !thread.comments.some(
            ({ externalId }) => externalId === input.commentExternalId,
          )
        ) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That comment is no longer part of this conversation",
          });
        }
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          input.commentExternalId,
        );
        await provider.deleteInlineComment({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          commentExternalId: input.commentExternalId,
        });
        await forgetPublishedComments(ctx.db, input.unitId, {
          conversationIds: [
            publishedCommentId(thread, input.commentExternalId),
          ],
          commentIds: [input.commentExternalId],
        });
        return { deleted: 1 };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  deleteThread: protectedProcedure
    .input(reviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-delete-thread",
      );
      const thread = await attachedProviderThread(provider, scope, input).catch(
        (cause: unknown) => {
          throw providerThreadError(scope.connection.provider, cause);
        },
      );
      // Deleting a conversation takes every comment in it, so each one has to
      // be the reviewer's to take.
      for (const comment of thread.comments) {
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          comment.externalId,
        );
      }
      // Replies first: no provider lets the comment a conversation hangs
      // from leave while the conversation still holds answers to it.
      const ordered = [...thread.comments].reverse();
      const removed: string[] = [];
      try {
        for (const comment of ordered) {
          await provider.deleteInlineComment({
            repositoryExternalId: scope.repositoryExternalId,
            pullRequestNumber: scope.pullRequestNumber,
            threadExternalId: thread.externalId,
            commentExternalId: comment.externalId,
          });
          removed.push(comment.externalId);
        }
      } catch (cause) {
        // A conversation is deleted one comment at a time, so a failure part
        // way through leaves comments already gone at the provider. The ledger
        // is what tells the reviewer a comment is still posted, so it gives the
        // conversation up as soon as the comment it hangs from has left.
        await forgetPublishedComments(ctx.db, input.unitId, {
          conversationIds: removed.some(
            (externalId) =>
              publishedCommentId(thread, externalId) !== undefined,
          )
            ? [thread.externalId]
            : [],
          commentIds: removed,
        });
        throw providerThreadError(scope.connection.provider, cause);
      }
      await forgetPublishedComments(ctx.db, input.unitId, {
        conversationIds: [thread.externalId],
        commentIds: removed,
      });
      return { deleted: removed.length };
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
        createdAt: syncRuns.createdAt,
        completedAt: syncRuns.completedAt,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        connectionUpdatedAt: providerConnections.updatedAt,
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
      if (connectionUpdateResolvesSyncFailure(row, row.connectionUpdatedAt)) {
        continue;
      }
      failures.push({
        id: row.id,
        repositoryId: row.repositoryId,
        pullRequestNumber: row.pullRequestNumber,
        status: row.status,
        progress: row.progress,
        completedAt: row.completedAt,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        provider: row.provider,
        title: row.title,
        message: persistedSyncErrorMessage(row.provider, row.error),
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

  improveConceptGrouping: protectedProcedure
    .input(improveConceptGroupingSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `semantic-clustering:${ctx.auth.userId}`,
        5,
        60 * 60_000,
      );
      try {
        const planTier = managedAiPlanTier((feature) =>
          ctx.auth.has({ feature }),
        );
        return await proposeSemanticConceptLayout(ctx.db, {
          ...input,
          userId: ctx.auth.userId,
          subscribed: planTier !== "free",
          planTier,
        });
      } catch (cause) {
        console.error("Semantic review grouping failed", cause);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            cause instanceof Error &&
            [
              "The review concept layout changed or is locked",
              "A newer personal review concept layout is active",
              "AI grouping did not return a complete review partition",
              SEMANTIC_CLUSTER_TOO_LARGE,
              SEMANTIC_CLUSTER_TIMED_OUT,
            ].includes(cause.message)
              ? cause.message
              : "AI could not improve this grouping. The current layout was not changed.",
        });
      }
    }),

  replacePersonalConceptLayout: protectedProcedure
    .input(replacePersonalConceptLayoutSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `concept-layout:${ctx.auth.userId}`,
        60,
        60_000,
      );
      return ctx.db.transaction(async (tx) => {
        await lockConceptLayoutScope(tx, ctx.auth.userId, input.snapshotId);
        const [snapshot] = await tx
          .select({
            id: reviewSnapshots.id,
            createdAt: reviewSnapshots.createdAt,
          })
          .from(reviewSnapshots)
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
              eq(reviewSnapshots.id, input.snapshotId),
              eq(pullRequests.id, input.pullRequestId),
              eq(reviewSnapshots.headSha, pullRequests.headSha),
              eq(reviewSnapshots.baseSha, pullRequests.baseSha),
              eq(workspaceMembers.userId, ctx.auth.userId),
            ),
          )
          .limit(1);
        if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });
        const newSignOff = await tx
          .select({ id: signOffs.id })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(reviewUnits.snapshotId, snapshot.id),
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              gte(signOffs.signedOffAt, snapshot.createdAt),
            ),
          )
          .limit(1);
        if (newSignOff.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Concept grouping is locked after the first sign-off on this revision.",
          });
        }
        const layouts = await tx
          .select()
          .from(reviewConceptLayouts)
          .where(
            and(
              eq(reviewConceptLayouts.snapshotId, snapshot.id),
              or(
                eq(reviewConceptLayouts.userId, ctx.auth.userId),
                isNull(reviewConceptLayouts.userId),
              ),
            ),
          );
        const personal = layouts.find(
          ({ userId }) => userId === ctx.auth.userId,
        );
        const baseline = layouts.find(({ userId }) => userId === null);
        const active = personal ?? baseline;
        if (!active || active.version !== input.expectedVersion) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The review concept layout changed. Reload and try again.",
          });
        }
        if (personal?.lockedAt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Concept grouping is locked after the first sign-off on this revision.",
          });
        }
        const units = await tx
          .select({
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            path: reviewUnits.path,
            changedLineCount: reviewUnits.changedLineCount,
            reviewOrder: reviewUnits.reviewOrder,
          })
          .from(reviewUnits)
          .where(
            and(
              eq(reviewUnits.snapshotId, snapshot.id),
              sql`${reviewUnits.kind} <> 'file'`,
            ),
          );
        const byId = new Map(units.map((unit) => [unit.id, unit]));
        const seen = new Set<string>();
        for (const concept of input.concepts) {
          const members = concept.memberUnitIds.map((id) => {
            const unit = byId.get(id);
            if (!unit) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Unknown review unit ${id}`,
              });
            }
            if (seen.has(id)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "A review unit can appear in only one concept.",
              });
            }
            seen.add(id);
            return unit;
          });
          const files = new Set(members.map(({ path }) => path)).size;
          const changedLines = members.reduce(
            (total, unit) => total + unit.changedLineCount,
            0,
          );
          if (
            members.length > 1 &&
            (files > MAX_CONCEPT_FILES ||
              changedLines > MAX_CONCEPT_CHANGED_LINES)
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Concepts are limited to ${MAX_CONCEPT_FILES} files and ${MAX_CONCEPT_CHANGED_LINES} changed lines.`,
            });
          }
        }
        if (seen.size !== units.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Every atomic review unit must belong to exactly one concept.",
          });
        }
        const nextVersion = active.version + 1;
        let layoutId: string;
        if (personal) {
          const [updated] = await tx
            .update(reviewConceptLayouts)
            .set({ source: input.source, version: nextVersion })
            .where(
              and(
                eq(reviewConceptLayouts.id, personal.id),
                eq(reviewConceptLayouts.version, input.expectedVersion),
                isNull(reviewConceptLayouts.lockedAt),
              ),
            )
            .returning({ id: reviewConceptLayouts.id });
          if (!updated) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "The review concept layout changed. Reload and try again.",
            });
          }
          layoutId = updated.id;
          await tx
            .delete(reviewConcepts)
            .where(eq(reviewConcepts.layoutId, layoutId));
        } else {
          const [created] = await tx
            .insert(reviewConceptLayouts)
            .values({
              snapshotId: snapshot.id,
              userId: ctx.auth.userId,
              source: input.source,
              version: nextVersion,
            })
            .returning({ id: reviewConceptLayouts.id });
          if (!created)
            throw new Error("Personal concept layout was not saved");
          layoutId = created.id;
        }
        const definitions = input.concepts
          .map((concept) => {
            const members = concept.memberUnitIds
              .map((id) => byId.get(id))
              .filter((unit): unit is (typeof units)[number] => Boolean(unit))
              .sort(
                (left, right) =>
                  left.reviewOrder - right.reviewOrder ||
                  left.stableKey.localeCompare(right.stableKey),
              );
            const changedLineCount = members.reduce(
              (total, unit) => total + unit.changedLineCount,
              0,
            );
            return {
              stableKey: `concept:${sha256(
                members
                  .map(({ stableKey }) => stableKey)
                  .sort()
                  .join("\0"),
              )}`,
              title: concept.title,
              rationale: concept.rationale,
              reviewOrder: Math.min(
                ...members.map(({ reviewOrder }) => reviewOrder),
              ),
              changedLineCount,
              fileCount: new Set(members.map(({ path }) => path)).size,
              oversized:
                members.length === 1 &&
                changedLineCount > MAX_CONCEPT_CHANGED_LINES,
              memberUnitIds: members.map(({ id }) => id),
            };
          })
          .sort(
            (left, right) =>
              left.reviewOrder - right.reviewOrder ||
              left.stableKey.localeCompare(right.stableKey),
          );
        const atomicDependencies = await tx
          .select()
          .from(reviewUnitDependencies)
          .where(
            inArray(
              reviewUnitDependencies.unitId,
              units.map(({ id }) => id),
            ),
          );
        const conceptKeyByUnit = new Map(
          definitions.flatMap((definition) =>
            definition.memberUnitIds.map(
              (unitId) => [unitId, definition.stableKey] as const,
            ),
          ),
        );
        const dependencyKeys = new Map<string, Set<string>>();
        for (const dependency of atomicDependencies) {
          const conceptKey = conceptKeyByUnit.get(dependency.unitId);
          const dependencyKey = conceptKeyByUnit.get(dependency.dependencyId);
          if (!conceptKey || !dependencyKey || conceptKey === dependencyKey) {
            continue;
          }
          dependencyKeys.set(
            conceptKey,
            (dependencyKeys.get(conceptKey) ?? new Set()).add(dependencyKey),
          );
        }
        // Grouping can invert the atomic review order, so emit dependencies
        // ahead of their dependents exactly as the deterministic layout does.
        const definitionByKey = new Map(
          definitions.map((definition) => [definition.stableKey, definition]),
        );
        const emitted = new Set<string>();
        const visiting = new Set<string>();
        const ordered: typeof definitions = [];
        /** Emits dependencies before the dependent concept, condensing cycles safely. */
        const visit = (definition: (typeof definitions)[number]) => {
          if (
            emitted.has(definition.stableKey) ||
            visiting.has(definition.stableKey)
          ) {
            return;
          }
          visiting.add(definition.stableKey);
          [...(dependencyKeys.get(definition.stableKey) ?? [])]
            .map((key) => definitionByKey.get(key))
            .filter((value): value is (typeof definitions)[number] =>
              Boolean(value),
            )
            .sort(
              (left, right) =>
                left.reviewOrder - right.reviewOrder ||
                left.stableKey.localeCompare(right.stableKey),
            )
            .forEach(visit);
          visiting.delete(definition.stableKey);
          emitted.add(definition.stableKey);
          ordered.push(definition);
        };
        for (const definition of definitions) visit(definition);
        const createdConcepts = await tx
          .insert(reviewConcepts)
          .values(
            ordered.map((concept, reviewOrder) => ({
              layoutId,
              stableKey: concept.stableKey,
              title: concept.title,
              rationale: concept.rationale,
              reviewOrder,
              changedLineCount: concept.changedLineCount,
              fileCount: concept.fileCount,
              oversized: concept.oversized,
            })),
          )
          .returning({
            id: reviewConcepts.id,
            stableKey: reviewConcepts.stableKey,
          });
        const conceptByKey = new Map(
          createdConcepts.map((concept) => [concept.stableKey, concept]),
        );
        await tx.insert(reviewConceptMembers).values(
          ordered.flatMap((definition) => {
            const concept = conceptByKey.get(definition.stableKey);
            if (!concept) return [];
            return definition.memberUnitIds.map((unitId, memberOrder) => ({
              layoutId,
              conceptId: concept.id,
              unitId,
              snapshotId: snapshot.id,
              memberOrder,
            }));
          }),
        );
        const collapsedDependencies = [...dependencyKeys].flatMap(
          ([conceptKey, dependsOn]) => {
            const concept = conceptByKey.get(conceptKey);
            if (!concept) return [];
            return [...dependsOn].flatMap((key) => {
              const dependency = conceptByKey.get(key);
              return dependency
                ? [
                    {
                      layoutId,
                      conceptId: concept.id,
                      dependencyId: dependency.id,
                    },
                  ]
                : [];
            });
          },
        );
        if (collapsedDependencies.length > 0) {
          await tx
            .insert(reviewConceptDependencies)
            .values(collapsedDependencies);
        }
        return { layoutId, version: nextVersion, source: input.source };
      });
    }),

  signOffConcept: protectedProcedure
    .input(signOffConceptSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const snapshotId = await conceptLayoutSnapshotId(tx, input.layoutId);
        await lockConceptLayoutScope(tx, ctx.auth.userId, snapshotId);
        await assertSnapshotIsCurrent(
          tx,
          snapshotId,
          "Synchronize the pull request before signing off this concept",
        );
        const concept = await conceptMembersForMutation(
          tx,
          ctx.auth.userId,
          input,
        );
        const waiting = await tx
          .select({ unitId: reviewWaits.unitId })
          .from(reviewWaits)
          .where(
            and(
              eq(reviewWaits.userId, ctx.auth.userId),
              inArray(
                reviewWaits.unitId,
                concept.members.map(({ id }) => id),
              ),
            ),
          )
          .limit(1);
        if (waiting.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This concept is waiting for a provider response and cannot be signed off yet.",
          });
        }
        const complexity = concept.members.reduce(
          (total, member) => total + Math.max(1, member.complexity),
          0,
        );
        let allocated = 0;
        const memberInputs = concept.members.map((member, index) => {
          const durationSeconds =
            index === concept.members.length - 1
              ? input.durationSeconds - allocated
              : Math.floor(
                  (input.durationSeconds * Math.max(1, member.complexity)) /
                    complexity,
                );
          allocated += durationSeconds;
          return {
            unitId: member.id,
            sessionId: input.sessionId,
            note: input.note,
            durationSeconds,
          };
        });
        const outcomes = await persistSignOffs(
          tx,
          ctx.auth.userId,
          memberInputs,
        );
        const writes: PersistedSignOff[] = [];
        for (const { unitId } of memberInputs) {
          const outcome = outcomes.get(unitId);
          if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
          if (!outcome.ok) throw signOffFailure(outcome);
          writes.push(outcome.write);
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        await lockConceptLayoutForReviewer(tx, ctx.auth.userId, concept);
        return {
          conceptId: concept.conceptId,
          signedUnitIds: writes.map(({ signOff }) => signOff.unitId),
        };
      }),
    ),

  unreviewConcept: protectedProcedure
    .input(unreviewConceptSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const snapshotId = await conceptLayoutSnapshotId(tx, input.layoutId);
        await lockConceptLayoutScope(tx, ctx.auth.userId, snapshotId);
        await assertSnapshotIsCurrent(
          tx,
          snapshotId,
          "Synchronize the pull request before undoing this concept",
        );
        const concept = await conceptMembersForMutation(
          tx,
          ctx.auth.userId,
          input,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${concept.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const active = await tx
          .select({
            id: signOffs.id,
            unitId: signOffs.unitId,
            signedOffAt: signOffs.signedOffAt,
            durationSeconds: signOffs.durationSeconds,
            complexity: reviewUnits.complexity,
          })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                concept.members.map(({ id }) => id),
              ),
            ),
          );
        if (active.length === 0) return { unreviewed: false, unitIds: [] };
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            inArray(
              signOffs.id,
              active.map(({ id }) => id),
            ),
          );
        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, concept.snapshotId),
            ),
          });
          if (session) {
            const inSession = active.filter(
              ({ signedOffAt }) => signedOffAt >= session.startedAt,
            );
            const experience = inSession.reduce(
              (total, signOff) =>
                total +
                reviewExperience(signOff.complexity, signOff.durationSeconds),
              0,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - ${inSession.length}, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }
        await recomputeReviewStats(tx, ctx.auth.userId);
        return {
          unreviewed: true,
          unitIds: active.map(({ unitId }) => unitId),
        };
      }),
    ),

  signOffFile: protectedProcedure
    .input(reviewFileActionSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const file = await currentSnapshotFileForMember(
          tx,
          ctx.auth.userId,
          input.snapshotFileId,
        );
        if (!file) throw new TRPCError({ code: "NOT_FOUND" });
        const members = await tx.query.reviewUnits.findMany({
          where: and(
            eq(reviewUnits.snapshotFileId, file.id),
            notInArray(reviewUnits.kind, ["file"]),
          ),
          orderBy: [reviewUnits.reviewOrder],
        });
        if (members.length === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This file has no semantic review units to sign off",
          });
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${file.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const waits = await tx
          .select({ unitId: reviewWaits.unitId })
          .from(reviewWaits)
          .where(
            and(
              eq(reviewWaits.userId, ctx.auth.userId),
              inArray(
                reviewWaits.unitId,
                members.map(({ id }) => id),
              ),
            ),
          );
        const active = await tx
          .select({ unitId: signOffs.unitId })
          .from(signOffs)
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                members.map(({ id }) => id),
              ),
            ),
          );
        const skippedIds = new Set([
          ...waits.map(({ unitId }) => unitId),
          ...active.map(({ unitId }) => unitId),
        ]);
        const outstanding = members.filter(
          (member) => !skippedIds.has(member.id),
        );
        if (outstanding.length === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This file has no outstanding review units to sign off",
          });
        }
        const complexity = outstanding.reduce(
          (total, member) => total + Math.max(1, member.complexity),
          0,
        );
        let allocated = 0;
        const memberInputs = outstanding.map((member, index) => {
          const durationSeconds =
            index === outstanding.length - 1
              ? input.durationSeconds - allocated
              : Math.floor(
                  (input.durationSeconds * Math.max(1, member.complexity)) /
                    complexity,
                );
          allocated += durationSeconds;
          return {
            unitId: member.id,
            sessionId: input.sessionId,
            durationSeconds,
          };
        });
        const outcomes = await persistSignOffs(
          tx,
          ctx.auth.userId,
          memberInputs,
        );
        const writes: PersistedSignOff[] = [];
        for (const { unitId } of memberInputs) {
          const outcome = outcomes.get(unitId);
          if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
          if (!outcome.ok) throw signOffFailure(outcome);
          writes.push(outcome.write);
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        return {
          snapshotFileId: file.id,
          signedUnitIds: writes
            .filter((write) => write.added)
            .map(({ signOff }) => signOff.unitId),
        };
      }),
    ),

  unreviewFile: protectedProcedure
    .input(unreviewFileSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const file = await currentSnapshotFileForMember(
          tx,
          ctx.auth.userId,
          input.snapshotFileId,
        );
        if (!file) throw new TRPCError({ code: "NOT_FOUND" });
        const members = await tx
          .select({
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            complexity: reviewUnits.complexity,
          })
          .from(reviewUnits)
          .where(
            and(
              eq(reviewUnits.snapshotFileId, file.id),
              notInArray(reviewUnits.kind, ["file"]),
            ),
          );
        if (members.length === 0) {
          return { snapshotFileId: file.id, unreviewedUnitIds: [] };
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${file.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const active = await tx
          .select({
            unitId: signOffs.unitId,
            signedOffAt: signOffs.signedOffAt,
            durationSeconds: signOffs.durationSeconds,
            complexity: reviewUnits.complexity,
          })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                members.map(({ id }) => id),
              ),
            ),
          );
        if (active.length === 0) {
          return { snapshotFileId: file.id, unreviewedUnitIds: [] };
        }
        const lineage = await tx
          .select({ id: reviewUnits.id })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, file.pullRequestId),
              inArray(
                reviewUnits.stableKey,
                members.map(({ stableKey }) => stableKey),
              ),
            ),
          );
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                lineage.map(({ id }) => id),
              ),
            ),
          );
        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, file.snapshotId),
            ),
          });
          if (session) {
            const inSession = active.filter(
              ({ signedOffAt }) => signedOffAt >= session.startedAt,
            );
            const experience = inSession.reduce(
              (total, signOff) =>
                total +
                reviewExperience(signOff.complexity, signOff.durationSeconds),
              0,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - ${inSession.length}, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }
        await recomputeReviewStats(tx, ctx.auth.userId);
        return {
          snapshotFileId: file.id,
          unreviewedUnitIds: active.map(({ unitId }) => unitId),
        };
      }),
    ),

  signOff: protectedProcedure
    .input(signOffSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const outcome = (
          await persistSignOffs(tx, ctx.auth.userId, [input])
        ).get(input.unitId);
        if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
        if (!outcome.ok) throw signOffFailure(outcome);
        await finalizeSignOffs(tx, ctx.auth.userId, [outcome.write]);
        return outcome.write.signOff;
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
        const outcomes = await persistSignOffs(tx, ctx.auth.userId, ordered);
        for (const { unitId } of ordered) {
          const outcome = outcomes.get(unitId);
          if (!outcome) continue;
          if (outcome.ok) {
            writes.push(outcome.write);
            results.set(unitId, { ok: true, unitId });
            continue;
          }
          results.set(unitId, {
            code: outcome.code,
            // A rejected unit reports the message its own mutation would raise.
            message: outcome.message ?? outcome.code,
            ok: false,
            unitId,
          });
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
        const outcome = (
          await persistUnreviews(tx, ctx.auth.userId, [input])
        ).get(input.unitId);
        if (!outcome?.ok) {
          throw new TRPCError({
            code: outcome?.code ?? "NOT_FOUND",
            message: outcome?.message,
          });
        }
        await finalizeUnreviews(
          tx,
          ctx.auth.userId,
          outcome.unreviewed ? [outcome.write] : [],
        );
        return { unreviewed: outcome.unreviewed };
      }),
    ),

  unreviewBatch: protectedProcedure
    .input(unreviewBatchSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const outcomes = await persistUnreviews(
          tx,
          ctx.auth.userId,
          input.undos,
        );
        await finalizeUnreviews(
          tx,
          ctx.auth.userId,
          [...outcomes.values()].flatMap((outcome) =>
            outcome.ok && outcome.unreviewed ? [outcome.write] : [],
          ),
        );
        return input.undos.map(({ unitId }) => {
          const outcome = outcomes.get(unitId);
          if (!outcome) {
            return {
              code: "NOT_FOUND" as const,
              message: "The review unit could not be returned",
              ok: false as const,
              unitId,
            };
          }
          return outcome.ok
            ? {
                ok: true as const,
                unitId,
                unreviewed: outcome.unreviewed,
              }
            : outcome;
        });
      }),
    ),

  gamification: protectedProcedure.query(async ({ ctx }) => {
    // A reviewer signs the same semantic hash off once per revision, so the
    // distinct triple is the unit of review activity the totals count.
    const reviewEvents = ctx.db
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
      )
      .as("review_events");
    const [user, [totals]] = await Promise.all([
      ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.auth.userId),
      }),
      ctx.db
        .select({
          signOffCount: sql<number>`count(*)`,
          reviewSeconds: sql<number>`coalesce(sum(${reviewEvents.durationSeconds}), 0)`,
        })
        .from(reviewEvents),
    ]);
    return {
      currentStreak: user?.currentStreak ?? 0,
      longestStreak: user?.longestStreak ?? 0,
      experiencePoints: user?.experiencePoints ?? 0,
      totalSignOffs: Number(totals?.signOffCount ?? 0),
      reviewSeconds: Number(totals?.reviewSeconds ?? 0),
    };
  }),
});
