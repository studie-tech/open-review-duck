import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { aiJobs, aiReviewFindings, aiReviewItems } from "@/drizzle/schema";
import {
  acceptAiJobResult,
  settleAiJobQuota,
  type TokenUsage,
} from "~/server/ai/service";
import type { db as database } from "~/server/db";
import {
  classifyReviewItemError,
  coveragePartitionErrors,
  type DeepReviewItemState,
  type DeepReviewTerminalState,
  deepReviewTerminalState,
  type ReviewFailureClass,
} from "./coverage";
import { type FindingSeverity, orderFindings } from "./findings";
import { sanitizeReason } from "./redaction";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The finding states a reviewer is shown, and therefore the ones that rank.
 *
 * `submitted` is pre-validation, and `refuted`, `merged` and `dropped` are
 * auditable discards, so none of them earns a position in the surfaced list.
 */
const SURFACED_FINDING_STATES = [
  "anchored",
  "unanchored",
  "out_of_scope",
  "ungrounded",
] as const;

const BUDGET_SWEEP_REASON =
  "The review stopped at its token budget before this file was reviewed.";
const UNKNOWN_SWEEP_REASON = "The review ended before this file was reviewed.";

/** A failure that ended the run itself, outranking every pending cause. */
export interface DeepReviewRunFailure {
  failureClass?: ReviewFailureClass;
  cause?: unknown;
}

/** A budget stop that halted dispatch while the run itself stayed healthy. */
interface DeepReviewBudgetStop {
  cause?: unknown;
}

export interface DeepReviewSweepCause {
  runFailure?: DeepReviewRunFailure;
  budgetStop?: DeepReviewBudgetStop;
}

export interface FinalizeDeepReviewOptions extends DeepReviewSweepCause {
  /** The sealed denominator, when the caller carries it independently. */
  expectedItemCount?: number;
  /** Overrides the derived summary; must be stable across a replay. */
  summary?: string;
}

export interface DeepReviewSweep {
  failureClass: ReviewFailureClass;
  reason: string;
}

export interface DeepReviewCoverage {
  total: number;
  completed: number;
  reused: number;
  waived: number;
  failed: number;
}

export type DeepReviewCompletionReason =
  | "answered"
  | "deep_review_partial"
  | "deep_review_skipped";

export interface DeepReviewFinalizeResult {
  terminalState: DeepReviewTerminalState;
  runFailureClass: ReviewFailureClass | null;
  completionReason: DeepReviewCompletionReason;
  coverage: DeepReviewCoverage;
  sweptCount: number;
  surfacedFindingCount: number;
  usage: TokenUsage;
  summary: string;
  accepted: boolean;
}

interface CoverageRow {
  id: string;
  state: DeepReviewItemState;
  path: string;
  failureClass: ReviewFailureClass | null;
}

interface SurfacedFinding {
  id: string;
  severity: FindingSeverity;
  path: string | null;
  startLine: number | null;
}

interface UsageColumns {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  totalTokens?: unknown;
  actualMicroUsd?: unknown;
}

/** Reports whether a value carries text a persisted reason can derive from. */
function hasStatedCause(cause: unknown): boolean {
  if (cause === undefined || cause === null) return false;
  if (typeof cause === "string") return cause.trim() !== "";
  return true;
}

/**
 * Classifies the files a run never reached, by cause precedence.
 *
 * A run failure explains every leftover item, so it outranks a budget stop,
 * which in turn outranks the bare fact that the file was never reached.
 */
export function deepReviewSweepFailure(
  cause: DeepReviewSweepCause,
): DeepReviewSweep {
  const { runFailure, budgetStop } = cause;
  if (runFailure) {
    const failureClass =
      runFailure.failureClass ?? classifyReviewItemError(runFailure.cause);
    return {
      failureClass,
      reason: sanitizeReason(
        hasStatedCause(runFailure.cause)
          ? runFailure.cause
          : UNKNOWN_SWEEP_REASON,
      ),
    };
  }
  if (budgetStop) {
    return {
      failureClass: "budget",
      reason: sanitizeReason(
        hasStatedCause(budgetStop.cause)
          ? budgetStop.cause
          : BUDGET_SWEEP_REASON,
      ),
    };
  }
  return { failureClass: "unknown", reason: UNKNOWN_SWEEP_REASON };
}

/** Counts the sealed items by state so coverage reads the same everywhere. */
export function deepReviewCoverage(
  items: readonly { state: DeepReviewItemState }[],
): DeepReviewCoverage {
  const coverage: DeepReviewCoverage = {
    total: items.length,
    completed: 0,
    reused: 0,
    waived: 0,
    failed: 0,
  };
  for (const item of items) {
    if (item.state === "completed") coverage.completed += 1;
    else if (item.state === "reused") coverage.reused += 1;
    else if (item.state === "waived") coverage.waived += 1;
    else if (item.state === "failed") coverage.failed += 1;
  }
  return coverage;
}

/**
 * Names the run-level failure class, which a budget stop never sets.
 *
 * A truncated run is a successful run with partial coverage, so only a failure
 * of the run itself — or a total loss of coverage — writes this column.
 */
export function deepReviewRunFailureClass(input: {
  runFailure?: DeepReviewRunFailure;
  terminalState: DeepReviewTerminalState;
  items: readonly { state: DeepReviewItemState; failureClass?: unknown }[];
}): ReviewFailureClass | null {
  if (input.runFailure) {
    return (
      input.runFailure.failureClass ??
      classifyReviewItemError(input.runFailure.cause)
    );
  }
  if (input.terminalState !== "failed") return null;
  const classes = [
    ...new Set(
      input.items.flatMap((item) =>
        item.state === "failed" && typeof item.failureClass === "string"
          ? [item.failureClass as ReviewFailureClass]
          : [],
      ),
    ),
  ];
  // Every file failed. One shared cause is the run's cause; a mixture is not
  // attributable to any single class, and the items keep their own.
  const [only] = classes;
  return classes.length === 1 && only ? only : "unknown";
}

/** Reads a Postgres aggregate column, which arrives as a numeric string. */
function toUsageCount(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * Sums the usage rows of a review tree into one reportable settlement.
 *
 * `totalTokens` is floored at input plus output because a provider that omits
 * a total would otherwise leave the monthly token limit reading zero for a run
 * that plainly spent tokens.
 */
export function deepReviewTreeUsage(rows: readonly UsageColumns[]): TokenUsage {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    microUsd: 0,
  };
  for (const row of rows) {
    usage.input += toUsageCount(row.inputTokens);
    usage.output += toUsageCount(row.outputTokens);
    usage.cacheRead += toUsageCount(row.cacheReadTokens);
    usage.cacheWrite += toUsageCount(row.cacheWriteTokens);
    usage.totalTokens += toUsageCount(row.totalTokens);
    usage.microUsd += toUsageCount(row.actualMicroUsd);
  }
  usage.totalTokens = Math.max(usage.totalTokens, usage.input + usage.output);
  return usage;
}

/** Maps a terminal state onto the completion reason the job row records. */
export function deepReviewCompletionReason(
  terminalState: DeepReviewTerminalState,
): DeepReviewCompletionReason {
  if (terminalState === "complete") return "answered";
  if (terminalState === "skipped") return "deep_review_skipped";
  // A fully failed run is the extreme of incomplete coverage, and the terminal
  // state column carries the distinction the completion reason cannot.
  return "deep_review_partial";
}

/** States what the run covered, in wording that never varies on a replay. */
function deepReviewSummary(input: {
  terminalState: DeepReviewTerminalState;
  coverage: DeepReviewCoverage;
  findingCount: number;
}): string {
  const { coverage, findingCount } = input;
  const findings = `${findingCount} finding${findingCount === 1 ? "" : "s"}`;
  const reviewed = coverage.completed + coverage.reused;
  switch (input.terminalState) {
    case "skipped":
      return "Deep review selected no file in this pull request, so nothing was reviewed.";
    case "failed":
      return `Deep review could not review any of the ${coverage.total} selected file(s).`;
    case "partial":
      return `Deep review covered ${reviewed} of ${coverage.total} selected file(s) and reported ${findings}. ${coverage.failed} file(s) were not reviewed.`;
    default:
      return `Deep review covered all ${coverage.total} selected file(s) and reported ${findings}.`;
  }
}

/** Names the advisory lock every closer of one review tree contends for. */
export function deepReviewTreeLockKey(parentJobId: string) {
  return `deep-review:cancel:${parentJobId}`;
}

/**
 * Closes one deep-review run: sweeps coverage, settles the tree, and accepts.
 *
 * Every step is idempotent because the workflow step calling this replays, and
 * `acceptAiJobResult` only tolerates a replay whose projection is identical.
 */
export async function finalizeDeepReview(
  db: Database,
  parentJobId: string,
  options: FinalizeDeepReviewOptions = {},
): Promise<DeepReviewFinalizeResult> {
  const parent = await db.query.aiJobs.findFirst({
    columns: { id: true, parentJobId: true, status: true },
    where: eq(aiJobs.id, parentJobId),
  });
  if (!parent) throw new Error("Deep review parent job not found");
  if (parent.parentJobId) {
    throw new Error("finalizeDeepReview requires a deep review parent job");
  }

  const closed = await db.transaction(async (tx) => {
    // One closer per tree. Cancellation sweeps the same items, and the usage
    // rollup is a read of every child followed by a write of their sum, so
    // every closer takes this one lock: without it a cancellation sweep lands
    // between another closer's read and its write, and the run reports a
    // coverage reason and a settled total that no longer describe the tree.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${deepReviewTreeLockKey(parentJobId)}))`,
    );
    const sweep = deepReviewSweepFailure(options);
    const swept = await tx
      .update(aiReviewItems)
      .set({
        state: "failed",
        failureClass: sweep.failureClass,
        reason: sweep.reason,
      })
      .where(
        and(
          eq(aiReviewItems.parentJobId, parentJobId),
          eq(aiReviewItems.state, "selected"),
        ),
      )
      .returning({ id: aiReviewItems.id });

    const items: CoverageRow[] = await tx.query.aiReviewItems.findMany({
      columns: { id: true, path: true, state: true, failureClass: true },
      where: eq(aiReviewItems.parentJobId, parentJobId),
    });

    const partitionErrors = coveragePartitionErrors({
      selectedCount: options.expectedItemCount ?? items.length,
      items,
    });
    if (partitionErrors.length > 0) {
      throw new Error(
        `Deep review coverage does not partition the sealed plan: ${partitionErrors.join("; ")}`,
      );
    }

    const surfaced = await surfacedFindings(
      tx,
      items.map((item) => item.id),
    );
    const ordered = orderFindings(surfaced);
    for (const [orderIndex, finding] of ordered.entries()) {
      await tx
        .update(aiReviewFindings)
        .set({ orderIndex })
        .where(eq(aiReviewFindings.id, finding.id));
    }

    const usage = await rollUpTreeUsage(tx, parentJobId);

    const terminalState = deepReviewTerminalState(items);
    const runFailureClass = deepReviewRunFailureClass({
      runFailure: options.runFailure,
      terminalState,
      items,
    });
    const coverage = deepReviewCoverage(items);
    const completionReason = deepReviewCompletionReason(terminalState);
    await tx
      .update(aiJobs)
      .set({ deepReviewTerminalState: terminalState, runFailureClass })
      .where(eq(aiJobs.id, parentJobId));

    const summary =
      options.summary ??
      deepReviewSummary({
        terminalState,
        coverage,
        findingCount: ordered.length,
      });
    return {
      terminalState,
      runFailureClass,
      completionReason,
      coverage,
      sweptCount: swept.length,
      surfacedFindingCount: ordered.length,
      usage,
      summary,
    };
  });

  // Findings live in `ai_review_finding`, which the read path joins through
  // `parentJobId`; duplicating them here would give the UI two sources of
  // truth and make the replay comparison depend on finding ordering twice.
  // Acceptance sits outside the lock deliberately: it is one-shot on a null
  // result, so a closer that lost the race has nothing left to disagree about.
  const accepted = await acceptAiJobResult(db, parentJobId, {
    summary: closed.summary,
    annotations: [],
    findings: [],
  });
  if (accepted && closed.completionReason !== "answered") {
    // `acceptAiJobResult` writes `answered`, and its signature does not admit
    // the deep-review reasons, so the precise reason is patched on top of an
    // acceptance we already know landed.
    await db
      .update(aiJobs)
      .set({ completionReason: closed.completionReason })
      .where(and(eq(aiJobs.id, parentJobId), eq(aiJobs.status, "completed")));
  }

  return { ...closed, accepted };
}

/** Loads the reviewer-visible findings of a run in one indexed read. */
async function surfacedFindings(
  tx: Transaction,
  itemIds: readonly string[],
): Promise<SurfacedFinding[]> {
  if (itemIds.length === 0) return [];
  return await tx
    .select({
      id: aiReviewFindings.id,
      severity: aiReviewFindings.severity,
      path: aiReviewFindings.path,
      startLine: aiReviewFindings.startLine,
    })
    .from(aiReviewFindings)
    .where(
      and(
        inArray(aiReviewFindings.itemId, [...itemIds]),
        inArray(aiReviewFindings.state, [...SURFACED_FINDING_STATES]),
      ),
    );
}

/**
 * Rolls child usage onto the parent so the quota settlement can see it.
 *
 * Every model call happens on a child, and `settleAiJobQuota` reads one job
 * row and returns before the `ai_usage` write when that row reserved nothing.
 * Without this, a multi-million-token review records no monthly tokens and no
 * spend, leaving both the managed token limit and the workspace budget
 * unenforced. The parent row is deliberately excluded from the aggregate: it
 * makes no model calls of its own, and including the row the rollup is written
 * back onto would double the total on every replayed finalize.
 */
async function rollUpTreeUsage(tx: Transaction, parentJobId: string) {
  const rows = await tx
    .select({
      inputTokens: sql`coalesce(sum(${aiJobs.inputTokens}), 0)`,
      outputTokens: sql`coalesce(sum(${aiJobs.outputTokens}), 0)`,
      cacheReadTokens: sql`coalesce(sum(${aiJobs.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql`coalesce(sum(${aiJobs.cacheWriteTokens}), 0)`,
      totalTokens: sql`coalesce(sum(${aiJobs.totalTokens}), 0)`,
      actualMicroUsd: sql`coalesce(sum(${aiJobs.actualMicroUsd}), 0)`,
    })
    .from(aiJobs)
    .where(eq(aiJobs.parentJobId, parentJobId));
  const usage = deepReviewTreeUsage(rows);
  await tx
    .update(aiJobs)
    .set({
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      actualMicroUsd: usage.microUsd,
    })
    .where(eq(aiJobs.id, parentJobId));
  // Settled under the same lock as the read above, so the settlement can never
  // record a total the parent's own usage columns have already outgrown.
  await settleAiJobQuota(tx, parentJobId, usage);
  return usage;
}
