import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { reviewComments } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ProviderReviewThread } from "~/server/providers/types";

type Database = typeof database;

const COMMENT_MARKER = /\n?<!-- reviewduck-comment:([0-9a-f-]{36}) -->/i;
const COMMENT_MARKER_PATTERN = new RegExp(COMMENT_MARKER.source, "gi");

/** Appends an invisible provider-side identifier used to reconcile ambiguous publishes. */
export function providerCommentBody(body: string, commentId: string) {
  return `${body}\n\n<!-- reviewduck-comment:${commentId} -->`;
}

/** Derives one stable provider idempotency key for a logical comment. */
export function publicationAttemptKey(commentId: string) {
  return commentId;
}

/**
 * Carries an existing comment's publication marker onto its rewritten body.
 *
 * The conversation reaches the reviewer with the marker stripped, so an edited
 * body arrives without it. Losing it would leave the publication unreconcilable
 * with its local record, which is what stops a retry publishing twice.
 */
export function rewrittenProviderCommentBody(
  existingBody: string,
  body: string,
) {
  // The canonical marker is appended last, so a marker quoted in the comment
  // text ahead of it must not be the one carried across.
  const commentId = [...existingBody.matchAll(COMMENT_MARKER_PATTERN)].at(
    -1,
  )?.[1];
  return commentId ? providerCommentBody(body, commentId) : body;
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
      // A reply carries its own provider identifier and opened no
      // conversation. It is a record of authorship, never a publication this
      // one could stand in for: matching it would let a new inline comment
      // report itself as already posted on the strength of a reply that
      // happened to say the same thing on the same line.
      isNull(reviewComments.providerCommentExternalId),
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

/**
 * Names the ledger row one comment of a conversation was published as.
 *
 * `publishInlineComment` opens a conversation and returns the identifier the
 * provider gives that conversation: a discussion on GitLab, a thread on Azure
 * DevOps, and the root comment on GitHub, which is what GitHub keys a thread
 * by. So the ledger is keyed by conversation, and only the comment a
 * conversation hangs from is ever a row of it — a reply is keyed by its own
 * identifier instead.
 */
export function publishedCommentId(
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  return thread.comments[0]?.externalId === commentExternalId
    ? thread.externalId
    : undefined;
}

/**
 * Names the reviewer ReviewDuck published one provider comment for.
 *
 * One workspace connection speaks for every member, so the provider cannot
 * say which of them wrote a comment and will let any of them change it. What
 * ReviewDuck published it knows the author of, and that is what it protects:
 * a root comment through the conversation it opened, a reply through its own
 * identifier. A comment ReviewDuck did not publish — a bot's, or one written
 * in the provider's own interface — has no recorded author and stays open to
 * whoever the provider itself would allow.
 */
export async function publishedCommentAuthor(
  db: typeof database,
  unitId: string,
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  const conversationId = publishedCommentId(thread, commentExternalId);
  const [owned] = await db
    .select({ userId: reviewComments.userId })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.unitId, unitId),
        eq(reviewComments.status, "published"),
        conversationId
          ? or(
              eq(reviewComments.providerCommentExternalId, commentExternalId),
              eq(reviewComments.providerExternalId, conversationId),
            )
          : eq(reviewComments.providerCommentExternalId, commentExternalId),
      ),
    )
    .limit(1);
  return owned?.userId;
}

/**
 * Refuses one reviewer's change to a comment ReviewDuck published for another.
 *
 * Editing puts words in their mouth and deleting takes their feedback away,
 * and the provider records neither as anyone but the shared connection.
 */
export async function assertCommentIsTheReviewersToChange(
  db: typeof database,
  userId: string,
  unitId: string,
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  const author = await publishedCommentAuthor(
    db,
    unitId,
    thread,
    commentExternalId,
  );
  if (author && author !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Another reviewer published this comment through ReviewDuck. Only they can change it.",
    });
  }
}

/**
 * Drops the local record of comments that no longer exist at the provider.
 *
 * The ledger of what ReviewDuck published is what marks an AI finding as
 * posted and hides a duplicate of the provider conversation, so a deleted
 * comment has to leave it or the reviewer keeps being told it is still there.
 */
export async function forgetPublishedComments(
  db: typeof database,
  unitId: string,
  gone: {
    commentIds?: readonly (string | undefined)[];
    conversationIds?: readonly (string | undefined)[];
  },
) {
  const conversationIds = [...new Set(gone.conversationIds ?? [])].filter(
    (id): id is string => Boolean(id),
  );
  const commentIds = [...new Set(gone.commentIds ?? [])].filter(
    (id): id is string => Boolean(id),
  );
  // A root comment is recorded against the conversation it opened and a reply
  // against itself, so both keys are given up together.
  const named = [
    ...(conversationIds.length
      ? [inArray(reviewComments.providerExternalId, conversationIds)]
      : []),
    ...(commentIds.length
      ? [inArray(reviewComments.providerCommentExternalId, commentIds)]
      : []),
  ];
  if (named.length === 0) return;
  await db
    .delete(reviewComments)
    .where(and(eq(reviewComments.unitId, unitId), or(...named)));
}
