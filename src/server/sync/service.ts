import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
} from "@/drizzle/schema";
import { env } from "~/env";
import {
  analyzeFiles,
  CURRENT_ANALYSIS_VERSION,
  reconcileSignOffs,
} from "~/server/analysis/engine";
import { type AnalyzedUnit, applySourceBudget } from "~/server/analysis/types";
import type { db as database } from "~/server/db";
import { createProvider } from "~/server/providers";
import { canCarryReviewWait } from "~/server/review/waiting";
import { decryptSecret } from "~/server/security/encryption";
import { pruneExpiredReviewSnapshots } from "./retention";
import { assertCompleteChangedFileSet } from "./revision";

type Database = typeof database;

const UNIT_INSERT_BATCH_SIZE = 100;
const DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const REVIEW_STATE_INSERT_BATCH_SIZE = 500;

/** Synchronizes provider data and review state for one pull request. */
export async function syncPullRequest(
  db: Database,
  repositoryId: string,
  number: number,
) {
  const repository = await db.query.repositories.findFirst({
    where: eq(repositories.id, repositoryId),
  });
  if (!repository) throw new Error("Repository not found");
  const connection = await db.query.providerConnections.findFirst({
    where: eq(providerConnections.id, repository.connectionId),
  });
  if (!connection) throw new Error("Provider connection not found");

  const provider = createProvider(
    connection.provider,
    decryptSecret(connection.encryptedAccessToken, env.ENCRYPTION_KEY),
    connection.baseUrl ?? undefined,
  );
  const observedPullRequest = await db.query.pullRequests.findFirst({
    where: and(
      eq(pullRequests.repositoryId, repositoryId),
      eq(pullRequests.number, number),
    ),
  });
  const [remote, files] = await Promise.all([
    provider.getPullRequest(repository.externalId, number),
    provider.getChangedFiles(repository.externalId, number),
  ]);
  const confirmedRemote = await provider.getPullRequest(
    repository.externalId,
    number,
  );
  if (
    confirmedRemote.headSha !== remote.headSha ||
    confirmedRemote.baseSha !== remote.baseSha
  ) {
    throw new Error(
      "Pull request changed while its files were downloading; synchronize again",
    );
  }
  assertCompleteChangedFileSet(confirmedRemote, files.length);
  const analysis = analyzeFiles(applySourceBudget(files, 20_000_000));
  const changedFileCount = Math.max(confirmedRemote.changedFiles, files.length);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${repositoryId}:${number}`}))`,
    );
    const latestPullRequest = await tx.query.pullRequests.findFirst({
      where: and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, number),
      ),
    });
    const observedRevision = `${observedPullRequest?.headSha ?? ""}:${observedPullRequest?.baseSha ?? ""}`;
    const latestRevision = `${latestPullRequest?.headSha ?? ""}:${latestPullRequest?.baseSha ?? ""}`;
    const fetchedRevision = `${confirmedRemote.headSha}:${confirmedRemote.baseSha}`;
    if (
      latestRevision !== observedRevision &&
      latestRevision !== fetchedRevision
    ) {
      throw new Error(
        "A newer pull request synchronization completed while files were downloading; synchronize again",
      );
    }

    const [pullRequest] = await tx
      .insert(pullRequests)
      .values({
        repositoryId,
        externalId: confirmedRemote.externalId,
        number: confirmedRemote.number,
        title: confirmedRemote.title,
        description: confirmedRemote.description,
        authorLogin: confirmedRemote.authorLogin,
        authorAvatarUrl: confirmedRemote.authorAvatarUrl,
        sourceBranch: confirmedRemote.sourceBranch,
        targetBranch: confirmedRemote.targetBranch,
        headSha: confirmedRemote.headSha,
        baseSha: confirmedRemote.baseSha,
        state: confirmedRemote.state,
        webUrl: confirmedRemote.webUrl,
        additions: confirmedRemote.additions,
        deletions: confirmedRemote.deletions,
        changedFiles: changedFileCount,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [pullRequests.repositoryId, pullRequests.externalId],
        set: {
          number: confirmedRemote.number,
          title: confirmedRemote.title,
          description: confirmedRemote.description,
          authorLogin: confirmedRemote.authorLogin,
          authorAvatarUrl: confirmedRemote.authorAvatarUrl,
          sourceBranch: confirmedRemote.sourceBranch,
          targetBranch: confirmedRemote.targetBranch,
          headSha: confirmedRemote.headSha,
          baseSha: confirmedRemote.baseSha,
          state: confirmedRemote.state,
          webUrl: confirmedRemote.webUrl,
          additions: confirmedRemote.additions,
          deletions: confirmedRemote.deletions,
          changedFiles: changedFileCount,
          lastSyncedAt: new Date(),
        },
      })
      .returning();
    if (!pullRequest) throw new Error("Could not save pull request");
    const currentSnapshot = await tx.query.reviewSnapshots.findFirst({
      where: eq(reviewSnapshots.pullRequestId, pullRequest.id),
      orderBy: [desc(reviewSnapshots.version)],
    });
    const retentionCutoff = new Date(
      Date.now() - repository.sourceRetentionDays * 86_400_000,
    );
    if (
      currentSnapshot?.headSha === confirmedRemote.headSha &&
      currentSnapshot.baseSha === confirmedRemote.baseSha &&
      currentSnapshot.analysisVersion === CURRENT_ANALYSIS_VERSION &&
      currentSnapshot.createdAt >= retentionCutoff
    ) {
      return {
        pullRequest,
        snapshot: currentSnapshot,
        unitCount: analysis.units.filter(({ kind }) => kind !== "file").length,
        changedUnitCount: 0,
        snapshotCreated: false,
        unsupportedFiles: analysis.unsupportedFiles,
      };
    }

    const previousUnits = currentSnapshot
      ? await tx.query.reviewUnits.findMany({
          where: eq(reviewUnits.snapshotId, currentSnapshot.id),
        })
      : [];
    const previousDependencyRows = previousUnits.length
      ? await tx
          .select()
          .from(reviewUnitDependencies)
          .where(
            inArray(
              reviewUnitDependencies.unitId,
              previousUnits.map((unit) => unit.id),
            ),
          )
      : [];
    const previousStableKeyById = new Map(
      previousUnits.map((unit) => [unit.id, unit.stableKey]),
    );
    const previousDependenciesByUnitId = new Map<string, string[]>();
    for (const dependency of previousDependencyRows) {
      const stableKey = previousStableKeyById.get(dependency.dependencyId);
      if (!stableKey) continue;
      previousDependenciesByUnitId.set(dependency.unitId, [
        ...(previousDependenciesByUnitId.get(dependency.unitId) ?? []),
        stableKey,
      ]);
    }
    const previousAnalysisUnits = previousUnits.map(
      (unit): AnalyzedUnit => ({
        stableKey: unit.stableKey,
        path: unit.path,
        language: unit.language as AnalyzedUnit["language"],
        kind: unit.kind,
        name: unit.name,
        signature: unit.signature ?? undefined,
        startLine: unit.startLine,
        endLine: unit.endLine,
        source: unit.source,
        previousSource: unit.previousSource ?? undefined,
        contentHash: unit.contentHash,
        semanticHash: unit.semanticHash,
        changeType: unit.changeType,
        complexity: unit.complexity,
        dependencies: previousDependenciesByUnitId.get(unit.id) ?? [],
        depth: unit.depth,
        reviewOrder: unit.reviewOrder,
      }),
    );
    const reviewImpact = new Map(
      reconcileSignOffs(previousAnalysisUnits, analysis.units).map(
        ({ unit, requiresReview }) => [unit.stableKey, requiresReview],
      ),
    );
    const priorByKey = new Map(
      previousUnits.map((unit) => [unit.stableKey, unit]),
    );
    const priorSignOffs = previousUnits.length
      ? await tx
          .select()
          .from(signOffs)
          .where(
            and(
              inArray(
                signOffs.unitId,
                previousUnits.map((unit) => unit.id),
              ),
              sql`${signOffs.invalidatedAt} is null`,
            ),
          )
      : [];
    const priorWaits = previousUnits.length
      ? await tx
          .select()
          .from(reviewWaits)
          .where(
            inArray(
              reviewWaits.unitId,
              previousUnits.map((unit) => unit.id),
            ),
          )
      : [];
    const signOffsByUnit = new Map<string, typeof priorSignOffs>();
    for (const signOff of priorSignOffs) {
      const collection = signOffsByUnit.get(signOff.unitId) ?? [];
      collection.push(signOff);
      signOffsByUnit.set(signOff.unitId, collection);
    }

    const [snapshot] = await tx
      .insert(reviewSnapshots)
      .values({
        pullRequestId: pullRequest.id,
        headSha: confirmedRemote.headSha,
        baseSha: confirmedRemote.baseSha,
        version: (currentSnapshot?.version ?? 0) + 1,
        analysisVersion: CURRENT_ANALYSIS_VERSION,
      })
      .returning();
    if (!snapshot) throw new Error("Could not create review snapshot");

    const unitValues = analysis.units.map((unit) => {
      const prior = priorByKey.get(unit.stableKey);
      const unchanged =
        prior?.semanticHash === unit.semanticHash &&
        !reviewImpact.get(unit.stableKey);
      return {
        snapshotId: snapshot.id,
        stableKey: unit.stableKey,
        path: unit.path,
        language: unit.language,
        kind: unit.kind,
        name: unit.name,
        signature: unit.signature,
        startLine: unit.startLine,
        endLine: unit.endLine,
        source: unit.source,
        previousSource: unit.previousSource ?? null,
        contentHash: unit.contentHash,
        semanticHash: unit.semanticHash,
        changeType: unit.changeType,
        depth: unit.depth,
        reviewOrder: unit.reviewOrder,
        complexity: unit.complexity,
        requiresReReview: Boolean(prior && !unchanged),
      };
    });
    const insertedUnits: (typeof reviewUnits.$inferSelect)[] = [];
    for (
      let offset = 0;
      offset < unitValues.length;
      offset += UNIT_INSERT_BATCH_SIZE
    ) {
      insertedUnits.push(
        ...(await tx
          .insert(reviewUnits)
          .values(unitValues.slice(offset, offset + UNIT_INSERT_BATCH_SIZE))
          .returning()),
      );
    }
    const insertedByKey = new Map(
      insertedUnits.map((unit) => [unit.stableKey, unit]),
    );

    const dependencyRows = analysis.units.flatMap((unit) => {
      const inserted = insertedByKey.get(unit.stableKey);
      if (!inserted) return [];
      return unit.dependencies.flatMap((dependencyKey) => {
        const dependency = insertedByKey.get(dependencyKey);
        return dependency
          ? [{ unitId: inserted.id, dependencyId: dependency.id }]
          : [];
      });
    });
    for (
      let offset = 0;
      offset < dependencyRows.length;
      offset += DEPENDENCY_INSERT_BATCH_SIZE
    ) {
      await tx
        .insert(reviewUnitDependencies)
        .values(
          dependencyRows.slice(offset, offset + DEPENDENCY_INSERT_BATCH_SIZE),
        );
    }

    const carriedSignOffs = insertedUnits.flatMap((unit) => {
      const prior = priorByKey.get(unit.stableKey);
      if (
        prior?.semanticHash !== unit.semanticHash ||
        reviewImpact.get(unit.stableKey)
      ) {
        return [];
      }
      return (signOffsByUnit.get(prior.id) ?? []).map((signOff) => ({
        unitId: unit.id,
        userId: signOff.userId,
        semanticHash: unit.semanticHash,
        note: signOff.note,
        durationSeconds: signOff.durationSeconds,
        signedOffAt: signOff.signedOffAt,
      }));
    });
    for (
      let offset = 0;
      offset < carriedSignOffs.length;
      offset += REVIEW_STATE_INSERT_BATCH_SIZE
    ) {
      await tx
        .insert(signOffs)
        .values(
          carriedSignOffs.slice(
            offset,
            offset + REVIEW_STATE_INSERT_BATCH_SIZE,
          ),
        );
    }

    const waitsByUnit = new Map<string, typeof priorWaits>();
    for (const wait of priorWaits) {
      waitsByUnit.set(wait.unitId, [
        ...(waitsByUnit.get(wait.unitId) ?? []),
        wait,
      ]);
    }
    const carriedWaits = insertedUnits.flatMap((unit) => {
      const prior = priorByKey.get(unit.stableKey);
      if (!prior || !canCarryReviewWait(prior.contentHash, unit.contentHash)) {
        return [];
      }
      return (waitsByUnit.get(prior.id) ?? []).map((wait) => ({
        unitId: unit.id,
        userId: wait.userId,
        providerThreadIds: wait.providerThreadIds,
        observedCommentIds: wait.observedCommentIds,
        waitingSince: wait.waitingSince,
      }));
    });
    for (
      let offset = 0;
      offset < carriedWaits.length;
      offset += REVIEW_STATE_INSERT_BATCH_SIZE
    ) {
      await tx
        .insert(reviewWaits)
        .values(
          carriedWaits.slice(offset, offset + REVIEW_STATE_INSERT_BATCH_SIZE),
        );
    }

    const reviewableUnits = insertedUnits.filter(({ kind }) => kind !== "file");
    const changedUnitCount = reviewableUnits.filter(
      (unit) => unit.requiresReReview || !priorByKey.has(unit.stableKey),
    ).length;
    return {
      pullRequest,
      snapshot,
      unitCount: reviewableUnits.length,
      changedUnitCount,
      unsupportedFiles: analysis.unsupportedFiles,
      snapshotCreated: true,
    };
  });
  try {
    await pruneExpiredReviewSnapshots(db, repositoryId);
  } catch (cause) {
    console.error("Source-retention cleanup will be retried", {
      name: cause instanceof Error ? cause.name : "UnknownError",
      code:
        typeof cause === "object" && cause && "code" in cause
          ? String(cause.code)
          : undefined,
    });
  }
  return result;
}
