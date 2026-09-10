import "server-only";

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { aiJobs, reviewComments } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import {
  claimCommentForPublicationRetry,
  findEquivalentUserComment,
  providerCommentBody,
  publicationAttemptKey,
  publishedThreadForComment,
} from "~/server/review/comments";
import { deepReviewFindingForPublication } from "~/server/review/deep/payload";
import {
  providerScopeForUnit,
  reviewUnitContainsLine,
} from "~/server/review/provider-thread";
import { providerSyncErrorMessage } from "~/server/sync/error";
import type { publishReviewCommentSchema } from "~/validators/review";

type Database = typeof database;
type PublishReviewCommentInput = z.infer<typeof publishReviewCommentSchema>;

/**
 * Posts one review comment to the provider and records it on the unit.
 *
 * The tRPC mutation and automatic deep-review publishing share this path so a
 * finding the reviewer posts by hand and one the preference posts after a run
 * leave the same ledger row.
 */
export async function publishReviewComment(
  db: Database,
  userId: string,
  input: PublishReviewCommentInput,
) {
  const scope = await providerScopeForUnit(
    db,
    userId,
    input.unitId,
    "Synchronize the pull request before publishing a comment",
  );
  if (!reviewUnitContainsLine(scope, input.line)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The selected line is outside this review unit",
    });
  }

  let body = input.body;
  let source: "user" | "ai" = "user";
  let aiResultIndex = input.aiFindingIndex ?? input.aiCommentIndex;
  if (
    input.aiJobId !== undefined &&
    (aiResultIndex !== undefined || input.aiFindingId !== undefined)
  ) {
    source = "ai";
    const job = await db.query.aiJobs.findFirst({
      where: and(
        eq(aiJobs.id, input.aiJobId),
        eq(aiJobs.userId, userId),
        eq(aiJobs.pullRequestId, scope.pullRequestId),
        eq(aiJobs.snapshotId, scope.snapshotId),
        eq(aiJobs.status, "completed"),
      ),
    });
    if (input.aiFindingId !== undefined) {
      // Authorization is the job lookup above, unchanged; the row
      // predicates below only establish that the finding still describes
      // this line.
      if (job?.kind !== "review" || job.parentJobId !== null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This AI finding does not belong to the selected review",
        });
      }
      const finding = await deepReviewFindingForPublication(db, {
        findingId: input.aiFindingId,
        parentJobId: job.id,
        path: scope.path,
        line: input.line,
      });
      body = finding.body;
      aiResultIndex = finding.orderIndex;
    } else if (input.aiFindingIndex !== undefined) {
      const finding = job?.result?.findings[input.aiFindingIndex];
      if (
        job?.kind !== "review" ||
        !finding ||
        finding.path !== scope.path ||
        finding.line !== input.line
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This AI finding no longer matches the selected code",
        });
      }
      body = `**${finding.title}**\n\n${finding.body}`;
    } else {
      const proposal =
        job?.result?.commentProposals?.[input.aiCommentIndex ?? -1];
      if (
        job?.kind !== "explain" ||
        !job.question ||
        !proposal ||
        proposal.path !== scope.path ||
        proposal.line !== input.line
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This AI comment proposal no longer matches the selected code",
        });
      }
      body = input.body ?? proposal.body;
    }
  }
  if (!body) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Comment text is required",
    });
  }

  let retryingPublication = false;
  let comment =
    source === "user"
      ? await findEquivalentUserComment(db, {
          unitId: scope.unitId,
          userId,
          body,
          line: input.line,
        })
      : undefined;
  const equivalentUserCommentFound = comment !== undefined;
  if (comment?.status === "published") return comment;
  if (comment?.status === "failed" || comment?.status === "publishing") {
    comment = await claimCommentForPublicationRetry(db, comment.id);
    retryingPublication = comment !== undefined;
  }
  if (!comment && !equivalentUserCommentFound) {
    const publicationLeaseToken = randomUUID();
    [comment] = await db
      .insert(reviewComments)
      .values({
        unitId: scope.unitId,
        userId,
        aiJobId: input.aiJobId,
        aiFindingIndex: aiResultIndex,
        source,
        body,
        line: input.line,
        status: "publishing",
        publicationLeaseToken,
      })
      .onConflictDoNothing()
      .returning();
  }
  if (!comment) {
    comment =
      input.aiJobId !== undefined
        ? await db.query.reviewComments.findFirst({
            where: and(
              eq(reviewComments.aiJobId, input.aiJobId),
              eq(reviewComments.aiFindingIndex, aiResultIndex ?? -1),
            ),
          })
        : undefined;
    if (comment?.status === "published") return comment;
    if (comment?.status === "failed" || comment?.status === "publishing") {
      comment = await claimCommentForPublicationRetry(db, comment.id);
      retryingPublication = comment !== undefined;
    }
  }
  if (!comment) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This comment is already being published",
    });
  }
  if (!comment.publicationLeaseToken) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This comment publication lease is unavailable",
    });
  }
  const publicationLeaseToken = comment.publicationLeaseToken;

  try {
    const provider = await providerForConnection(db, scope.connection);
    const existingThread = retryingPublication
      ? publishedThreadForComment(
          await provider.listInlineCommentThreads(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          comment.id,
        )
      : undefined;
    const published = existingThread
      ? { externalId: existingThread.externalId }
      : await provider.publishInlineComment({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
          path: scope.path,
          line: input.line,
          side: scope.changeType === "deleted" ? "left" : "right",
          body: providerCommentBody(body, comment.id),
          idempotencyKey: publicationAttemptKey(comment.id),
        });
    const [updated] = await db
      .update(reviewComments)
      .set({
        status: "published",
        providerExternalId: published.externalId,
        publicationLeaseToken: null,
        error: null,
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(reviewComments.id, comment.id),
          eq(reviewComments.status, "publishing"),
          eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Comment publication lease was superseded");
    }
    return updated;
  } catch (cause) {
    const message = providerSyncErrorMessage(scope.connection.provider, cause);
    await db
      .update(reviewComments)
      .set({
        status: "failed",
        publicationLeaseToken: null,
        error: message,
      })
      .where(
        and(
          eq(reviewComments.id, comment.id),
          eq(reviewComments.status, "publishing"),
          eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
        ),
      );
    throw new TRPCError({
      code: "BAD_REQUEST",
      message,
      cause,
    });
  }
}
