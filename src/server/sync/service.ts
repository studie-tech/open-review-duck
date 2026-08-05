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
  snapshotFiles,
} from "@/drizzle/schema";
import {
  analyzeFiles,
  CURRENT_ANALYSIS_VERSION,
  reconcileSignOffs,
} from "~/server/analysis/engine";
import { languageAdapterForFile } from "~/server/analysis/parsers";
import {
  type TreeSitterLanguage,
  withPreparedTreeSitterLanguages,
} from "~/server/analysis/tree-sitter";
import { type AnalyzedUnit, applySourceBudget } from "~/server/analysis/types";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { providerForConnection } from "~/server/providers/credentials";
import { canCarryReviewWait } from "~/server/review/waiting";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { persistSourceBlob } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "./retention";
import { assertCompleteChangedFileSet } from "./revision";

type Database = typeof database;

const UNIT_INSERT_BATCH_SIZE = 100;
const DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const REVIEW_STATE_INSERT_BATCH_SIZE = 500;
const PULL_REQUEST_SOURCE_BUDGET_BYTES = 20_000_000;

/** Converts an inclusive line range to UTF-8 byte offsets. */
function sourceRange(source: string, startLine: number, endLine: number) {
  const lineCount = source.split("\n").length;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lineCount
  ) {
    throw new Error(
      `Source range ${startLine}-${endLine} is outside a ${lineCount}-line object`,
    );
  }
  const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
  const before = lines.slice(0, Math.max(0, startLine - 1)).join("");
  const selected = lines.slice(Math.max(0, startLine - 1), endLine).join("");
  const startByte = Buffer.byteLength(before);
  return { startByte, endByte: startByte + Buffer.byteLength(selected) };
}

/** Converts an analyzed base-side line range to immutable object byte offsets. */
function previousSourceRange(source: string, unit: AnalyzedUnit) {
  if (unit.previousSource === undefined) return {};
  if (
    unit.previousStartLine === undefined ||
    unit.previousEndLine === undefined
  ) {
    throw new Error(`Previous source range is missing for ${unit.stableKey}`);
  }
  const range = sourceRange(
    source,
    unit.previousStartLine,
    unit.previousEndLine,
  );
  return {
    previousStartByte: range.startByte,
    previousEndByte: range.endByte,
  };
}

/** Maps values with bounded ingestion concurrency and stable result order. */
async function mapWithLimit<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}

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
  const observedPullRequest = await db.query.pullRequests.findFirst({
    where: and(
      eq(pullRequests.repositoryId, repositoryId),
      eq(pullRequests.number, number),
    ),
  });
  const connection = await db.query.providerConnections.findFirst({
    where: eq(providerConnections.id, repository.connectionId),
  });
  if (!connection) throw new Error("Provider connection not found");
  const provider = await providerForConnection(db, connection);
  const [remote, files] = await observeOperation(
    "provider.fetch-pull-request",
    "provider",
    () =>
      Promise.all([
        provider.getPullRequest(repository.externalId, number),
        provider.getChangedFiles(repository.externalId, number, {
          maximumSourceBytes: PULL_REQUEST_SOURCE_BUDGET_BYTES,
        }),
      ]),
  );
  const confirmedRemote = await observeOperation(
    "provider.confirm-revision",
    "provider",
    () => provider.getPullRequest(repository.externalId, number),
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
  const budgetedFiles = applySourceBudget(
    files,
    PULL_REQUEST_SOURCE_BUDGET_BYTES,
  );
  const analysis = await observeOperation(
    "tree-sitter.analyze-pull-request",
    "analysis",
    () =>
      withPreparedTreeSitterLanguages(
        budgetedFiles
          .map((file) => languageAdapterForFile(file)?.language)
          .filter((language): language is TreeSitterLanguage =>
            Boolean(language && language !== "text"),
          ),
        () => analyzeFiles(budgetedFiles),
      ),
  );
  const storedFiles = await mapWithLimit(budgetedFiles, 4, async (file) => {
    const [currentBlob, previousBlob] = await Promise.all([
      persistSourceBlob(db, {
        workspaceId: repository.workspaceId,
        bytes: Buffer.from(file.content),
      }),
      file.previousContent === undefined
        ? undefined
        : persistSourceBlob(db, {
            workspaceId: repository.workspaceId,
            bytes: Buffer.from(file.previousContent),
          }),
    ]);
    return { file, currentBlob, previousBlob };
  });
  const changedFileCount = Math.max(confirmedRemote.changedFiles, files.length);
  const preexistingSnapshot = observedPullRequest
    ? await db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, observedPullRequest.id),
        orderBy: [desc(reviewSnapshots.version)],
      })
    : undefined;
  const preexistingUnits = preexistingSnapshot
    ? await hydrateReviewUnits(
        db,
        await db.query.reviewUnits.findMany({
          where: eq(reviewUnits.snapshotId, preexistingSnapshot.id),
        }),
      )
    : [];

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

    if (currentSnapshot?.id !== preexistingSnapshot?.id) {
      throw new Error(
        "A newer synchronization completed while review state was loading",
      );
    }
    const previousUnits = preexistingUnits;
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
        relatedRanges: unit.relatedRanges ?? undefined,
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

    const snapshotFileRows = await tx
      .insert(snapshotFiles)
      .values(
        storedFiles.map(({ file, currentBlob, previousBlob }) => {
          const representative = analysis.units.find(
            (unit) => unit.path === file.path,
          );
          return {
            snapshotId: snapshot.id,
            path: file.path,
            previousPath: file.previousPath,
            language: representative?.language ?? "text",
            changeType: file.changeType ?? "modified",
            currentBlobId: currentBlob?.id,
            previousBlobId: previousBlob?.id,
            additions:
              file.changeType === "deleted"
                ? 0
                : Math.max(
                    0,
                    file.content.split("\n").length -
                      (file.previousContent?.split("\n").length ?? 0),
                  ),
            deletions:
              file.changeType === "deleted"
                ? file.content.split("\n").length
                : Math.max(
                    0,
                    (file.previousContent?.split("\n").length ?? 0) -
                      file.content.split("\n").length,
                  ),
            isBinary: file.isBinary ?? false,
          };
        }),
      )
      .returning();
    const snapshotFileByPath = new Map(
      snapshotFileRows.map((file) => [file.path, file]),
    );
    const storedFileByPath = new Map(
      storedFiles.map((file) => [file.file.path, file]),
    );

    const unitValues = analysis.units.map((unit) => {
      const prior = priorByKey.get(unit.stableKey);
      const unchanged =
        prior?.semanticHash === unit.semanticHash &&
        !reviewImpact.get(unit.stableKey);
      const snapshotFile = snapshotFileByPath.get(unit.path);
      const storedFile = storedFileByPath.get(unit.path);
      if (!snapshotFile || !storedFile) {
        throw new Error(`Source object is missing for ${unit.path}`);
      }
      return {
        snapshotId: snapshot.id,
        snapshotFileId: snapshotFile.id,
        currentBlobId:
          storedFile.currentBlob?.id ?? storedFile.previousBlob?.id,
        previousBlobId: storedFile.previousBlob?.id,
        stableKey: unit.stableKey,
        path: unit.path,
        language: unit.language,
        kind: unit.kind,
        name: unit.name,
        signature: unit.signature,
        startLine: unit.startLine,
        endLine: unit.endLine,
        ...sourceRange(storedFile.file.content, unit.startLine, unit.endLine),
        ...previousSourceRange(storedFile.file.previousContent ?? "", unit),
        relatedRanges: unit.relatedRanges,
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
