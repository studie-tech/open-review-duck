import "server-only";

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  COMMENT_IMAGE_MAX_BYTES,
  COMMENT_IMAGE_TYPES,
} from "~/lib/comment-images";
import type { db as database } from "~/server/db";
import { providerForReviewerWrite } from "~/server/providers/user-credentials";
import {
  providerScopeForUnit,
  providerThreadError,
} from "~/server/review/provider-thread";
import { enforceRateLimit } from "~/server/security/rate-limit";

export const uploadCommentImageSchema = z.object({
  unitId: z.string().uuid(),
  contentType: z.enum(COMMENT_IMAGE_TYPES),
  base64: z
    .string()
    .min(4)
    .max(Math.ceil(COMMENT_IMAGE_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

/** Authorizes a bounded image upload to the same provider as comment posting. */
export async function uploadCommentImage(
  db: typeof database,
  userId: string,
  input: z.infer<typeof uploadCommentImageSchema>,
) {
  await enforceRateLimit(db, `review-image:${userId}`, 20, 60_000);
  const scope = await providerScopeForUnit(db, userId, input.unitId);
  const bytes = Buffer.from(input.base64, "base64");
  const signature =
    input.contentType === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : input.contentType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : input.contentType === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
  if (!signature || bytes.length > COMMENT_IMAGE_MAX_BYTES)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Paste a PNG, JPEG, GIF, or WebP image no larger than 2 MB.",
    });
  const { provider } = await providerForReviewerWrite(
    db,
    scope.connection,
    userId,
  );
  if (!provider.uploadCommentImage)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Attach the image on the provider and paste its link here.",
    });
  const extension =
    input.contentType === "image/jpeg" ? "jpg" : input.contentType.slice(6);
  try {
    const url = await provider.uploadCommentImage({
      repositoryExternalId: scope.repositoryExternalId,
      pullRequestNumber: scope.pullRequestNumber,
      file: new File([bytes], `image-${randomUUID()}.${extension}`, {
        type: input.contentType,
      }),
    });
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Invalid attachment URL");
    return {
      markdown: `![Image](<${parsed.href.replaceAll(">", "%3E").replaceAll("<", "%3C")}>)`,
    };
  } catch (cause) {
    throw providerThreadError(provider.name, cause);
  }
}
