import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  providerConnections,
  pullRequests,
  repositories,
  repositoryBranchMonitors,
  reviewConceptDependencies,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  signOffs,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import {
  clusterReviewConcepts,
  validateConceptPartition,
} from "~/server/analysis/concepts";
import {
  analyzeFiles,
  CURRENT_ANALYSIS_VERSION,
  reconcileSignOffs,
} from "~/server/analysis/engine";
import { sha256 } from "~/server/analysis/hash";
import { languageAdapterForFile } from "~/server/analysis/parsers";
import {
  type TreeSitterLanguage,
  withPreparedTreeSitterLanguages,
} from "~/server/analysis/tree-sitter";
import {
  type AnalyzedUnit,
  isLikelyBinaryFile,
  type SourceFile,
} from "~/server/analysis/types";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import {
  persistSourceBlob,
  readSourceText,
} from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";
import {
  persistedUnitSourceRange,
  previousSourceRange,
} from "~/server/sync/source-range";

type Database = typeof database;

const REPOSITORY_SOURCE_BUDGET_BYTES = 20_000_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_FILE_INSERT_BATCH_SIZE = 500;
const UNIT_INSERT_BATCH_SIZE = 100;
const DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const CONCEPT_INSERT_BATCH_SIZE = 500;
const CONCEPT_MEMBER_INSERT_BATCH_SIZE = 1_000;
const CONCEPT_DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const REVIEW_STATE_INSERT_BATCH_SIZE = 500;

/** Progress values shared with the cockpit's durable synchronization display. */
export const REPOSITORY_SYNC_PROGRESS = {
  fetching: 10,
  downloading: 28,
  analyzing: 55,
  storing: 72,
  saving: 88,
  completed: 100,
} as const;

/** Counts known file changes without inventing diffs for unavailable sources. */
export function repositoryChangedFileCount(files: readonly SourceFile[]) {
  return files.filter(
    (file) =>
      file.changeType !== "modified" ||
      (!file.skipReason &&
        !file.isBinary &&
        (file.previousSourceUnavailable ||
          (file.previousContent !== undefined &&
            file.previousContent !== file.content))),
  ).length;
}

interface PreviousRepositoryFile {
  path: string;
  content?: string;
  isBinary: boolean;
}

/** Loads the current files from the preceding full-tree snapshot. */
async function previousRepositoryFiles(
  db: Database,
  snapshotId: string | undefined,
) {
  if (!snapshotId) return new Map<string, PreviousRepositoryFile>();
  const files = await db.query.snapshotFiles.findMany({
    where: eq(snapshotFiles.snapshotId, snapshotId),
  });
  const currentFiles = files.filter(
    (file) => file.changeType !== "deleted" && file.currentBlobId,
  );
  const blobIds = currentFiles.flatMap((file) =>
    file.currentBlobId ? [file.currentBlobId] : [],
  );
  const blobs = blobIds.length
    ? await db.query.sourceBlobs.findMany({
        where: inArray(sourceBlobs.id, blobIds),
      })
    : [];
  const blobById = new Map(blobs.map((blob) => [blob.id, blob]));
  const loaded = await mapWithLimit(currentFiles, 4, async (file) => {
    const blob = file.currentBlobId
      ? blobById.get(file.currentBlobId)
      : undefined;
    const unavailable = {
      path: file.path,
      content: undefined,
      isBinary: file.isBinary,
    };
    if (file.isBinary || file.skipReason || blob?.state !== "ready") {
      return unavailable;
    }
    try {
      return {
        path: file.path,
        content: await readSourceText(blob),
        isBinary: false,
      };
    } catch {
      return unavailable;
    }
  });
  return new Map(
    loaded.flatMap((file) => (file ? [[file.path, file] as const] : [])),
  );
}

/** Downloads a complete branch tree and attaches its preceding revision. */
export async function downloadRepositoryFiles(
  db: Database,
  input: {
    monitorId: string;
    repositoryExternalId: string;
    ref: string;
    previousSnapshotId?: string;
    onProgress?: (progress: number) => Promise<void>;
  },
  provider: Awaited<ReturnType<typeof providerForConnection>>,
) {
  const [paths, previous] = await Promise.all([
    provider.listRepositoryFiles(input.repositoryExternalId, input.ref),
    previousRepositoryFiles(db, input.previousSnapshotId),
  ]);
  await input.onProgress?.(REPOSITORY_SYNC_PROGRESS.downloading);
  const orderedPaths = [...paths].sort((left, right) =>
    left.localeCompare(right),
  );
  const currentPathSet = new Set(orderedPaths);
  // Each current tree gets the same 20 MB allowance. Comparison may hold the
  // preceding side as well, so its total allowance is twice that rather than
  // silently halving current-tree coverage after the first sync.
  const comparisonBudget = REPOSITORY_SOURCE_BUDGET_BYTES * 2;
  let usedBytes = 0;
  let currentBytes = 0;
  let exhausted = false;
  const current: SourceFile[] = [];
  for (let offset = 0; offset < orderedPaths.length; offset += 4) {
    if (
      exhausted ||
      currentBytes >= REPOSITORY_SOURCE_BUDGET_BYTES ||
      usedBytes >= comparisonBudget
    ) {
      current.push(
        ...orderedPaths.slice(offset).map(
          (path): SourceFile => ({
            path,
            content: "",
            skipReason: "too_large",
            binaryHash: `${input.ref}:${path}`,
            changeType: previous.has(path) ? "modified" : "added",
            reviewWholeFile: true,
          }),
        ),
      );
      break;
    }
    const downloaded = await mapWithLimit(
      orderedPaths.slice(offset, offset + 4),
      4,
      async (path): Promise<SourceFile> => {
        const prior = previous.get(path);
        if (isLikelyBinaryFile(path)) {
          return {
            path,
            content: "",
            isBinary: true,
            binaryHash: `${input.ref}:${path}`,
            changeType: prior ? "modified" : "added",
            reviewWholeFile: true,
          };
        }
        const content = await provider.getFileContent(
          input.repositoryExternalId,
          path,
          input.ref,
          MAX_FILE_BYTES,
        );
        if (content === undefined) {
          return {
            path,
            content: "",
            skipReason: "too_large",
            binaryHash: `${input.ref}:${path}`,
            changeType: prior ? "modified" : "added",
            reviewWholeFile: true,
          };
        }
        if (isLikelyBinaryFile(path, content)) {
          return {
            path,
            content: "",
            isBinary: true,
            binaryHash: `${input.ref}:${path}`,
            changeType: prior ? "modified" : "added",
            reviewWholeFile: true,
          };
        }
        return {
          path,
          content,
          previousContent: prior?.content,
          previousSourceUnavailable: Boolean(
            prior && prior.content === undefined,
          ),
          changeType: prior ? "modified" : "added",
          reviewWholeFile: true,
        };
      },
    );
    for (const file of downloaded) {
      if (file.skipReason || file.isBinary) {
        current.push(file);
        continue;
      }
      if (exhausted) {
        current.push({
          ...file,
          content: "",
          previousContent: undefined,
          skipReason: "too_large",
          binaryHash: `${input.ref}:${file.path}`,
        });
        continue;
      }
      const fileCurrentBytes = Buffer.byteLength(file.content);
      const bytes =
        fileCurrentBytes + Buffer.byteLength(file.previousContent ?? "");
      if (
        currentBytes + fileCurrentBytes > REPOSITORY_SOURCE_BUDGET_BYTES ||
        usedBytes + bytes > comparisonBudget
      ) {
        exhausted = true;
        current.push({
          ...file,
          content: "",
          previousContent: undefined,
          skipReason: "too_large",
          binaryHash: `${input.ref}:${file.path}`,
        });
        continue;
      }
      currentBytes += fileCurrentBytes;
      usedBytes += bytes;
      current.push(file);
    }
  }
  const deleted = [...previous.values()].flatMap((file): SourceFile[] => {
    if (currentPathSet.has(file.path)) return [];
    const bytes =
      file.content === undefined ? 0 : Buffer.byteLength(file.content);
    if (
      file.content !== undefined &&
      !exhausted &&
      !file.isBinary &&
      usedBytes + bytes <= comparisonBudget
    ) {
      usedBytes += bytes;
      return [
        {
          path: file.path,
          content: file.content,
          changeType: "deleted",
          reviewWholeFile: true,
        },
      ];
    }
    return [
      {
        path: file.path,
        content: "",
        isBinary: file.isBinary,
        skipReason: file.isBinary ? undefined : "too_large",
        binaryHash: `deleted:${input.monitorId}:${file.path}`,
        changeType: "deleted",
        reviewWholeFile: true,
      },
    ];
  });
  return [...current, ...deleted];
}

/** Converts persisted units back to the analysis shape used by sign-off carry. */
async function previousAnalysisUnits(
  db: Database,
  units: Array<typeof reviewUnits.$inferSelect>,
) {
  if (units.length === 0) return [];
  const dependencies = await db
    .select()
    .from(reviewUnitDependencies)
    .where(
      inArray(
        reviewUnitDependencies.unitId,
        units.map((unit) => unit.id),
      ),
    );
  const stableKeyById = new Map(units.map((unit) => [unit.id, unit.stableKey]));
  const dependenciesByUnit = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const stableKey = stableKeyById.get(dependency.dependencyId);
    if (!stableKey) continue;
    dependenciesByUnit.set(dependency.unitId, [
      ...(dependenciesByUnit.get(dependency.unitId) ?? []),
      stableKey,
    ]);
  }
  return units.map(
    (unit): AnalyzedUnit => ({
      stableKey: unit.stableKey,
      path: unit.path,
      language: unit.language as AnalyzedUnit["language"],
      kind: unit.kind,
      name: unit.name,
      signature: unit.signature ?? undefined,
      startLine: unit.startLine,
      endLine: unit.endLine,
      source: "",
      previousSource: undefined,
      relatedRanges: unit.relatedRanges ?? undefined,
      contentHash: unit.contentHash,
      semanticHash: unit.semanticHash,
      changeType: unit.changeType,
      complexity: unit.complexity,
      changedLineCount: unit.changedLineCount,
      dependencies: dependenciesByUnit.get(unit.id) ?? [],
      depth: unit.depth,
      reviewOrder: unit.reviewOrder,
    }),
  );
}

/** Synchronizes one monitored branch into a complete immutable review snapshot. */
export async function syncRepositoryBranch(
  db: Database,
  monitorId: string,
  options?: {
    force?: boolean;
    onProgress?: (progress: number) => Promise<void>;
  },
) {
  const [scope] = await db
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
    .where(eq(repositoryBranchMonitors.id, monitorId))
    .limit(1);
  if (!scope) throw new Error("Repository branch monitor not found");
  const provider = await providerForConnection(db, scope.connection);
  const previousSnapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, scope.monitor.pullRequestId),
    orderBy: [desc(reviewSnapshots.version)],
  });
  await options?.onProgress?.(REPOSITORY_SYNC_PROGRESS.fetching);
  const branch = await provider.getBranch(
    scope.repository.externalId,
    scope.monitor.branch,
  );
  if (
    !options?.force &&
    previousSnapshot?.headSha === branch.sha &&
    previousSnapshot.analysisVersion === CURRENT_ANALYSIS_VERSION
  ) {
    await db
      .update(repositoryBranchMonitors)
      .set({ lastCheckedAt: new Date(), lastError: null })
      .where(eq(repositoryBranchMonitors.id, monitorId));
    const units = await db.$count(
      reviewUnits,
      and(
        eq(reviewUnits.snapshotId, previousSnapshot.id),
        sql`${reviewUnits.kind} <> 'file'`,
      ),
    );
    return {
      pullRequestId: scope.monitor.pullRequestId,
      snapshotId: previousSnapshot.id,
      snapshotCreated: false,
      unitCount: units,
      changedUnitCount: 0,
      headSha: branch.sha,
    };
  }

  const files = await downloadRepositoryFiles(
    db,
    {
      monitorId,
      repositoryExternalId: scope.repository.externalId,
      ref: branch.sha,
      previousSnapshotId: previousSnapshot?.id,
      onProgress: options?.onProgress,
    },
    provider,
  );
  const confirmed = await provider.getBranch(
    scope.repository.externalId,
    scope.monitor.branch,
  );
  if (confirmed.sha !== branch.sha) {
    throw new Error(
      "The monitored branch changed while its files were downloading; synchronize again",
    );
  }

  await options?.onProgress?.(REPOSITORY_SYNC_PROGRESS.analyzing);
  const parsedAnalysis = await withPreparedTreeSitterLanguages(
    files
      .map((file) => languageAdapterForFile(file)?.language)
      .filter((language): language is TreeSitterLanguage =>
        Boolean(language && language !== "text"),
      ),
    () => analyzeFiles(files),
  );
  // PR analysis includes change type in semantic identity. A living repository
  // snapshot instead keeps identity stable across its initial "added" capture
  // and later "modified" captures, while still invalidating changed source.
  const analysis = {
    ...parsedAnalysis,
    units: parsedAnalysis.units.map((unit) => ({
      ...unit,
      semanticHash: sha256(
        `${unit.language}\0${unit.kind}\0${unit.signature ?? ""}\0${unit.source}`,
      ),
    })),
  };
  await options?.onProgress?.(REPOSITORY_SYNC_PROGRESS.storing);
  const storedFiles = await mapWithLimit(files, 4, async (file) => {
    const [currentBlob, previousBlob] = await Promise.all([
      persistSourceBlob(db, {
        workspaceId: scope.repository.workspaceId,
        bytes: Buffer.from(file.content),
      }),
      file.previousContent === undefined
        ? undefined
        : persistSourceBlob(db, {
            workspaceId: scope.repository.workspaceId,
            bytes: Buffer.from(file.previousContent),
          }),
    ]);
    return { file, currentBlob, previousBlob };
  });
  const previousUnits = previousSnapshot
    ? await db.query.reviewUnits.findMany({
        where: eq(reviewUnits.snapshotId, previousSnapshot.id),
      })
    : [];
  const priorAnalysis = await previousAnalysisUnits(db, previousUnits);
  const reviewImpact = new Map(
    reconcileSignOffs(priorAnalysis, analysis.units).map(
      ({ unit, requiresReview }) => [unit.stableKey, requiresReview],
    ),
  );
  const priorByKey = new Map(
    previousUnits.map((unit) => [unit.stableKey, unit]),
  );
  const priorSignOffs = previousUnits.length
    ? await db
        .select()
        .from(signOffs)
        .where(
          and(
            inArray(
              signOffs.unitId,
              previousUnits.map((unit) => unit.id),
            ),
            isNull(signOffs.invalidatedAt),
          ),
        )
    : [];
  const signOffsByUnit = new Map<string, typeof priorSignOffs>();
  for (const signOff of priorSignOffs) {
    signOffsByUnit.set(signOff.unitId, [
      ...(signOffsByUnit.get(signOff.unitId) ?? []),
      signOff,
    ]);
  }

  await options?.onProgress?.(REPOSITORY_SYNC_PROGRESS.saving);
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`repository-branch:${monitorId}`}))`,
    );
    const latestMonitor = await tx.query.repositoryBranchMonitors.findFirst({
      where: eq(repositoryBranchMonitors.id, monitorId),
    });
    if (!latestMonitor) throw new Error("Repository branch monitor not found");
    if (
      latestMonitor.currentHeadSha &&
      latestMonitor.currentHeadSha !== scope.monitor.currentHeadSha &&
      latestMonitor.currentHeadSha !== confirmed.sha
    ) {
      throw new Error(
        "A newer repository synchronization completed while files were downloading",
      );
    }
    const currentSnapshot = await tx.query.reviewSnapshots.findFirst({
      where: eq(reviewSnapshots.pullRequestId, latestMonitor.pullRequestId),
      orderBy: [desc(reviewSnapshots.version)],
    });
    if (currentSnapshot?.headSha === confirmed.sha && !options?.force) {
      return {
        pullRequestId: latestMonitor.pullRequestId,
        snapshotId: currentSnapshot.id,
        snapshotCreated: false,
        unitCount: analysis.units.filter(({ kind }) => kind !== "file").length,
        changedUnitCount: 0,
        headSha: confirmed.sha,
      };
    }
    if (currentSnapshot?.id !== previousSnapshot?.id) {
      throw new Error(
        "A newer repository synchronization completed while review state was loading",
      );
    }

    const [pullRequest] = await tx
      .update(pullRequests)
      .set({
        title: `${scope.repository.owner}/${scope.repository.name} · ${scope.monitor.branch}`,
        description: `Monitored repository branch ${scope.monitor.branch}`,
        sourceBranch: scope.monitor.branch,
        targetBranch: scope.monitor.branch,
        headSha: confirmed.sha,
        baseSha: previousSnapshot?.headSha ?? confirmed.sha,
        webUrl: confirmed.webUrl,
        additions: files
          .filter(({ changeType }) => changeType !== "deleted")
          .reduce(
            (total, file) =>
              total +
              Math.max(
                0,
                file.content.split("\n").length -
                  (file.previousContent?.split("\n").length ?? 0),
              ),
            0,
          ),
        deletions: files.reduce(
          (total, file) =>
            total +
            (file.changeType === "deleted"
              ? file.content.split("\n").length
              : Math.max(
                  0,
                  (file.previousContent?.split("\n").length ?? 0) -
                    file.content.split("\n").length,
                )),
          0,
        ),
        changedFiles: repositoryChangedFileCount(files),
        lastSyncedAt: new Date(),
      })
      .where(eq(pullRequests.id, latestMonitor.pullRequestId))
      .returning();
    if (!pullRequest) throw new Error("Repository review subject not found");

    const [snapshot] = await tx
      .insert(reviewSnapshots)
      .values({
        pullRequestId: pullRequest.id,
        headSha: confirmed.sha,
        baseSha: previousSnapshot?.headSha ?? confirmed.sha,
        version: (currentSnapshot?.version ?? 0) + 1,
        analysisVersion: CURRENT_ANALYSIS_VERSION,
      })
      .returning();
    if (!snapshot) throw new Error("Could not create repository snapshot");

    const languageByPath = new Map<string, string>();
    for (const unit of analysis.units) {
      if (!languageByPath.has(unit.path)) {
        languageByPath.set(unit.path, unit.language);
      }
    }
    const snapshotFileValues = storedFiles.map(
      ({ file, currentBlob, previousBlob }) => {
        return {
          snapshotId: snapshot.id,
          path: file.path,
          previousPath: file.previousPath,
          language: languageByPath.get(file.path) ?? "text",
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
          isBinary: Boolean(file.isBinary),
          skipReason: file.skipReason,
        };
      },
    );
    const snapshotFileRows: (typeof snapshotFiles.$inferSelect)[] = [];
    for (
      let offset = 0;
      offset < snapshotFileValues.length;
      offset += SNAPSHOT_FILE_INSERT_BATCH_SIZE
    ) {
      snapshotFileRows.push(
        ...(await tx
          .insert(snapshotFiles)
          .values(
            snapshotFileValues.slice(
              offset,
              offset + SNAPSHOT_FILE_INSERT_BATCH_SIZE,
            ),
          )
          .returning()),
      );
    }
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
      const persistedSource = persistedUnitSourceRange(storedFile.file, unit);
      return {
        snapshotId: snapshot.id,
        snapshotFileId: snapshotFile.id,
        currentBlobId:
          persistedSource.objectSide === "previous"
            ? (storedFile.previousBlob?.id ?? storedFile.currentBlob?.id)
            : (storedFile.currentBlob?.id ?? storedFile.previousBlob?.id),
        previousBlobId: storedFile.previousBlob?.id,
        stableKey: unit.stableKey,
        path: unit.path,
        language: unit.language,
        kind: unit.kind,
        name: unit.name,
        signature: unit.signature,
        startLine: unit.startLine,
        endLine: unit.endLine,
        startByte: persistedSource.startByte,
        endByte: persistedSource.endByte,
        ...previousSourceRange(storedFile.file.previousContent ?? "", unit),
        relatedRanges: unit.relatedRanges,
        contentHash: unit.contentHash,
        semanticHash: unit.semanticHash,
        changeType: unit.changeType,
        depth: unit.depth,
        reviewOrder: unit.reviewOrder,
        complexity: unit.complexity,
        changedLineCount: unit.changedLineCount,
        requiresReReview: Boolean(prior && !unchanged),
      };
    });
    const insertedUnits: Array<typeof reviewUnits.$inferSelect> = [];
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

    const reviewableAnalysisUnits = analysis.units.filter(
      ({ kind }) => kind !== "file",
    );
    const conceptDefinitions = clusterReviewConcepts(reviewableAnalysisUnits);
    validateConceptPartition(
      reviewableAnalysisUnits,
      conceptDefinitions,
      files,
    );
    const [layout] = await tx
      .insert(reviewConceptLayouts)
      .values({ snapshotId: snapshot.id, source: "deterministic", version: 1 })
      .returning();
    if (!layout) throw new Error("Repository review layout was not saved");
    const conceptValues = conceptDefinitions.map((concept) => ({
      layoutId: layout.id,
      stableKey: concept.stableKey,
      title: concept.title,
      rationale: concept.rationale,
      reviewOrder: concept.reviewOrder,
      changedLineCount: concept.changedLineCount,
      fileCount: concept.fileCount,
      oversized: concept.oversized,
    }));
    const insertedConcepts: Array<typeof reviewConcepts.$inferSelect> = [];
    for (
      let offset = 0;
      offset < conceptValues.length;
      offset += CONCEPT_INSERT_BATCH_SIZE
    ) {
      insertedConcepts.push(
        ...(await tx
          .insert(reviewConcepts)
          .values(
            conceptValues.slice(offset, offset + CONCEPT_INSERT_BATCH_SIZE),
          )
          .returning()),
      );
    }
    const conceptByKey = new Map(
      insertedConcepts.map((concept) => [concept.stableKey, concept]),
    );
    const memberRows = conceptDefinitions.flatMap((concept) => {
      const saved = conceptByKey.get(concept.stableKey);
      if (!saved) return [];
      return concept.memberStableKeys.map((stableKey, memberOrder) => {
        const unit = insertedByKey.get(stableKey);
        if (!unit)
          throw new Error(`Repository review unit ${stableKey} was not saved`);
        return {
          layoutId: layout.id,
          conceptId: saved.id,
          unitId: unit.id,
          snapshotId: snapshot.id,
          memberOrder,
        };
      });
    });
    for (
      let offset = 0;
      offset < memberRows.length;
      offset += CONCEPT_MEMBER_INSERT_BATCH_SIZE
    ) {
      await tx
        .insert(reviewConceptMembers)
        .values(
          memberRows.slice(offset, offset + CONCEPT_MEMBER_INSERT_BATCH_SIZE),
        );
    }
    const conceptDependencyRows = conceptDefinitions.flatMap((concept) => {
      const saved = conceptByKey.get(concept.stableKey);
      if (!saved) return [];
      return concept.dependencies.flatMap((dependencyKey) => {
        const dependency = conceptByKey.get(dependencyKey);
        return dependency
          ? [
              {
                layoutId: layout.id,
                conceptId: saved.id,
                dependencyId: dependency.id,
              },
            ]
          : [];
      });
    });
    for (
      let offset = 0;
      offset < conceptDependencyRows.length;
      offset += CONCEPT_DEPENDENCY_INSERT_BATCH_SIZE
    ) {
      await tx
        .insert(reviewConceptDependencies)
        .values(
          conceptDependencyRows.slice(
            offset,
            offset + CONCEPT_DEPENDENCY_INSERT_BATCH_SIZE,
          ),
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
    await tx
      .update(repositoryBranchMonitors)
      .set({
        currentHeadSha: confirmed.sha,
        lastCheckedAt: new Date(),
        lastSyncedAt: new Date(),
        lastError: null,
      })
      .where(eq(repositoryBranchMonitors.id, monitorId));
    const reviewableUnits = insertedUnits.filter(({ kind }) => kind !== "file");
    return {
      pullRequestId: pullRequest.id,
      snapshotId: snapshot.id,
      snapshotCreated: true,
      unitCount: reviewableUnits.length,
      changedUnitCount: reviewableUnits.filter(
        (unit) => unit.requiresReReview || !priorByKey.has(unit.stableKey),
      ).length,
      headSha: confirmed.sha,
    };
  });

  try {
    await pruneExpiredReviewSnapshots(db, scope.repository.id);
  } catch {
    // Retention is maintenance rather than part of a successful branch sync.
  }
  return result;
}
