import "server-only";

import { and, eq } from "drizzle-orm";
import { aiJobs, aiPreferences, reviewUnits } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { deepReviewRunPayload } from "~/server/review/deep/payload";
import { reviewUnitContainsLine } from "~/server/review/provider-thread";
import { publishReviewComment } from "~/server/review/publish-comment";

type Database = typeof database;

interface AutoPublishableFinding {
  id: string;
  path: string;
  startLine: number;
}

interface SnapshotUnit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  changeType: (typeof reviewUnits.$inferSelect)["changeType"];
  relatedRanges: (typeof reviewUnits.$inferSelect)["relatedRanges"] | null;
}

/**
 * Returns the innermost unit a finding's start line can be posted on.
 *
 * A comment can only sit on one line. The start is the line the publish path
 * already requires, so a span that crossed a unit boundary still names a unit.
 */
export function reviewUnitForAutoPublish(
  units: readonly SnapshotUnit[],
  path: string,
  line: number,
) {
  const containing = units.filter(
    (unit) => unit.path === path && reviewUnitContainsLine(unit, line),
  );
  if (containing.length === 0) return null;
  return containing.reduce((best, unit) =>
    unit.endLine - unit.startLine < best.endLine - best.startLine ? unit : best,
  );
}

/**
 * Returns the publishable findings a completed run has not posted yet.
 *
 * Unpublishable rows stay in ReviewDuck. Already-posted ranks are skipped so a
 * retried step does not open a second conversation for the same finding.
 */
export function unpublishedAutoPublishFindings(
  findings: readonly {
    id: string;
    path: string | null;
    startLine: number | null;
    publishable: boolean;
  }[],
  publishedFindingIds: readonly string[],
): AutoPublishableFinding[] {
  const published = new Set(publishedFindingIds);
  return findings.flatMap((finding) => {
    if (!finding.publishable || published.has(finding.id)) return [];
    if (finding.path === null || finding.startLine === null) return [];
    return [
      {
        id: finding.id,
        path: finding.path,
        startLine: finding.startLine,
      },
    ];
  });
}

/**
 * Posts every remaining publishable finding when the workspace asked for that.
 *
 * One finding's provider failure must not block the rest, and must not fail
 * the review: the run already finished, and a missed post is still available
 * for the reviewer to send by hand.
 */
export async function autoPublishDeepReviewFindings(
  db: Database,
  parentJobId: string,
) {
  const job = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, parentJobId),
  });
  if (
    job?.kind !== "review" ||
    job.parentJobId !== null ||
    job.status !== "completed"
  ) {
    return { published: 0, failed: 0 };
  }

  const preference = await db.query.aiPreferences.findFirst({
    columns: { autoPublishFindings: true },
    where: eq(aiPreferences.workspaceId, job.workspaceId),
  });
  if (!preference?.autoPublishFindings) {
    return { published: 0, failed: 0 };
  }

  const run = await deepReviewRunPayload(db, job);
  const findings = unpublishedAutoPublishFindings(
    run.findings,
    run.publishedFindingIds,
  );
  if (findings.length === 0) return { published: 0, failed: 0 };

  const units = await db.query.reviewUnits.findMany({
    columns: {
      id: true,
      path: true,
      startLine: true,
      endLine: true,
      changeType: true,
      relatedRanges: true,
    },
    where: and(eq(reviewUnits.snapshotId, job.snapshotId)),
  });

  let published = 0;
  let failed = 0;
  for (const finding of findings) {
    const unit = reviewUnitForAutoPublish(
      units,
      finding.path,
      finding.startLine,
    );
    if (!unit) {
      failed += 1;
      continue;
    }
    try {
      await publishReviewComment(db, job.userId, {
        unitId: unit.id,
        line: finding.startLine,
        aiJobId: job.id,
        aiFindingId: finding.id,
      });
      published += 1;
    } catch {
      failed += 1;
    }
  }
  return { published, failed };
}
