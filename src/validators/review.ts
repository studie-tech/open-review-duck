import { z } from "zod";
import { supportedLanguages } from "~/server/analysis/types";

export const syncPullRequestSchema = z.object({
  repositoryId: z.string().uuid(),
  number: z.number().int().positive(),
});

export const signOffSchema = z.object({
  unitId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  note: z.string().trim().max(4_000).optional(),
  durationSeconds: z.number().int().min(0).max(86_400),
});
export type SignOffInput = z.infer<typeof signOffSchema>;

export const signOffBatchSchema = z.object({
  signOffs: z
    .array(signOffSchema)
    .min(2)
    .max(20)
    .refine(
      (entries) =>
        new Set(entries.map(({ unitId }) => unitId)).size === entries.length,
      "A sign-off batch cannot contain the same unit twice",
    ),
});

export const reviewWorkspaceSchema = z.object({
  pullRequestId: z.string().uuid(),
});

export const providerReviewDecisionSchema = reviewWorkspaceSchema.extend({
  action: z.enum(["approve", "request_changes", "clear"]),
  body: z.string().trim().max(10_000).optional(),
});

export const reviewUnitSchema = z.object({
  unitId: z.string().uuid(),
});

export const unreviewSchema = reviewUnitSchema.extend({
  sessionId: z.string().uuid().optional(),
});

export const signOffConceptSchema = z.object({
  conceptId: z.string().uuid(),
  layoutId: z.string().uuid(),
  layoutVersion: z.number().int().positive(),
  sessionId: z.string().uuid().optional(),
  note: z.string().trim().max(4_000).optional(),
  durationSeconds: z.number().int().min(0).max(86_400),
});

export const unreviewConceptSchema = signOffConceptSchema.pick({
  conceptId: true,
  layoutId: true,
  layoutVersion: true,
  sessionId: true,
});

export const replacePersonalConceptLayoutSchema = z.object({
  pullRequestId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  source: z.enum(["manual", "ai"]),
  concepts: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        rationale: z.string().trim().max(1_000).optional(),
        memberUnitIds: z.array(z.string().uuid()).min(1).max(5_000),
      }),
    )
    .min(1)
    .max(5_000),
});

export const improveConceptGroupingSchema = z.object({
  pullRequestId: z.string().uuid(),
  layoutId: z.string().uuid(),
  layoutVersion: z.number().int().positive(),
});

export const awaitResponseSchema = reviewUnitSchema;

export const importTargetSchema = z.object({
  pullRequestId: z.string().uuid(),
  sourcePath: z.string().trim().min(1).max(2_000),
  sourceLanguage: z.enum(supportedLanguages),
  specifier: z.string().trim().min(1).max(500),
  imported: z.string().trim().min(1).max(255),
  kind: z.enum(["default", "module", "named", "namespace"]),
});

export const publishReviewCommentSchema = z
  .object({
    unitId: z.string().uuid(),
    line: z.number().int().positive(),
    body: z.string().trim().min(1).max(10_000).optional(),
    aiJobId: z.string().uuid().optional(),
    aiFindingIndex: z.number().int().nonnegative().optional(),
    aiCommentIndex: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    const hasAiIndex =
      value.aiFindingIndex !== undefined || value.aiCommentIndex !== undefined;
    const isAiComment = value.aiJobId !== undefined || hasAiIndex;
    if (
      isAiComment &&
      (value.aiJobId === undefined ||
        !hasAiIndex ||
        (value.aiFindingIndex !== undefined &&
          value.aiCommentIndex !== undefined))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "AI job and exactly one finding or comment index must be provided together",
      });
    }
    if (!isAiComment && !value.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Comment text is required",
      });
    }
  });

export const replyToReviewThreadSchema = z.object({
  unitId: z.string().uuid(),
  threadExternalId: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000),
});
