import { randomUUID } from "node:crypto";
import { and, desc, eq, lte, or } from "drizzle-orm";
import { reviewComments } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ProviderReviewThread } from "~/server/providers/types";

type Database = typeof database;

const COMMENT_MARKER_PATTERN =
  /\n?<!-- reviewduck-comment:([0-9a-f-]{36}) -->/gi;

/** Appends an invisible provider-side identifier used to reconcile ambiguous publishes. */
export function providerCommentBody(body: string, commentId: string) {
  return `${body}\n\n<!-- reviewduck-comment:${commentId} -->`;
}

/** Derives one provider idempotency key from a fenced publication attempt. */
export function publicationAttemptKey(commentId: string, leaseToken: string) {
  return `${commentId}:${leaseToken}`;
}

/** Removes ReviewDuck's invisible publication marker before rendering a conversation. */
export function visibleProviderCommentBody(body: string) {
  return body.replace(COMMENT_MARKER_PATTERN, "").trimEnd();
}

/** Finds a provider thread that already contains a locally identified comment. */
export function publishedThreadForComment(
  threads: ProviderReviewThread[],
  commentId: string,
) {
  const marker = `<!-- reviewduck-comment:${commentId} -->`;
  return threads.find((thread) =>
    thread.comments.some((comment) => comment.body.includes(marker)),
  );
}

/** Finds the latest equivalent user comment so retries reuse one publication record. */
export async function findEquivalentUserComment(
  db: Database,
  input: {
    unitId: string;
    userId: string;
    body: string;
    line: number;
  },
) {
  return db.query.reviewComments.findFirst({
    where: and(
      eq(reviewComments.unitId, input.unitId),
      eq(reviewComments.userId, input.userId),
      eq(reviewComments.source, "user"),
      eq(reviewComments.body, input.body),
      eq(reviewComments.line, input.line),
    ),
    orderBy: [desc(reviewComments.createdAt)],
  });
}

/** Atomically leases a failed or stale in-flight comment for one publication retry. */
export async function claimCommentForPublicationRetry(
  db: Database,
  commentId: string,
) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const publicationLeaseToken = randomUUID();
  const [claimed] = await db
    .update(reviewComments)
    .set({ status: "publishing", error: null, publicationLeaseToken })
    .where(
      and(
        eq(reviewComments.id, commentId),
        or(
          eq(reviewComments.status, "failed"),
          and(
            eq(reviewComments.status, "publishing"),
            lte(reviewComments.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning();
  return claimed;
}
