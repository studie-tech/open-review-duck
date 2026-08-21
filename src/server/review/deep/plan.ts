import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  aiJobs,
  aiReviewItems,
  reviewSnapshots,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import { bigPickleSourceDecision } from "~/server/ai/source-policy";
import type { db as database } from "~/server/db";
import { applicableRepositoryRules } from "~/server/repo-reviews/rules";
import { readSourceText } from "~/server/storage/source-blobs";
import type { DeepReviewItemState } from "./coverage";
import { rulebookCorpusDigest } from "./rulebooks";
import {
  type ReviewCandidateFile,
  type ReviewExcludeReason,
  selectReviewFiles,
} from "./selection";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = { query: Database["query"] };
type BlobRow = typeof sourceBlobs.$inferSelect;
type ReviewParentJob = typeof aiJobs.$inferSelect;

/**
 * The per-file source ceiling.
 *
 * A property of the plan rather than of the run, so it is deliberately not
 * `AI_MAX_SOURCE_BYTES` — that bounds the bytes a whole investigation may read,
 * and using it here would admit a single file large enough to exhaust the run
 * on its own.
 */
const DEFAULT_MAX_SOURCE_BYTES = 2 << 20;

/** The parent columns a child job copies instead of re-resolving. */
type ReviewChildJobParent = Pick<
  ReviewParentJob,
  | "id"
  | "workspaceId"
  | "pullRequestId"
  | "snapshotId"
  | "userId"
  | "model"
  | "provider"
  | "agentVersion"
  | "reviewScope"
  | "reviewPurpose"
>;

interface CreateReviewChildJobInput {
  parent: ReviewChildJobParent;
  kind: "review_file" | "review_survey";
  ruleConfigDigest: string;
  /** A caller-chosen id, so an item row can reference the job it creates. */
  id?: string;
}

export interface ReviewItemFingerprintInput {
  workspaceId: string;
  headSha: string;
  path: string;
  currentBlobDigest: string | null;
  previousBlobDigest: string | null;
  ruleConfigDigest: string;
}

interface SealedReviewItem {
  itemId: string;
  path: string;
  changeType: string;
  changedLineCount: number;
  state: DeepReviewItemState;
  /** Null for a waived item: nothing was dispatched for it. */
  childJobId: string | null;
  fingerprint: string;
  reason: string | null;
}

export interface SealedReviewPlan {
  parentJobId: string;
  ruleConfigDigest: string;
  /** `"skipped"` when the sealed plan selected no file at all, else null. */
  terminalState: "skipped" | null;
  items: SealedReviewItem[];
  surveyJobId: string | null;
  itemCount: number;
  selectedCount: number;
  waivedCount: number;
}

export interface SealReviewPlanOptions {
  maxSourceBytes?: number;
  now?: Date;
}

interface PlanFile {
  candidate: ReviewCandidateFile;
  currentBlob: BlobRow | null;
  previousBlob: BlobRow | null;
}

interface WaivedPlanFile {
  file: ReviewCandidateFile;
  reason: ReviewExcludeReason;
}

/**
 * Inserts one deep-review child job inside the caller's transaction.
 *
 * Deliberately not `createAiJob`: that opens its own transaction, takes a
 * database rather than a transaction handle, and runs a full snapshot
 * hydration before it — one per child, against a pool of five. Scope is
 * copied from the parent row and never re-resolved, because `jobScope` picks
 * the newest snapshot by version and a re-sync mid-run would otherwise split
 * one review across two revisions.
 */
async function createReviewChildJob(
  tx: Transaction,
  input: CreateReviewChildJobInput,
) {
  const [job] = await tx
    .insert(aiJobs)
    .values({
      id: input.id ?? randomUUID(),
      workspaceId: input.parent.workspaceId,
      pullRequestId: input.parent.pullRequestId,
      snapshotId: input.parent.snapshotId,
      unitId: null,
      userId: input.parent.userId,
      kind: input.kind,
      parentJobId: input.parent.id,
      ruleConfigDigest: input.ruleConfigDigest,
      reviewScope: input.parent.reviewScope,
      reviewPurpose: input.parent.reviewPurpose,
      agentVersion: input.parent.agentVersion,
      status: "queued",
      model: input.parent.model,
      provider: input.parent.provider,
      // The parent holds the run's only reservation. A child that reserved
      // quota of its own would multiply one review's reservation by the width
      // of the fan-out and strand it if the child never runs.
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      reservedMicroUsd: 0,
    })
    .returning();
  if (!job) throw new Error("Could not create deep review child job");
  return job;
}

/**
 * Derives the reuse key for one file at one revision under one rulebook.
 *
 * `workspaceId` is inside the hash as well as in every lookup predicate that
 * uses it: without it one workspace's findings would be reused into another
 * workspace's run.
 */
export function reviewItemFingerprint(input: ReviewItemFingerprintInput) {
  // Length-prefixed rather than joined by a separator, because a repository
  // path may legally contain any byte including a newline, and two different
  // (path, digest) pairs must never render to the same string.
  const material = [
    input.workspaceId,
    input.headSha,
    input.path,
    input.currentBlobDigest ?? "",
    input.previousBlobDigest ?? "",
    input.ruleConfigDigest,
  ]
    .map((field) => `${field.length}:${field}`)
    .join("");
  return createHash("sha256").update(material).digest("hex");
}

/** Loads the deep-review parent whose plan is being sealed. */
async function readReviewParent(reader: Reader, parentJobId: string) {
  const parent = await reader.query.aiJobs.findFirst({
    where: eq(aiJobs.id, parentJobId),
  });
  if (!parent) throw new Error("Deep review parent job not found");
  if (parent.kind !== "review") {
    throw new Error("Deep review plan requires a review job");
  }
  return parent;
}

/** Orders sealed items widest change first, matching the selection sort. */
function compareSealedItems(left: SealedReviewItem, right: SealedReviewItem) {
  // A waived item has nothing to dispatch, so it sorts behind every selected
  // one however large its change was.
  const waived =
    Number(left.childJobId === null) - Number(right.childJobId === null);
  if (waived !== 0) return waived;
  if (left.changedLineCount !== right.changedLineCount) {
    return right.changedLineCount - left.changedLineCount;
  }
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/** Rebuilds an already-sealed plan so a replayed step seals nothing twice. */
async function readSealedPlan(
  reader: Reader,
  parent: ReviewParentJob,
): Promise<SealedReviewPlan | null> {
  const rows = await reader.query.aiReviewItems.findMany({
    where: eq(aiReviewItems.parentJobId, parent.id),
    orderBy: [asc(aiReviewItems.path)],
  });
  // A sealed plan that selected nothing has no item rows to find it by, so
  // either the terminal state or its survey child proves it ran.
  const skipped = parent.deepReviewTerminalState === "skipped";
  const children = await reader.query.aiJobs.findMany({
    where: eq(aiJobs.parentJobId, parent.id),
  });
  const surveyJobId =
    children.find((child) => child.kind === "review_survey")?.id ?? null;
  if (rows.length === 0 && !skipped && !surveyJobId) return null;
  const items = rows.map((row) => ({
    itemId: row.id,
    path: row.path,
    changeType: row.changeType,
    changedLineCount: row.changedLineCount,
    state: row.state,
    childJobId: row.childJobId,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }));
  items.sort(compareSealedItems);
  return sealedReviewPlan({
    parentJobId: parent.id,
    ruleConfigDigest: parent.ruleConfigDigest ?? rulebookCorpusDigest(),
    skipped,
    items,
    surveyJobId,
  });
}

/** Assembles the plan's counted view, derived only from its item rows. */
function sealedReviewPlan(input: {
  parentJobId: string;
  ruleConfigDigest: string;
  skipped: boolean;
  items: SealedReviewItem[];
  surveyJobId: string | null;
}): SealedReviewPlan {
  // Counted by whether a child was dispatched, not by item state: states move
  // on as the run progresses, and the denominator must not move with them.
  const selectedCount = input.items.filter(
    (item) => item.childJobId !== null,
  ).length;
  return {
    parentJobId: input.parentJobId,
    ruleConfigDigest: input.ruleConfigDigest,
    terminalState: input.skipped ? "skipped" : null,
    items: input.items,
    surveyJobId: input.surveyJobId,
    itemCount: input.items.length,
    selectedCount,
    waivedCount: input.items.length - selectedCount,
  };
}

/**
 * Returns a blob only when its bytes can actually be read.
 *
 * A blob still uploading, or one whose upload failed, is not source: treating
 * it as source would dispatch a scout with nothing to read and record the
 * failure as the file's fault.
 */
function readySourceBlob(blobs: Map<string, BlobRow>, id: string | null) {
  if (!id) return null;
  const blob = blobs.get(id);
  return blob && blob.state === "ready" ? blob : null;
}

/** Loads the snapshot's changed files with the blobs they resolve to. */
async function loadPlanFiles(reader: Reader, snapshotId: string) {
  // Deliberately unlimited: this read is the coverage denominator, so a row
  // left behind here is a file that is neither reviewed nor recorded as
  // waived while the run still reports having covered everything.
  const files = await reader.query.snapshotFiles.findMany({
    where: eq(snapshotFiles.snapshotId, snapshotId),
    orderBy: [asc(snapshotFiles.path)],
  });
  const blobIds = [
    ...new Set(
      files.flatMap((file) =>
        [file.currentBlobId, file.previousBlobId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  const blobs =
    blobIds.length > 0
      ? await reader.query.sourceBlobs.findMany({
          where: inArray(sourceBlobs.id, blobIds),
        })
      : [];
  const byId = new Map(blobs.map((blob) => [blob.id, blob]));
  return files.map<PlanFile>((file) => {
    const currentBlob = readySourceBlob(byId, file.currentBlobId);
    const previousBlob = readySourceBlob(byId, file.previousBlobId);
    return {
      currentBlob,
      previousBlob,
      candidate: {
        path: file.path,
        changeType: file.changeType,
        isBinary: file.isBinary,
        // `snapshot_file` carries no byte count of its own, and a deleted file
        // has no current blob, so it is never oversized.
        sourceBytes: currentBlob?.byteLength ?? 0,
        hasCurrentSource: currentBlob !== null,
        hasPreviousSource: previousBlob !== null,
        changedLineCount: file.additions + file.deletions,
      },
    };
  });
}

/**
 * Returns the source-policy waiver for one selected file, or null.
 *
 * Applied to every provider rather than only the free tier: sealing is the
 * last point at which a file can be refused before a child job exists for it,
 * and a detected secret should not be dispatched anywhere. The scout's read
 * tools re-apply the same decision, so this is the outer of two gates.
 */
async function sourcePolicyReason(
  file: PlanFile,
): Promise<ReviewExcludeReason | null> {
  const blob = file.currentBlob ?? file.previousBlob;
  let source = "";
  if (blob) {
    try {
      source = await readSourceText(blob);
    } catch {
      // Unreadable bytes can be neither cleared for the policy nor reviewed,
      // so the file is reported as the missing source it turned out to be.
      return "no_source";
    }
  }
  const decision = bigPickleSourceDecision(file.candidate.path, source);
  return decision.allowed ? null : decision.reason;
}

/**
 * Freezes the coverage denominator and creates every child job at once.
 *
 * The whole plan is one transaction under one advisory lock, taken before any
 * concurrency exists, so a denominator can never grow while agents are running
 * and a replayed step reseals nothing. Selecting no file is a `skipped` run
 * rather than an error: selection happens in the first durable step, long
 * after the mutation that started the job has returned.
 */
export async function sealReviewPlan(
  db: Database,
  parentJobId: string,
  options: SealReviewPlanOptions = {},
): Promise<SealedReviewPlan> {
  const parent = await readReviewParent(db, parentJobId);
  const alreadySealed = await readSealedPlan(db, parent);
  if (alreadySealed) return alreadySealed;
  const ruleConfigDigest = parent.ruleConfigDigest ?? rulebookCorpusDigest();
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.id, parent.snapshotId),
  });
  if (!snapshot) throw new Error("Deep review snapshot not found");
  const files = await loadPlanFiles(db, parent.snapshotId);
  const byPath = new Map(files.map((file) => [file.candidate.path, file]));
  const complianceRules = parent.reviewRules ?? [];
  const allCandidates = files.map((file) => file.candidate);
  const withoutApplicableRule =
    parent.reviewPurpose === "compliance"
      ? allCandidates.filter(
          (file) =>
            applicableRepositoryRules(complianceRules, file.path, "file")
              .length === 0,
        )
      : [];
  const withoutApplicableRulePaths = new Set(
    withoutApplicableRule.map(({ path }) => path),
  );
  const candidateFiles = allCandidates.filter(
    ({ path }) => !withoutApplicableRulePaths.has(path),
  );
  const selection = selectReviewFiles(candidateFiles, {
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  });
  const waived: WaivedPlanFile[] = [
    ...selection.waived,
    ...withoutApplicableRule.map((file) => ({
      file,
      reason: "no_applicable_rule" as const,
    })),
  ];
  const selected: ReviewCandidateFile[] = [];
  // Read outside the transaction and one file at a time: the source is object
  // storage I/O, which has no business holding a database transaction open,
  // and only the decision is kept so peak memory stays at one file.
  for (const candidate of selection.selected) {
    const file = byPath.get(candidate.path);
    const reason = file ? await sourcePolicyReason(file) : "no_source";
    if (reason) waived.push({ file: candidate, reason });
    else selected.push(candidate);
  }
  const startedAt = options.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`deep-review:plan:${parentJobId}`}))`,
    );
    const current = await readReviewParent(tx, parentJobId);
    const raced = await readSealedPlan(tx, current);
    if (raced) return raced;
    const rows: (typeof aiReviewItems.$inferInsert)[] = [];
    const items: SealedReviewItem[] = [];
    /** Records one item row and the sealed view the caller receives. */
    const addItem = (
      candidate: ReviewCandidateFile,
      childJobId: string | null,
      reason: ReviewExcludeReason | null,
    ) => {
      const file = byPath.get(candidate.path);
      const fingerprint = reviewItemFingerprint({
        workspaceId: current.workspaceId,
        headSha: snapshot.headSha,
        path: candidate.path,
        currentBlobDigest: file?.currentBlob?.digest ?? null,
        previousBlobDigest: file?.previousBlob?.digest ?? null,
        ruleConfigDigest,
      });
      const item: SealedReviewItem = {
        itemId: randomUUID(),
        path: candidate.path,
        changeType: candidate.changeType,
        changedLineCount: candidate.changedLineCount,
        state: childJobId === null ? "waived" : "selected",
        childJobId,
        fingerprint,
        // The reason is stored as its own code, not as a sentence: the run
        // summary and the UI group waivers by it, and a sentence would have
        // to be parsed back into one.
        reason,
      };
      items.push(item);
      rows.push({
        id: item.itemId,
        parentJobId,
        workspaceId: current.workspaceId,
        childJobId,
        path: item.path,
        changeType: item.changeType,
        changedLineCount: item.changedLineCount,
        state: item.state,
        reason: item.reason,
        fingerprint,
      });
    };
    for (const candidate of selected) {
      const child = await createReviewChildJob(tx, {
        parent: current,
        kind: "review_file",
        ruleConfigDigest,
      });
      addItem(candidate, child.id, null);
    }
    for (const entry of waived) addItem(entry.file, null, entry.reason);
    if (rows.length > 0) {
      await tx
        .insert(aiReviewItems)
        .values(rows)
        // Replay is free: the unique index on (parentJobId, path) is what the
        // denominator's identity is, so a second attempt writes nothing.
        .onConflictDoNothing({
          target: [aiReviewItems.parentJobId, aiReviewItems.path],
        });
    }
    const needsSurvey =
      selected.length > 0 ||
      (current.reviewPurpose === "compliance" &&
        (current.reviewRules ?? []).some(
          (rule) => rule.scope === "repository",
        ));
    const survey = needsSurvey
      ? await createReviewChildJob(tx, {
          parent: current,
          kind: "review_survey",
          ruleConfigDigest,
        })
      : undefined;
    await tx
      .update(aiJobs)
      .set({
        // Load-bearing, and written nowhere else on this path: `startAiJob`
        // leaves the parent `waiting_for_provider`, the UI polls only while a
        // job is queued or running, and the wall-clock limit has no anchor to
        // measure from without `startedAt`.
        status: "running",
        startedAt: current.startedAt ?? startedAt,
        progress: 1,
        ruleConfigDigest,
        deepReviewTerminalState: needsSurvey ? null : "skipped",
      })
      .where(eq(aiJobs.id, parentJobId));
    items.sort(compareSealedItems);
    return sealedReviewPlan({
      parentJobId,
      ruleConfigDigest,
      skipped: !needsSurvey,
      items,
      surveyJobId: survey?.id ?? null,
    });
  });
}
