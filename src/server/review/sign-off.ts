import "server-only";

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewComments,
  reviewConceptDependencies,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewSessions,
  reviewSnapshots,
  reviewUnits,
  reviewWaits,
  signOffs,
  snapshotFiles,
  workspaceMembers,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import { providerSyncErrorMessage } from "~/server/sync/error";
import type { SignOffInput } from "~/validators/review";
import { reviewCompletionCounts } from "./completion";
import { recomputeReviewStats, reviewExperience } from "./experience";
import {
  assignProviderThreadsToUnits,
  providerActivityForUnit,
} from "./waiting";

type ReviewTransaction = Parameters<
  Parameters<(typeof database)["transaction"]>[0]
>[0];

/** Loads one current-revision snapshot file the caller is allowed to act on. */
export async function currentSnapshotFileForMember(
  tx: ReviewTransaction,
  userId: string,
  snapshotFileId: string,
) {
  const [file] = await tx
    .select({
      id: snapshotFiles.id,
      snapshotId: snapshotFiles.snapshotId,
      pullRequestId: pullRequests.id,
    })
    .from(snapshotFiles)
    .innerJoin(
      reviewSnapshots,
      eq(snapshotFiles.snapshotId, reviewSnapshots.id),
    )
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(snapshotFiles.id, snapshotFileId),
        eq(reviewSnapshots.headSha, pullRequests.headSha),
        eq(reviewSnapshots.baseSha, pullRequests.baseSha),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return file;
}

export interface PersistedSignOff {
  added: boolean;
  experience: number;
  input: SignOffInput;
  pullRequestId: string;
  signOff: typeof signOffs.$inferSelect;
  snapshotId: string;
}

type SignOffOutcome =
  | { ok: true; write: PersistedSignOff }
  | { code: "CONFLICT" | "NOT_FOUND"; message?: string; ok: false };

/** Builds a lookup key from an identifier and the revision it belongs to. */
function revisionKey(owner: string, revision: string) {
  return `${owner}:${revision}`;
}

/**
 * Serializes every personal-layout writer for one reviewer on one snapshot.
 * Sign-off can clone a shared baseline into a personal layout, so it has to
 * take the same key that replacePersonalConceptLayout does or the two can race
 * onto the (snapshotId, userId) unique index.
 */
export async function lockConceptLayoutScope(
  tx: ReviewTransaction,
  userId: string,
  snapshotId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`review-concept-layout:${snapshotId}:${userId}`}))`,
  );
}

/** Resolves the snapshot behind one layout before its scope is locked. */
export async function conceptLayoutSnapshotId(
  tx: ReviewTransaction,
  layoutId: string,
) {
  const [layout] = await tx
    .select({ snapshotId: reviewConceptLayouts.snapshotId })
    .from(reviewConceptLayouts)
    .where(eq(reviewConceptLayouts.id, layoutId))
    .limit(1);
  if (!layout) throw new TRPCError({ code: "NOT_FOUND" });
  return layout.snapshotId;
}

/**
 * Rejects a snapshot the pull request has already moved past.
 *
 * Resolving a concept silently requires the same revision, so asking first
 * turns the "no such concept" that a stale workspace would otherwise get into
 * the one instruction that resolves it.
 */
export async function assertSnapshotIsCurrent(
  tx: ReviewTransaction,
  snapshotId: string,
  message: string,
) {
  const [revision] = await tx
    .select({
      snapshotHeadSha: reviewSnapshots.headSha,
      snapshotBaseSha: reviewSnapshots.baseSha,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
    })
    .from(reviewSnapshots)
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .where(eq(reviewSnapshots.id, snapshotId))
    .limit(1);
  if (!revision) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    revision.snapshotHeadSha !== revision.headSha ||
    revision.snapshotBaseSha !== revision.baseSha
  ) {
    throw new TRPCError({ code: "CONFLICT", message });
  }
}

/** Resolves one concept only when it belongs to the reviewer's active layout. */
export async function conceptMembersForMutation(
  tx: ReviewTransaction,
  userId: string,
  input: { conceptId: string; layoutId: string; layoutVersion: number },
) {
  const [candidate] = await tx
    .select({
      conceptId: reviewConcepts.id,
      stableKey: reviewConcepts.stableKey,
      layoutId: reviewConceptLayouts.id,
      layoutVersion: reviewConceptLayouts.version,
      layoutUserId: reviewConceptLayouts.userId,
      layoutSource: reviewConceptLayouts.source,
      lockedAt: reviewConceptLayouts.lockedAt,
      snapshotId: reviewConceptLayouts.snapshotId,
      pullRequestId: pullRequests.id,
    })
    .from(reviewConcepts)
    .innerJoin(
      reviewConceptLayouts,
      eq(reviewConcepts.layoutId, reviewConceptLayouts.id),
    )
    .innerJoin(
      reviewSnapshots,
      eq(reviewConceptLayouts.snapshotId, reviewSnapshots.id),
    )
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(reviewConcepts.id, input.conceptId),
        eq(reviewConceptLayouts.id, input.layoutId),
        eq(workspaceMembers.userId, userId),
        eq(reviewSnapshots.headSha, pullRequests.headSha),
        eq(reviewSnapshots.baseSha, pullRequests.baseSha),
      ),
    )
    .limit(1);
  if (!candidate) throw new TRPCError({ code: "NOT_FOUND" });
  if (candidate.layoutVersion !== input.layoutVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The review concept layout changed. Reload before continuing.",
    });
  }
  const activeLayouts = await tx
    .select({
      id: reviewConceptLayouts.id,
      userId: reviewConceptLayouts.userId,
    })
    .from(reviewConceptLayouts)
    .where(
      and(
        eq(reviewConceptLayouts.snapshotId, candidate.snapshotId),
        or(
          eq(reviewConceptLayouts.userId, userId),
          isNull(reviewConceptLayouts.userId),
        ),
      ),
    );
  const active =
    activeLayouts.find((layout) => layout.userId === userId) ??
    activeLayouts.find((layout) => layout.userId === null);
  let resolved = candidate;
  if (active?.id !== candidate.layoutId) {
    // The first sign-off clones a shared baseline into a personal layout, which
    // re-mints every concept id. Re-resolve the same concept by stable key so a
    // sign-off issued before the client refresh lands still succeeds.
    const [personal] =
      active && candidate.layoutUserId === null
        ? await tx
            .select({
              conceptId: reviewConcepts.id,
              stableKey: reviewConcepts.stableKey,
              layoutId: reviewConceptLayouts.id,
              layoutVersion: reviewConceptLayouts.version,
              layoutUserId: reviewConceptLayouts.userId,
              layoutSource: reviewConceptLayouts.source,
              lockedAt: reviewConceptLayouts.lockedAt,
              snapshotId: reviewConceptLayouts.snapshotId,
            })
            .from(reviewConcepts)
            .innerJoin(
              reviewConceptLayouts,
              eq(reviewConcepts.layoutId, reviewConceptLayouts.id),
            )
            .where(
              and(
                eq(reviewConceptLayouts.id, active.id),
                eq(reviewConceptLayouts.userId, userId),
                eq(reviewConcepts.stableKey, candidate.stableKey),
              ),
            )
            .limit(1)
        : [];
    if (!personal) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A newer personal review concept layout is active. Reload before continuing.",
      });
    }
    resolved = { ...personal, pullRequestId: candidate.pullRequestId };
  }
  const members = await tx
    .select({
      id: reviewUnits.id,
      complexity: reviewUnits.complexity,
      semanticHash: reviewUnits.semanticHash,
      stableKey: reviewUnits.stableKey,
      memberOrder: reviewConceptMembers.memberOrder,
    })
    .from(reviewConceptMembers)
    .innerJoin(reviewUnits, eq(reviewConceptMembers.unitId, reviewUnits.id))
    .where(eq(reviewConceptMembers.conceptId, resolved.conceptId))
    .orderBy(reviewConceptMembers.memberOrder);
  if (members.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This review concept no longer has any members.",
    });
  }
  return { ...resolved, members };
}

/** Permanently locks a reviewer's active layout at their first new sign-off. */
export async function lockConceptLayoutForReviewer(
  tx: ReviewTransaction,
  userId: string,
  concept: Awaited<ReturnType<typeof conceptMembersForMutation>>,
) {
  const lockedAt = new Date();
  if (concept.layoutUserId === userId) {
    if (!concept.lockedAt) {
      await tx
        .update(reviewConceptLayouts)
        .set({ lockedAt })
        .where(eq(reviewConceptLayouts.id, concept.layoutId));
    }
    return;
  }

  // A shared baseline cannot carry per-reviewer lock state. Clone it once so
  // undoing a sign-off never makes grouping editable again for this reviewer.
  const baselineConcepts = await tx.query.reviewConcepts.findMany({
    where: eq(reviewConcepts.layoutId, concept.layoutId),
    orderBy: [reviewConcepts.reviewOrder],
  });
  const baselineConceptIds = baselineConcepts.map(({ id }) => id);
  const [baselineMembers, baselineDependencies] = baselineConceptIds.length
    ? await Promise.all([
        tx
          .select()
          .from(reviewConceptMembers)
          .where(inArray(reviewConceptMembers.conceptId, baselineConceptIds)),
        tx
          .select()
          .from(reviewConceptDependencies)
          .where(
            inArray(reviewConceptDependencies.conceptId, baselineConceptIds),
          ),
      ])
    : [[], []];
  const [personal] = await tx
    .insert(reviewConceptLayouts)
    .values({
      snapshotId: concept.snapshotId,
      userId,
      source: concept.layoutSource,
      version: concept.layoutVersion,
      lockedAt,
    })
    .returning({ id: reviewConceptLayouts.id });
  if (!personal)
    throw new Error("The review concept layout could not be locked");
  const copiedConcepts = await tx
    .insert(reviewConcepts)
    .values(
      baselineConcepts.map((item) => ({
        layoutId: personal.id,
        stableKey: item.stableKey,
        title: item.title,
        rationale: item.rationale,
        reviewOrder: item.reviewOrder,
        changedLineCount: item.changedLineCount,
        fileCount: item.fileCount,
        oversized: item.oversized,
      })),
    )
    .returning({ id: reviewConcepts.id, stableKey: reviewConcepts.stableKey });
  const copiedIdByStableKey = new Map(
    copiedConcepts.map((item) => [item.stableKey, item.id]),
  );
  const baselineById = new Map(baselineConcepts.map((item) => [item.id, item]));
  const copiedIdByBaselineId = new Map(
    baselineConcepts.flatMap((item) => {
      const copiedId = copiedIdByStableKey.get(item.stableKey);
      return copiedId ? [[item.id, copiedId] as const] : [];
    }),
  );
  if (baselineMembers.length > 0) {
    await tx.insert(reviewConceptMembers).values(
      baselineMembers.flatMap((member) => {
        const conceptId = copiedIdByBaselineId.get(member.conceptId);
        return conceptId
          ? [
              {
                layoutId: personal.id,
                conceptId,
                unitId: member.unitId,
                snapshotId: concept.snapshotId,
                memberOrder: member.memberOrder,
              },
            ]
          : [];
      }),
    );
  }
  if (baselineDependencies.length > 0) {
    await tx.insert(reviewConceptDependencies).values(
      baselineDependencies.flatMap((dependency) => {
        const conceptId = copiedIdByBaselineId.get(dependency.conceptId);
        const dependencyId = copiedIdByBaselineId.get(dependency.dependencyId);
        return conceptId && dependencyId
          ? [{ layoutId: personal.id, conceptId, dependencyId }]
          : [];
      }),
    );
  }
  // Retain this check as an internal invariant and keep the copied map useful
  // when a malformed baseline is encountered inside the transaction.
  if (baselineById.size !== copiedIdByBaselineId.size) {
    throw new Error("The review concept layout could not be copied completely");
  }
}

/**
 * Persists authorized sign-offs in set-at-a-time steps so a batch or concept
 * holds its advisory locks for a fixed number of round trips.
 */
export async function persistSignOffs(
  tx: ReviewTransaction,
  userId: string,
  inputs: SignOffInput[],
): Promise<Map<string, SignOffOutcome>> {
  const outcomes = new Map<string, SignOffOutcome>();
  if (inputs.length === 0) return outcomes;
  const requestedUnits = await tx
    .select({
      id: reviewUnits.id,
      stableKey: reviewUnits.stableKey,
      semanticHash: reviewUnits.semanticHash,
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
        inArray(reviewUnits.id, [
          ...new Set(inputs.map(({ unitId }) => unitId)),
        ]),
        eq(workspaceMembers.userId, userId),
      ),
    );
  const requestedById = new Map(requestedUnits.map((unit) => [unit.id, unit]));

  const revisionScopes = new Map<
    string,
    { headSha: string; baseSha: string; stableKeys: Set<string> }
  >();
  for (const unit of requestedUnits) {
    const scope = revisionScopes.get(unit.pullRequestId) ?? {
      headSha: unit.currentHeadSha,
      baseSha: unit.currentBaseSha,
      stableKeys: new Set<string>(),
    };
    scope.stableKeys.add(unit.stableKey);
    revisionScopes.set(unit.pullRequestId, scope);
  }
  // Serialize this reviewer's sign-off writes per pull request. Sorting the
  // keys gives every caller the same acquisition order, so two batches that
  // overlap on two pull requests cannot deadlock against each other.
  for (const pullRequestId of [...revisionScopes.keys()].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${pullRequestId}:${userId}`}))`,
    );
  }

  const revisionFilters = [...revisionScopes].map(([pullRequestId, scope]) =>
    and(
      eq(reviewSnapshots.pullRequestId, pullRequestId),
      eq(reviewSnapshots.headSha, scope.headSha),
      eq(reviewSnapshots.baseSha, scope.baseSha),
      inArray(reviewUnits.stableKey, [...scope.stableKeys]),
    ),
  );
  // Only the highest snapshot version still describing the pull request's
  // current revision may receive a sign-off.
  const latestRevisions = revisionFilters.length
    ? await tx
        .selectDistinctOn(
          [reviewSnapshots.pullRequestId, reviewUnits.stableKey],
          {
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            semanticHash: reviewUnits.semanticHash,
            complexity: reviewUnits.complexity,
            snapshotId: reviewUnits.snapshotId,
            pullRequestId: reviewSnapshots.pullRequestId,
          },
        )
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .where(or(...revisionFilters))
        .orderBy(
          reviewSnapshots.pullRequestId,
          reviewUnits.stableKey,
          desc(reviewSnapshots.version),
        )
    : [];
  const latestByStableKey = new Map(
    latestRevisions.map((unit) => [
      revisionKey(unit.pullRequestId, unit.stableKey),
      unit,
    ]),
  );

  interface ResolvedSignOff {
    input: SignOffInput;
    pullRequestId: string;
    unit: (typeof latestRevisions)[number];
  }
  const resolved: ResolvedSignOff[] = [];
  for (const input of inputs) {
    const requested = requestedById.get(input.unitId);
    if (!requested) {
      outcomes.set(input.unitId, { code: "NOT_FOUND", ok: false });
      continue;
    }
    const unit = latestByStableKey.get(
      revisionKey(requested.pullRequestId, requested.stableKey),
    );
    if (!unit || unit.semanticHash !== requested.semanticHash) {
      outcomes.set(input.unitId, {
        code: "CONFLICT",
        message: "This review unit changed in the latest revision",
        ok: false,
      });
      continue;
    }
    resolved.push({ input, pullRequestId: requested.pullRequestId, unit });
  }
  if (resolved.length === 0) return outcomes;

  const targetUnitIds = [...new Set(resolved.map(({ unit }) => unit.id))];
  // Every writer of these rows takes the pull-request lock above first, so no
  // other transaction can hold one of these unit locks in a conflicting order.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(key)) from unnest(array[${sql.join(
      targetUnitIds.map((unitId) => sql`${`${unitId}:${userId}`}`),
      sql`, `,
    )}]::text[]) as locks(key)`,
  );
  const activeSignOffs = await tx
    .select()
    .from(signOffs)
    .where(
      and(
        eq(signOffs.userId, userId),
        inArray(signOffs.unitId, targetUnitIds),
        isNull(signOffs.invalidatedAt),
      ),
    );
  const activeByRevision = new Map<string, (typeof activeSignOffs)[number]>();
  for (const signOff of activeSignOffs) {
    const key = revisionKey(signOff.unitId, signOff.semanticHash);
    if (!activeByRevision.has(key)) activeByRevision.set(key, signOff);
  }

  // One insert per unit, credited to the first request that reached it, so a
  // set naming two revisions of one unit behaves as it did one at a time.
  const claimants = new Map<string, SignOffInput>();
  const pendingInserts: ResolvedSignOff[] = [];
  for (const entry of resolved) {
    const key = revisionKey(entry.unit.id, entry.unit.semanticHash);
    if (activeByRevision.has(key) || claimants.has(entry.unit.id)) continue;
    claimants.set(entry.unit.id, entry.input);
    pendingInserts.push(entry);
  }
  const insertedByUnit = new Map<string, (typeof activeSignOffs)[number]>();
  if (pendingInserts.length > 0) {
    await tx
      .update(signOffs)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          inArray(
            signOffs.unitId,
            pendingInserts.map(({ unit }) => unit.id),
          ),
          eq(signOffs.userId, userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    const written = await tx
      .insert(signOffs)
      .values(
        pendingInserts.map(({ input, unit }) => ({
          unitId: unit.id,
          userId,
          semanticHash: unit.semanticHash,
          note: input.note,
          durationSeconds: input.durationSeconds,
        })),
      )
      .returning();
    for (const signOff of written) insertedByUnit.set(signOff.unitId, signOff);
  }

  for (const entry of resolved) {
    const existing = activeByRevision.get(
      revisionKey(entry.unit.id, entry.unit.semanticHash),
    );
    const signOff = existing ?? insertedByUnit.get(entry.unit.id);
    if (!signOff) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The sign-off could not be saved",
      });
    }
    outcomes.set(entry.input.unitId, {
      ok: true,
      write: {
        added: !existing && claimants.get(entry.unit.id) === entry.input,
        experience: reviewExperience(
          entry.unit.complexity,
          entry.input.durationSeconds,
        ),
        input: entry.input,
        pullRequestId: entry.pullRequestId,
        signOff,
        snapshotId: entry.unit.snapshotId,
      },
    });
  }
  return outcomes;
}

/** Reports one rejected sign-off exactly as the single-unit mutation always has. */
export function signOffFailure(outcome: SignOffOutcome & { ok: false }) {
  return new TRPCError({ code: outcome.code, message: outcome.message });
}

/** Applies aggregate user and review-session updates once per sign-off request. */
export async function finalizeSignOffs(
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
    const existing = sessionGroups.get(key);
    if (existing) existing.push(write);
    else sessionGroups.set(key, [write]);
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

/**
 * Records one reviewer's wait on every named unit of a single snapshot.
 *
 * Each wait watches that unit's own conversation. A unit with no thread of
 * its own cannot be paused, because there is nothing for a later poll to
 * notice having moved.
 */
export async function beginReviewWaits(
  db: typeof database,
  userId: string,
  requested: string[],
) {
  const unitIds = [...new Set(requested)];
  const scopes = await db
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
      connection: providerConnections,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
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
        inArray(reviewUnits.id, unitIds),
        eq(workspaceMembers.userId, userId),
      ),
    );
  const units = [
    ...new Map(scopes.map((scope) => [scope.unitId, scope])).values(),
  ];
  const [scope] = units;
  if (!scope || units.length !== unitIds.length) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if (
    scope.snapshotHeadSha !== scope.headSha ||
    scope.snapshotBaseSha !== scope.baseSha
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Synchronize the pull request before waiting for a response",
    });
  }
  if (!scope.connection) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Local comments do not have provider response threads",
    });
  }
  const provider = await providerForConnection(db, scope.connection);
  let threads: Awaited<ReturnType<typeof provider.listInlineCommentThreads>>;
  try {
    threads = await provider.listInlineCommentThreads(
      scope.repositoryExternalId,
      scope.pullRequestNumber,
    );
  } catch (cause) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: providerSyncErrorMessage(scope.connection.provider, cause),
      cause,
    });
  }
  const allSnapshotUnits = await db
    .select({
      id: reviewUnits.id,
      path: reviewUnits.path,
      kind: reviewUnits.kind,
      startLine: reviewUnits.startLine,
      endLine: reviewUnits.endLine,
    })
    .from(reviewUnits)
    .where(eq(reviewUnits.snapshotId, scope.snapshotId));
  const snapshotUnits = allSnapshotUnits.filter(({ kind }) => kind !== "file");
  const localComments = await db
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
  const waited = units.map((unit) => ({
    unit,
    activity: providerActivityForUnit(
      assignedThreads.filter((thread) => thread.unitId === unit.unitId),
      unit,
    ),
  }));
  if (waited.every(({ activity }) => activity.providerThreadIds.length === 0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This unit needs a live provider conversation before it can await a response",
    });
  }

  return db.transaction(async (tx) => {
    // Sorted, because two reviewers pausing overlapping sets would otherwise
    // take the same per-unit locks in opposite orders and deadlock.
    for (const unitId of [...unitIds].sort()) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${unitId}:${userId}:wait`}))`,
      );
    }
    await tx
      .update(signOffs)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          inArray(
            signOffs.unitId,
            units.map(({ unitId }) => unitId),
          ),
          eq(signOffs.userId, userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    const waitingSince = new Date();
    const written: (typeof reviewWaits.$inferSelect)[] = [];
    for (const { unit, activity } of waited) {
      const [wait] = await tx
        .insert(reviewWaits)
        .values({
          unitId: unit.unitId,
          userId,
          providerThreadIds: activity.providerThreadIds,
          observedCommentIds: activity.observedCommentIds,
          waitingSince,
        })
        .onConflictDoUpdate({
          target: [reviewWaits.unitId, reviewWaits.userId],
          set: {
            providerThreadIds: activity.providerThreadIds,
            observedCommentIds: activity.observedCommentIds,
            waitingSince,
          },
        })
        .returning();
      if (!wait) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The waiting state could not be saved",
        });
      }
      written.push(wait);
    }
    return written;
  });
}
