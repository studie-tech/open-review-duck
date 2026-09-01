import {
  reviewConceptDependencies,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
  type snapshotFiles,
} from "@/drizzle/schema";
import {
  clusterReviewConcepts,
  validateConceptPartition,
} from "~/server/analysis/concepts";
import type { AnalyzedUnit, SourceFile } from "~/server/analysis/types";
import type { db as database } from "~/server/db";
import { canCarryReviewWait } from "~/server/review/waiting";
import { persistedUnitSourceRange, previousSourceRange } from "./source-range";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const UNIT_INSERT_BATCH_SIZE = 100;
const DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const CONCEPT_INSERT_BATCH_SIZE = 500;
const CONCEPT_MEMBER_INSERT_BATCH_SIZE = 1_000;
const CONCEPT_DEPENDENCY_INSERT_BATCH_SIZE = 1_000;
const REVIEW_STATE_INSERT_BATCH_SIZE = 500;

interface SnapshotAnalysisStoredFile {
  file: Pick<SourceFile, "content" | "previousContent">;
  currentBlob?: { id: string } | null;
  previousBlob?: { id: string } | null;
}

interface PersistSnapshotAnalysisInput {
  snapshotId: string;
  units: AnalyzedUnit[];
  snapshotFileByPath: ReadonlyMap<string, typeof snapshotFiles.$inferSelect>;
  storedFileByPath: ReadonlyMap<string, SnapshotAnalysisStoredFile>;
  priorByKey: ReadonlyMap<string, typeof reviewUnits.$inferSelect>;
  reviewImpact: ReadonlyMap<string, boolean>;
  signOffsByUnit: ReadonlyMap<
    string,
    readonly (typeof signOffs.$inferSelect)[]
  >;
  waitsByUnit: ReadonlyMap<
    string,
    readonly (typeof reviewWaits.$inferSelect)[]
  >;
  partitionFiles: SourceFile[];
  missingLayoutError: string;
  missingMemberError: (stableKey: string) => string;
}

/** Persists units, concepts, and carried review state for one snapshot. */
export async function persistSnapshotAnalysis(
  tx: Transaction,
  input: PersistSnapshotAnalysisInput,
) {
  const unitValues = input.units.map((unit) => {
    const prior = input.priorByKey.get(unit.stableKey);
    const unchanged =
      prior?.semanticHash === unit.semanticHash &&
      !input.reviewImpact.get(unit.stableKey);
    const snapshotFile = input.snapshotFileByPath.get(unit.path);
    const storedFile = input.storedFileByPath.get(unit.path);
    if (!snapshotFile || !storedFile) {
      throw new Error(`Source object is missing for ${unit.path}`);
    }
    const persistedSource = persistedUnitSourceRange(storedFile.file, unit);
    return {
      snapshotId: input.snapshotId,
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

  const dependencyRows = input.units.flatMap((unit) => {
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

  const reviewableAnalysisUnits = input.units.filter(
    ({ kind }) => kind !== "file",
  );
  const conceptDefinitions = clusterReviewConcepts(reviewableAnalysisUnits);
  validateConceptPartition(
    reviewableAnalysisUnits,
    conceptDefinitions,
    input.partitionFiles,
  );
  const [baselineLayout] = await tx
    .insert(reviewConceptLayouts)
    .values({
      snapshotId: input.snapshotId,
      source: "deterministic",
      version: 1,
    })
    .returning();
  if (!baselineLayout) {
    throw new Error(input.missingLayoutError);
  }
  const conceptRows = conceptDefinitions.map((concept) => ({
    layoutId: baselineLayout.id,
    stableKey: concept.stableKey,
    title: concept.title,
    rationale: concept.rationale,
    reviewOrder: concept.reviewOrder,
    changedLineCount: concept.changedLineCount,
    fileCount: concept.fileCount,
    oversized: concept.oversized,
  }));
  const insertedConcepts: (typeof reviewConcepts.$inferSelect)[] = [];
  for (
    let offset = 0;
    offset < conceptRows.length;
    offset += CONCEPT_INSERT_BATCH_SIZE
  ) {
    insertedConcepts.push(
      ...(await tx
        .insert(reviewConcepts)
        .values(conceptRows.slice(offset, offset + CONCEPT_INSERT_BATCH_SIZE))
        .returning()),
    );
  }
  const insertedConceptByKey = new Map(
    insertedConcepts.map((concept) => [concept.stableKey, concept]),
  );
  const conceptMemberRows = conceptDefinitions.flatMap((concept) => {
    const insertedConcept = insertedConceptByKey.get(concept.stableKey);
    if (!insertedConcept) return [];
    return concept.memberStableKeys.map((stableKey, memberOrder) => {
      const unit = insertedByKey.get(stableKey);
      if (!unit) {
        throw new Error(input.missingMemberError(stableKey));
      }
      return {
        layoutId: baselineLayout.id,
        conceptId: insertedConcept.id,
        unitId: unit.id,
        snapshotId: input.snapshotId,
        memberOrder,
      };
    });
  });
  for (
    let offset = 0;
    offset < conceptMemberRows.length;
    offset += CONCEPT_MEMBER_INSERT_BATCH_SIZE
  ) {
    await tx
      .insert(reviewConceptMembers)
      .values(
        conceptMemberRows.slice(
          offset,
          offset + CONCEPT_MEMBER_INSERT_BATCH_SIZE,
        ),
      );
  }
  const conceptDependencyRows = conceptDefinitions.flatMap((concept) => {
    const insertedConcept = insertedConceptByKey.get(concept.stableKey);
    if (!insertedConcept) return [];
    return concept.dependencies.flatMap((dependencyKey) => {
      const dependency = insertedConceptByKey.get(dependencyKey);
      return dependency
        ? [
            {
              layoutId: baselineLayout.id,
              conceptId: insertedConcept.id,
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
    const prior = input.priorByKey.get(unit.stableKey);
    if (
      prior?.semanticHash !== unit.semanticHash ||
      input.reviewImpact.get(unit.stableKey)
    ) {
      return [];
    }
    return (input.signOffsByUnit.get(prior.id) ?? []).map((signOff) => ({
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
        carriedSignOffs.slice(offset, offset + REVIEW_STATE_INSERT_BATCH_SIZE),
      );
  }

  const carriedWaits = insertedUnits.flatMap((unit) => {
    const prior = input.priorByKey.get(unit.stableKey);
    if (!prior || !canCarryReviewWait(prior.contentHash, unit.contentHash)) {
      return [];
    }
    return (input.waitsByUnit.get(prior.id) ?? []).map((wait) => ({
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

  return insertedUnits;
}
