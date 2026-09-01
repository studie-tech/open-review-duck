import "server-only";

import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  type aiJobs,
  aiReviewFindingLocations,
  aiReviewFindings,
  aiReviewItems,
  reviewComments,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { openVaultSecret } from "~/server/security/vault";
import { deepReviewCoverage } from "./finalize";
import { DEEP_REVIEW_SURVEY_ITEM_PATH } from "./survey";

/**
 * The finding states a reviewer is shown, discards included.
 *
 * `submitted` is pre-validation and `merged`/`dropped` are collapsed duplicates,
 * so neither is a claim anyone still makes. The anchoring gate failures and a
 * refutation are: they are retained as rows precisely so a discard stays
 * auditable, and hiding them here would make one indistinguishable from a
 * finding the run never reported.
 */
const SURFACED_DEEP_REVIEW_FINDING_STATES = [
  "anchored",
  "unanchored",
  "out_of_scope",
  "ungrounded",
  "refuted",
] as const;

interface DeepReviewFindingContent {
  title: string;
  body: string;
  existingCode: string;
  suggestionCode?: string;
}

/** Reads a sealed finding payload, tolerating anything that is not our shape. */
function parseDeepReviewFindingContent(
  payload: string,
): DeepReviewFindingContent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      existingCode:
        typeof record.existingCode === "string" ? record.existingCode : "",
      suggestionCode:
        typeof record.suggestionCode === "string"
          ? record.suggestionCode
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Opens one finding's sealed content, returning null when it cannot be read.
 *
 * A single unreadable payload must not take the whole run's findings with it,
 * so the failure is reported per row and the reviewer still sees the anchor.
 */
async function openDeepReviewFindingContent(finding: {
  id: string;
  workspaceId: string;
  encryptedContent: string;
}): Promise<DeepReviewFindingContent | null> {
  try {
    return parseDeepReviewFindingContent(
      await openVaultSecret(
        {
          workspaceId: finding.workspaceId,
          recordId: finding.id,
          provider: "ai-review-finding",
        },
        finding.encryptedContent,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Reports whether a finding still names a line a comment could be attached to.
 *
 * `review_comment.unitId` and `review_comment.line` are both not null, so an
 * unanchored, out-of-scope, ungrounded or refuted finding is structurally
 * unpublishable. The read path says so once, here, rather than leaving every
 * caller to rediscover it against a failing insert.
 */
function isDeepReviewFindingPublishable<
  T extends {
    state: string;
    verdict: string | null;
    path: string | null;
    startLine: number | null;
    unitId: string | null;
  },
>(
  finding: T,
): finding is T & { path: string; startLine: number; unitId: string } {
  return (
    finding.state === "anchored" &&
    finding.verdict !== "refuted" &&
    finding.path !== null &&
    finding.startLine !== null &&
    finding.unitId !== null
  );
}

/** Sorts findings by their frozen rank, leaving unranked rows at the end. */
function compareDeepReviewFindings(
  left: { id: string; orderIndex: number | null },
  right: { id: string; orderIndex: number | null },
): number {
  if (left.orderIndex !== right.orderIndex) {
    if (left.orderIndex === null) return 1;
    if (right.orderIndex === null) return -1;
    return left.orderIndex - right.orderIndex;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Assembles the surfaced findings and sealed coverage of one deep-review run.
 *
 * Every row below the run is reached through `ai_review_item.parentJobId`, so
 * the caller authorizes the parent job once and nothing here needs a scope
 * check of its own. Exported for its own tests, which is why it takes the job
 * row rather than looking it up.
 */
export async function deepReviewRunPayload(
  db: typeof database,
  job: Pick<
    typeof aiJobs.$inferSelect,
    | "completedAt"
    | "completionReason"
    | "createdAt"
    | "deepReviewTerminalState"
    | "error"
    | "id"
    | "runFailureClass"
    | "status"
  >,
) {
  // `review_comment` has no column for a finding id: publication is keyed on
  // (aiJobId, aiFindingIndex), and the deep-review path writes the run-wide
  // `orderIndex` into that column. Reading it for the whole run is what lets a
  // findings list tell the truth about every file at once; the per-unit
  // discussion read can only answer for the unit that happens to be open. It
  // keys off the job alone, so it rides along with the item read.
  const [items, publishedComments] = await Promise.all([
    db.query.aiReviewItems.findMany({
      columns: {
        id: true,
        path: true,
        changeType: true,
        changedLineCount: true,
        state: true,
        failureClass: true,
        reason: true,
      },
      where: eq(aiReviewItems.parentJobId, job.id),
    }),
    db.query.reviewComments.findMany({
      columns: { aiFindingIndex: true },
      where: and(
        eq(reviewComments.aiJobId, job.id),
        eq(reviewComments.status, "published"),
      ),
    }),
  ]);
  const findingRows =
    items.length === 0
      ? []
      : await db.query.aiReviewFindings.findMany({
          where: and(
            inArray(
              aiReviewFindings.itemId,
              items.map((item) => item.id),
            ),
            inArray(aiReviewFindings.state, [
              ...SURFACED_DEEP_REVIEW_FINDING_STATES,
            ]),
          ),
        });
  const locationRows =
    findingRows.length === 0
      ? []
      : await db.query.aiReviewFindingLocations.findMany({
          columns: {
            findingId: true,
            path: true,
            anchorTier: true,
            anchorSide: true,
            startLine: true,
            endLine: true,
          },
          where: inArray(
            aiReviewFindingLocations.findingId,
            findingRows.map((finding) => finding.id),
          ),
          // The client holds an open location by its index in this array, so
          // the order has to be the model's rather than the heap's.
          orderBy: [aiReviewFindingLocations.position],
        });

  const findings = await Promise.all(
    [...findingRows].sort(compareDeepReviewFindings).map(async (finding) => {
      // A payload the vault refuses is reported as an empty finding rather
      // than dropped: a discard the reader cannot see is indistinguishable
      // from a finding the run never made.
      const content = await openDeepReviewFindingContent(finding);
      return {
        id: finding.id,
        orderIndex: finding.orderIndex,
        severity: finding.severity,
        category: finding.category,
        state: finding.state,
        verdict: finding.verdict,
        verdictReason: finding.verdictReason,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        anchorTier: finding.anchorTier,
        anchorSide: finding.anchorSide,
        anchorAmbiguous: finding.anchorAmbiguous,
        unitId: finding.unitId,
        publishable: isDeepReviewFindingPublishable(finding),
        contentAvailable: content !== null,
        title: content?.title ?? "",
        body: content?.body ?? "",
        existingCode: content?.existingCode ?? "",
        suggestionCode: content?.suggestionCode ?? null,
        locations: locationRows
          .filter((location) => location.findingId === finding.id)
          .map(({ findingId: _findingId, ...location }) => location),
      };
    }),
  );

  const publishedRanks = new Set(
    publishedComments.flatMap((comment) =>
      comment.aiFindingIndex === null ? [] : [comment.aiFindingIndex],
    ),
  );
  const publishedFindingIds = findings
    .filter(
      (finding) =>
        finding.orderIndex !== null && publishedRanks.has(finding.orderIndex),
    )
    .map(({ id }) => id);

  return {
    jobId: job.id,
    status: job.status,
    terminalState: job.deepReviewTerminalState,
    runFailureClass: job.runFailureClass,
    completionReason: job.completionReason,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    coverage: deepReviewCoverage(items),
    items: items
      .map((item) => ({
        ...item,
        // The survey's coverage row names no real file, so a reviewer reading
        // a file list is told which entry is not one.
        kind:
          item.path === DEEP_REVIEW_SURVEY_ITEM_PATH
            ? ("survey" as const)
            : ("file" as const),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
        return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
      }),
    findings,
    publishedFindingIds,
  };
}

/**
 * Resolves the one deep-review finding a publish request may turn into a
 * comment, refusing anything that no longer describes the selected line.
 *
 * The caller's job lookup is what authorizes this: the finding row carries no
 * reviewer of its own, so it is admitted only by belonging to that job's sealed
 * plan. Everything checked here is freshness, not access. Exported for its own
 * tests, which is why it takes the parent job id rather than resolving it.
 */
export async function deepReviewFindingForPublication(
  db: typeof database,
  input: { findingId: string; parentJobId: string; path: string; line: number },
) {
  const finding = await db.query.aiReviewFindings.findFirst({
    where: eq(aiReviewFindings.id, input.findingId),
  });
  const item = finding
    ? await db.query.aiReviewItems.findFirst({
        columns: { parentJobId: true },
        where: eq(aiReviewItems.id, finding.itemId),
      })
    : undefined;
  if (!finding || item?.parentJobId !== input.parentJobId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding does not belong to the selected review",
    });
  }
  if (!isDeepReviewFindingPublishable(finding)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This AI finding is not anchored to a line of the pull request, so it can only be read in ReviewDuck",
    });
  }
  if (finding.path !== input.path || finding.startLine !== input.line) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding no longer matches the selected code",
    });
  }
  // `review_comment` has no finding-id column. Its (aiJobId, aiFindingIndex)
  // key therefore uses the run-wide order frozen at finalize.
  const orderIndex = finding.orderIndex;
  if (orderIndex === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This deep review has not finished ranking its findings yet",
    });
  }
  const content = await openDeepReviewFindingContent(finding);
  if (!content) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding could not be read back for publication",
    });
  }
  return { body: `**${content.title}**\n\n${content.body}`, orderIndex };
}
