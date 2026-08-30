import "server-only";

import { generateText } from "ai";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  aiJobs,
  aiReviewFindingEvidence,
  aiReviewFindings,
  type aiReviewItems,
} from "@/drizzle/schema";
import { env } from "~/env";
import { mapWithLimit } from "~/lib/concurrency";
import { resolveAiModel } from "~/server/ai/models";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import {
  type AnchorRange,
  type AnchorResult,
  type AnchorSide,
  type AnchorTier,
  anchorIsGrounded,
  anchorIsInScope,
  resolveAnchor,
} from "./anchor";
import { sanitizeReason } from "./redaction";
import {
  applyRefuteVerdicts,
  type RefuteVerdict,
  type RefuteVote,
} from "./refute-policy";
import {
  DEEP_REVIEW_REFUTE_SYSTEM_PROMPT,
  DEEP_REVIEW_RELOCATE_SYSTEM_PROMPT,
  type DeepReviewPromptBodies,
  refuteUserPrompt,
  relocateUserPrompt,
} from "./review-prompts";

type Database = typeof database;

/**
 * The cost guard a caller may impose on relocation, shared across one run.
 *
 * §6.6 argues against capping at all — a run-wide cap silently degrades the
 * late findings of a large pull request while the early ones get the full
 * treatment — so `validateFileFindings` relocates without limit unless a
 * budget is passed in. The constant exists for callers that want the guard.
 */
const DEEP_REVIEW_RELOCATION_LIMIT = env.DEEP_REVIEW_RELOCATION_LIMIT;

const RELOCATION_CONCURRENCY = 4;
const MAX_RELOCATE_OUTPUT_TOKENS = 1_024;
const MAX_REFUTE_OUTPUT_TOKENS = 4_096;
const VALIDATION_TIMEOUT_MS = 120_000;
const MAX_VERDICT_REASON_LENGTH = 1_000;

/** The states validation can settle a reported finding into. */
type DeepReviewFindingState =
  | "anchored"
  | "unanchored"
  | "out_of_scope"
  | "ungrounded"
  | "refuted";

export interface DeepReviewRelocationBudget {
  remaining: number;
}

/** The unit fields anchoring needs, so validation never loads a whole unit. */
export interface DeepReviewValidationUnit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * One `ai_job_evidence` row, carrying the blob it was read from.
 *
 * `sourceBlobId` is not optional here: the table has no side column, so it is
 * the only thing that keeps a current-revision read from grounding a
 * previous-revision anchor.
 */
export interface DeepReviewValidationEvidence {
  id: string;
  sourceBlobId: string;
  startLine: number;
  endLine: number;
}

export interface DeepReviewValidationModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

export interface DeepReviewValidationModel {
  generate(request: DeepReviewValidationModelRequest): Promise<string>;
}

export interface ValidateFileFindingsInput {
  item: Pick<typeof aiReviewItems.$inferSelect, "id" | "path">;
  job: Pick<typeof aiJobs.$inferSelect, "id" | "workspaceId">;
  currentSource: string | null;
  previousSource: string | null;
  /** Changed line ranges on the current revision. */
  changedRanges: readonly AnchorRange[];
  /** Changed line ranges on the previous revision, when the caller has them. */
  previousChangedRanges?: readonly AnchorRange[];
  units: readonly DeepReviewValidationUnit[];
  evidence: readonly DeepReviewValidationEvidence[];
  currentBlobId?: string | null;
  previousBlobId?: string | null;
  snapshotPaths: readonly string[];
  /** Absent disables relocation and refutation; both then fail open. */
  model?: DeepReviewValidationModel;
  relocationBudget?: DeepReviewRelocationBudget;
  promptBodies?: DeepReviewPromptBodies;
  relocateSystemPrompt?: string;
  refuteSystemPrompt?: string;
}

interface DeepReviewValidatedFinding {
  id: string;
  state: DeepReviewFindingState;
  verdict: RefuteVerdict;
  verdictReason: string | null;
  anchorTier: AnchorTier;
  anchorSide: AnchorSide | null;
  startLine: number | null;
  endLine: number | null;
  anchorAmbiguous: boolean;
  unitId: string | null;
  relocated: boolean;
}

export interface DeepReviewValidationResult {
  findings: DeepReviewValidatedFinding[];
  relocationsAttempted: number;
  relocationsResolved: number;
  /** False whenever the refuter failed open and every verdict stayed unverified. */
  refutationApplied: boolean;
}

interface FindingContent {
  title: string;
  body: string;
  existingCode: string;
  suggestionCode?: string;
}

interface LoadedFinding {
  id: string;
  content: FindingContent | null;
}

/** One finding's first anchoring attempt, held while relocation runs. */
interface PreparedFinding {
  id: string;
  /** Null for a payload that could not be read, which never anchors. */
  content: FindingContent | null;
  anchor: AnchorResult;
}

interface RelocatableFinding {
  id: string;
  content: FindingContent;
}

/** Creates the optional run-wide relocation guard, defaulting to §6.6's cap. */
export function createRelocationBudget(
  limit: number = DEEP_REVIEW_RELOCATION_LIMIT,
): DeepReviewRelocationBudget {
  return {
    remaining: Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0,
  };
}

/** Reads a sealed finding payload, tolerating anything that is not our shape. */
function parseFindingContent(payload: string): FindingContent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const existingCode =
      typeof record.existingCode === "string" ? record.existingCode : "";
    return {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      existingCode,
      suggestionCode:
        typeof record.suggestionCode === "string"
          ? record.suggestionCode
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Joins a finding's title and body into the one text the judges are shown. */
function findingText(content: FindingContent): string {
  return content.body ? `${content.title}\n\n${content.body}` : content.title;
}

/** Extracts the first fenced code block from a model response. */
export function extractCodeBlock(text: string): string {
  const trimmed = text.trim();
  const open = trimmed.indexOf("```");
  if (open < 0) return "";
  const newline = trimmed.indexOf("\n", open + 3);
  if (newline < 0) return "";
  const body = trimmed.slice(newline + 1);
  const close = body.indexOf("```");
  if (close < 0) return "";
  return body.slice(0, close).trim();
}

/** Strips a fence the refuter added despite being told to answer bare JSON. */
function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return extractCodeBlock(trimmed);
}

/**
 * Reads the refuter's votes, returning null for anything it cannot understand.
 *
 * Null is the fail-open signal: `applyRefuteVerdicts` over an empty vote list
 * leaves every finding unverified, which is exactly what an unusable response
 * must do.
 */
export function parseRefuteVotes(text: string): RefuteVote[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const votes = (parsed as Record<string, unknown>).votes;
  if (!Array.isArray(votes)) return null;
  const collected: RefuteVote[] = [];
  for (const entry of votes) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    // Only the literal string "refuted" discards a finding. Every other value,
    // including a missing or misspelled verdict, reads as the answer that keeps
    // it, so a malformed vote can never cost a finding its place.
    const verdict = record.verdict === "refuted" ? "refuted" : "not_refuted";
    collected.push({
      id: record.id,
      verdict,
      refutation:
        typeof record.refutation === "string" ? record.refutation : undefined,
      evidencePath:
        typeof record.evidencePath === "string"
          ? record.evidencePath
          : undefined,
      evidenceLine:
        typeof record.evidenceLine === "number"
          ? record.evidenceLine
          : undefined,
    });
  }
  return collected;
}

/** Narrows the units that can hold a current-side anchor for this file. */
function unitsForPath(
  units: readonly DeepReviewValidationUnit[],
  path: string,
): DeepReviewValidationUnit[] {
  return units.filter((unit) => unit.path === path);
}

/** Returns the innermost unit fully containing a resolved current-side span. */
function unitForAnchor(
  anchor: AnchorResult,
  units: readonly DeepReviewValidationUnit[],
): string | null {
  if (anchor.side !== "current") return null;
  if (anchor.startLine === null || anchor.endLine === null) return null;
  const start = anchor.startLine;
  const end = anchor.endLine;
  const containing = units.filter(
    (unit) => unit.startLine <= start && unit.endLine >= end,
  );
  if (containing.length === 0) return null;
  return containing.reduce((best, unit) =>
    unit.endLine - unit.startLine < best.endLine - best.startLine ? unit : best,
  ).id;
}

/** Reports whether an anchor resolved to a real, usable line span. */
function isLocated(anchor: AnchorResult): boolean {
  return anchor.startLine !== null && anchor.endLine !== null;
}

/** Builds the terminal record for a finding that never resolved to a line. */
function unanchoredFinding(
  id: string,
  anchor: AnchorResult,
  relocated: boolean,
): DeepReviewValidatedFinding {
  return {
    id,
    state: "unanchored",
    verdict: "unverified",
    verdictReason: null,
    anchorTier: anchor.tier,
    anchorSide: null,
    startLine: null,
    endLine: null,
    anchorAmbiguous: anchor.ambiguous,
    unitId: null,
    relocated,
  };
}

/**
 * Runs anchoring, both gates and refutation over one file's new findings.
 *
 * Nothing is ever deleted: every finding keeps its row and leaves with a
 * state. The gates fail closed because a comment on the wrong line is worse
 * than a comment in the file-level bucket, and the refuter fails open because
 * its output is the only thing in the pipeline that discards a finding.
 */
export async function validateFileFindings(
  db: Database,
  input: ValidateFileFindingsInput,
): Promise<DeepReviewValidationResult> {
  const loaded = await loadSubmittedFindings(db, input);
  const result: DeepReviewValidationResult = {
    findings: [],
    relocationsAttempted: 0,
    relocationsResolved: 0,
    refutationApplied: false,
  };
  if (loaded.length === 0) return result;

  const pathUnits = unitsForPath(input.units, input.item.path);
  const unitRanges = pathUnits.map((unit) => ({
    startLine: unit.startLine,
    endLine: unit.endLine,
  }));
  // Proximity is only a tiebreak, so every range the agent read is a usable
  // hint here; the side partition that matters is enforced by the gate below.
  const evidenceRanges = input.evidence.map((row) => ({
    startLine: row.startLine,
    endLine: row.endLine,
  }));
  const anchorable = {
    currentSource: input.currentSource,
    previousSource: input.previousSource,
    changedRanges: input.changedRanges,
    unitRanges,
    evidenceRanges,
  };

  const groundedLinks: (typeof aiReviewFindingEvidence.$inferInsert)[] = [];
  const refutable: {
    id: string;
    content: string;
    existingCode: string;
    finding: DeepReviewValidatedFinding;
  }[] = [];
  const resealed = new Map<string, string>();
  const prepared: PreparedFinding[] = [];
  const missed: RelocatableFinding[] = [];

  for (const finding of loaded) {
    const content = finding.content;
    if (!content || content.existingCode.trim() === "") {
      // A finding whose sealed payload we cannot read has no snippet to match,
      // and inventing a line for it is precisely what the gates exist to stop.
      prepared.push({
        id: finding.id,
        content: null,
        anchor: {
          tier: "none",
          side: null,
          startLine: null,
          endLine: null,
          ambiguous: false,
        },
      });
      continue;
    }
    const anchor = resolveAnchor({
      ...anchorable,
      existingCode: content.existingCode,
    });
    prepared.push({ id: finding.id, content, anchor });
    if (!isLocated(anchor) && mayRelocate(input)) {
      result.relocationsAttempted += 1;
      missed.push({ id: finding.id, content });
    }
  }

  const relocations = await relocateMissedFindings(input, missed);

  for (const entry of prepared) {
    const content = entry.content;
    if (!content) {
      result.findings.push(unanchoredFinding(entry.id, entry.anchor, false));
      continue;
    }

    let existingCode = content.existingCode;
    let anchor = entry.anchor;
    let relocated = false;
    const attempt = relocations.get(entry.id);
    if (attempt) {
      const retry = resolveAnchor({ ...anchorable, existingCode: attempt });
      if (isLocated(retry)) {
        // A re-extraction only survives if it anchors, so a failed rewrite
        // never replaces the model's actual claim.
        existingCode = attempt;
        anchor = { ...retry, tier: "relocated" };
        relocated = true;
        result.relocationsResolved += 1;
        resealed.set(
          entry.id,
          await sealVaultSecret(
            {
              workspaceId: input.job.workspaceId,
              recordId: entry.id,
              provider: "ai-review-finding",
            },
            JSON.stringify({ ...content, existingCode }),
          ),
        );
      }
    }

    if (!isLocated(anchor)) {
      result.findings.push(unanchoredFinding(entry.id, anchor, relocated));
      continue;
    }

    const settled: DeepReviewValidatedFinding = {
      id: entry.id,
      state: "anchored",
      verdict: "unverified",
      verdictReason: null,
      anchorTier: anchor.tier,
      anchorSide: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      anchorAmbiguous: anchor.ambiguous,
      unitId: unitForAnchor(anchor, pathUnits),
      relocated,
    };

    if (!anchorIsInScope(anchor, scopeRanges(input, anchor.side))) {
      settled.state = "out_of_scope";
      result.findings.push(settled);
      continue;
    }

    const sideEvidence = evidenceForSide(input, anchor.side);
    if (!anchorIsGrounded(anchor, sideEvidence)) {
      settled.state = "ungrounded";
      result.findings.push(settled);
      continue;
    }
    for (const row of overlappingEvidence(sideEvidence, anchor)) {
      // The link carries the job because grounding means this agent read this
      // range: the database checks the finding and the range against it.
      groundedLinks.push({
        findingId: entry.id,
        evidenceId: row.id,
        jobId: input.job.id,
      });
    }
    refutable.push({
      id: entry.id,
      content: findingText(content),
      existingCode,
      finding: settled,
    });
    result.findings.push(settled);
  }

  if (refutable.length > 0) {
    result.refutationApplied = await refuteFindings(input, refutable);
  }
  await persistValidation(db, result.findings, resealed);
  if (groundedLinks.length > 0) {
    await db
      .insert(aiReviewFindingEvidence)
      .values(groundedLinks)
      .onConflictDoNothing();
  }
  return result;
}

/** Reads the findings this item reported and has not been validated yet. */
async function loadSubmittedFindings(
  db: Database,
  input: ValidateFileFindingsInput,
): Promise<LoadedFinding[]> {
  const rows: { id: string; encryptedContent: string }[] = await db
    .select({
      id: aiReviewFindings.id,
      encryptedContent: aiReviewFindings.encryptedContent,
    })
    .from(aiReviewFindings)
    .where(
      and(
        eq(aiReviewFindings.itemId, input.item.id),
        // Only `submitted` rows are validated, which is what makes a replayed
        // file step a no-op instead of a second round of model calls.
        eq(aiReviewFindings.state, "submitted"),
      ),
    );
  const ordered = [...rows].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return Promise.all(
    ordered.map(async (row) => ({
      id: row.id,
      content: await readFindingContent(input, row),
    })),
  );
}

/** Opens one sealed finding payload, returning null when it cannot be read. */
async function readFindingContent(
  input: ValidateFileFindingsInput,
  row: { id: string; encryptedContent: string },
): Promise<FindingContent | null> {
  try {
    const payload = await openVaultSecret(
      {
        workspaceId: input.job.workspaceId,
        recordId: row.id,
        provider: "ai-review-finding",
      },
      row.encryptedContent,
    );
    return parseFindingContent(payload);
  } catch {
    return null;
  }
}

/** Returns whether a relocation attempt is both configured and still affordable. */
function mayRelocate(input: ValidateFileFindingsInput): boolean {
  if (!input.model) return false;
  const budget = input.relocationBudget;
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

/**
 * Re-extracts every snippet that missed, a few calls at a time.
 *
 * Each re-extraction is a whole model round trip carrying the changed source,
 * so running the file's misses one after another holds this lane of the
 * fan-out open for the sum of them. Results are keyed by id, which is what
 * lets the caller apply them in the order the findings were reported.
 */
async function relocateMissedFindings(
  input: ValidateFileFindingsInput,
  missed: RelocatableFinding[],
): Promise<Map<string, string>> {
  const attempts = await mapWithLimit(missed, RELOCATION_CONCURRENCY, (entry) =>
    relocateFinding(input, entry.content),
  );
  const relocations = new Map<string, string>();
  missed.forEach((entry, index) => {
    const attempt = attempts[index];
    if (attempt) relocations.set(entry.id, attempt);
  });
  return relocations;
}

/** Asks the model to re-extract a snippet, returning null on any failure. */
async function relocateFinding(
  input: ValidateFileFindingsInput,
  content: FindingContent,
): Promise<string | null> {
  const source = input.currentSource ?? input.previousSource;
  if (!input.model || !source) return null;
  try {
    const text = await input.model.generate({
      system: input.relocateSystemPrompt ?? DEEP_REVIEW_RELOCATE_SYSTEM_PROMPT,
      prompt: relocateUserPrompt(
        {
          existingCode: content.existingCode,
          findingBody: findingText(content),
          changedSource: source,
        },
        input.promptBodies,
      ),
      maxOutputTokens: MAX_RELOCATE_OUTPUT_TOKENS,
    });
    const code = extractCodeBlock(text);
    return code === "" ? null : code;
  } catch {
    // A relocation failure costs the finding its line, never its existence.
    return null;
  }
}

/** Returns the changed ranges that govern the scope gate on one side. */
function scopeRanges(
  input: ValidateFileFindingsInput,
  side: AnchorSide | null,
): readonly AnchorRange[] {
  if (side === "previous") {
    // With no previous-side range list there is nothing to prove the anchor
    // sits on changed code, and the gate fails closed rather than guessing.
    return input.previousChangedRanges ?? [];
  }
  return input.changedRanges;
}

/**
 * Selects the evidence read from the revision an anchor actually resolved on.
 *
 * `ai_job_evidence` records no side, so grounding has to partition by
 * `sourceBlobId`. Without it a `file_previous` anchor is "grounded" by the
 * agent's read of the current revision, which is the one thing the gate is
 * there to prevent.
 */
function evidenceForSide(
  input: ValidateFileFindingsInput,
  side: AnchorSide | null,
): DeepReviewValidationEvidence[] {
  const blobId =
    side === "previous" ? input.previousBlobId : input.currentBlobId;
  if (!blobId) return [];
  return input.evidence.filter((row) => row.sourceBlobId === blobId);
}

/** Returns the evidence rows whose lines overlap a grounded anchor. */
function overlappingEvidence(
  evidence: readonly DeepReviewValidationEvidence[],
  anchor: AnchorResult,
): DeepReviewValidationEvidence[] {
  const start = anchor.startLine ?? 0;
  const end = anchor.endLine ?? 0;
  return evidence.filter((row) => row.startLine <= end && row.endLine >= start);
}

/**
 * Judges one file's anchored findings in a single batched call.
 *
 * Returns whether the batch was applied at all: a provider error, a timeout,
 * an unparseable answer or a duplicated id all leave every finding unverified
 * and surfaced, because this call is the only one that discards a finding.
 */
async function refuteFindings(
  input: ValidateFileFindingsInput,
  batch: readonly {
    id: string;
    content: string;
    existingCode: string;
    finding: DeepReviewValidatedFinding;
  }[],
): Promise<boolean> {
  if (!input.model) return false;
  let votes: RefuteVote[] | null = null;
  try {
    const text = await input.model.generate({
      system: input.refuteSystemPrompt ?? DEEP_REVIEW_REFUTE_SYSTEM_PROMPT,
      prompt: refuteUserPrompt(
        {
          path: input.item.path,
          findings: batch.map((entry) => ({
            id: entry.id,
            content: entry.content,
            existingCode: entry.existingCode,
          })),
          currentSource: input.currentSource,
          previousSource: input.previousSource,
        },
        input.promptBodies,
      ),
      maxOutputTokens: MAX_REFUTE_OUTPUT_TOKENS,
    });
    votes = parseRefuteVotes(text);
  } catch {
    votes = null;
  }
  const resolutions = applyRefuteVerdicts({
    votes: votes ?? [],
    findingIds: batch.map((entry) => entry.id),
    snapshotPaths: input.snapshotPaths,
  });
  for (const entry of batch) {
    const resolution = resolutions.get(entry.id);
    if (!resolution) continue;
    entry.finding.verdict = resolution.verdict;
    entry.finding.verdictReason = resolution.reason
      ? sanitizeReason(resolution.reason, {
          maxLength: MAX_VERDICT_REASON_LENGTH,
        })
      : null;
    if (resolution.verdict === "refuted") entry.finding.state = "refuted";
  }
  return votes !== null;
}

/**
 * Builds one column's new value as a `case` over the findings' ids.
 *
 * The cast comes from the column itself because a `case` whose branches are
 * all placeholders resolves to text, which Postgres will not assign to an
 * enum, integer or boolean column.
 */
function settledColumn(
  findings: readonly DeepReviewValidatedFinding[],
  column: PgColumn,
  value: (finding: DeepReviewValidatedFinding) => unknown,
): SQL {
  const type = sql.raw(column.getSQLType());
  return sql`case ${aiReviewFindings.id} ${sql.join(
    findings.map(
      (finding) => sql`when ${finding.id} then ${value(finding)}::${type}`,
    ),
    sql` `,
  )} end`;
}

/**
 * Writes each finding's settled state and any resealed relocated snippet.
 *
 * The whole file settles in one statement: this runs on the critical path of
 * closing a review item, with every other file's lane competing for the same
 * pool.
 */
async function persistValidation(
  db: Database,
  findings: readonly DeepReviewValidatedFinding[],
  resealed: ReadonlyMap<string, string>,
): Promise<void> {
  const values: PgUpdateSetSource<typeof aiReviewFindings> = {
    state: settledColumn(
      findings,
      aiReviewFindings.state,
      (finding) => finding.state,
    ),
    verdict: settledColumn(
      findings,
      aiReviewFindings.verdict,
      (finding) => finding.verdict,
    ),
    verdictReason: settledColumn(
      findings,
      aiReviewFindings.verdictReason,
      (finding) => finding.verdictReason,
    ),
    anchorTier: settledColumn(
      findings,
      aiReviewFindings.anchorTier,
      (finding) => finding.anchorTier,
    ),
    anchorSide: settledColumn(
      findings,
      aiReviewFindings.anchorSide,
      (finding) => finding.anchorSide,
    ),
    startLine: settledColumn(
      findings,
      aiReviewFindings.startLine,
      (finding) => finding.startLine,
    ),
    endLine: settledColumn(
      findings,
      aiReviewFindings.endLine,
      (finding) => finding.endLine,
    ),
    anchorAmbiguous: settledColumn(
      findings,
      aiReviewFindings.anchorAmbiguous,
      (finding) => finding.anchorAmbiguous,
    ),
    unitId: settledColumn(
      findings,
      aiReviewFindings.unitId,
      (finding) => finding.unitId,
    ),
  };
  if (resealed.size > 0) {
    // Only a relocated finding is resealed, so every other row coalesces back
    // onto the payload it already carries.
    values.encryptedContent = sql`coalesce(${settledColumn(
      findings,
      aiReviewFindings.encryptedContent,
      (finding) => resealed.get(finding.id) ?? null,
    )}, ${aiReviewFindings.encryptedContent})`;
  }
  await db
    .update(aiReviewFindings)
    .set(values)
    .where(
      and(
        inArray(
          aiReviewFindings.id,
          findings.map((finding) => finding.id),
        ),
        // Guarding on the pre-validation state keeps a concurrent replay from
        // overwriting a verdict that has already been settled.
        eq(aiReviewFindings.state, "submitted"),
      ),
    );
}

/**
 * Builds a job-scoped model client for the two validation calls.
 *
 * Usage is accumulated onto the child job so the run's rollup at finalize sees
 * the relocation and refutation spend, not only the scout turns.
 */
export function deepReviewValidationModel(
  db: Database,
  job: Pick<
    typeof aiJobs.$inferSelect,
    "id" | "workspaceId" | "provider" | "model"
  >,
): DeepReviewValidationModel {
  let resolved: ReturnType<typeof resolveAiModel> | undefined;
  /** Resolves the model once per client, retrying after a failed resolution. */
  const connect = () => {
    if (!resolved) {
      resolved = resolveAiModel(db, {
        workspaceId: job.workspaceId,
        provider: job.provider ?? "",
        model: job.model ?? "",
      });
      resolved.catch(() => {
        resolved = undefined;
      });
    }
    return resolved;
  };
  return {
    async generate(request) {
      const model = await connect();
      const result = await observeOperation(
        "ai.deep-review-validate",
        "ai.model",
        () =>
          generateText({
            model: model.model,
            system: request.system,
            prompt: request.prompt,
            maxRetries: 0,
            maxOutputTokens: request.maxOutputTokens,
            timeout: Math.min(VALIDATION_TIMEOUT_MS, env.AI_MAX_DURATION_MS),
            // zdr and data_collection live here, so no call may omit them.
            providerOptions: model.providerOptions,
            telemetry: { isEnabled: false },
          }),
      );
      await accumulateValidationUsage(db, job.id, result);
      return result.text ?? "";
    },
  };
}

/** Adds one validation call's provider usage to the child job's ledger. */
async function accumulateValidationUsage(
  db: Database,
  jobId: string,
  result: {
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    };
    providerMetadata?: unknown;
  },
): Promise<void> {
  const usage = result.usage;
  const metadata = result.providerMetadata as
    | { openrouter?: { usage?: { cost?: number } } }
    | undefined;
  const microUsd = Math.ceil(
    (metadata?.openrouter?.usage?.cost ?? 0) * 1_000_000,
  );
  await db
    .update(aiJobs)
    .set({
      inputTokens: sql`${aiJobs.inputTokens} + ${usage.inputTokens ?? 0}`,
      outputTokens: sql`${aiJobs.outputTokens} + ${usage.outputTokens ?? 0}`,
      cacheReadTokens: sql`${aiJobs.cacheReadTokens} + ${usage.inputTokenDetails?.cacheReadTokens ?? 0}`,
      cacheWriteTokens: sql`${aiJobs.cacheWriteTokens} + ${usage.inputTokenDetails?.cacheWriteTokens ?? 0}`,
      totalTokens: sql`${aiJobs.totalTokens} + ${usage.totalTokens ?? 0}`,
      actualMicroUsd: sql`${aiJobs.actualMicroUsd} + ${microUsd}`,
    })
    .where(eq(aiJobs.id, jobId));
}
