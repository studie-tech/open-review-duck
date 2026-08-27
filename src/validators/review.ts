import { z } from "zod";
import { SYMBOL_PATTERN } from "~/lib/symbol-peek";
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

export const reviewFileActionSchema = z.object({
  snapshotFileId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  durationSeconds: z.number().int().min(0).max(86_400),
});

export const unreviewFileSchema = reviewFileActionSchema.pick({
  snapshotFileId: true,
  sessionId: true,
});

export const unreviewConceptSchema = signOffConceptSchema.pick({
  conceptId: true,
  layoutId: true,
  layoutVersion: true,
  sessionId: true,
});

/**
 * The most members one layout may place, counted across all of its concepts.
 *
 * A layout partitions the snapshot's atomic units, so its members cannot
 * outnumber them. Capping each array alone lets the two multiply: five
 * thousand concepts of five thousand members is twenty-five million
 * identifiers, and nothing in the shape says they cannot all arrive at once.
 */
export const MAX_CONCEPT_LAYOUT_MEMBERS = 5_000;

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
        memberUnitIds: z
          .array(z.string().uuid())
          .min(1)
          .max(MAX_CONCEPT_LAYOUT_MEMBERS),
      }),
    )
    .min(1)
    .max(MAX_CONCEPT_LAYOUT_MEMBERS)
    .refine(
      (concepts) =>
        concepts.reduce(
          (total, { memberUnitIds }) => total + memberUnitIds.length,
          0,
        ) <= MAX_CONCEPT_LAYOUT_MEMBERS,
      {
        message: `A layout may place at most ${MAX_CONCEPT_LAYOUT_MEMBERS} members`,
      },
    ),
});

export const improveConceptGroupingSchema = z.object({
  pullRequestId: z.string().uuid(),
  layoutId: z.string().uuid(),
  layoutVersion: z.number().int().positive(),
});

/**
 * Names the waits one reviewer is taking back.
 *
 * The units are named rather than the concept they belong to, because a wait
 * has to be releasable from a workspace the pull request has already moved
 * past — the state that most needs the way out.
 */
export const releaseReviewWaitsSchema = z.object({
  unitIds: z.array(z.string().uuid()).min(1).max(1_000),
});

export const importTargetSchema = z.object({
  pullRequestId: z.string().uuid(),
  sourcePath: z.string().trim().min(1).max(2_000),
  sourceLanguage: z.enum(supportedLanguages),
  specifier: z.string().trim().min(1).max(500),
  imported: z.string().trim().min(1).max(255),
  kind: z.enum(["default", "module", "named", "namespace"]),
});

export const symbolDefinitionSchema = z.object({
  pullRequestId: z.string().uuid(),
  sourcePath: z.string().trim().min(1).max(2_000),
  sourceLanguage: z.enum(supportedLanguages),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(new RegExp(SYMBOL_PATTERN), "A symbol lookup names one identifier"),
  // The line the name was read from, so a declaration that already covers it
  // is recognized as the code in front of the reviewer rather than offered.
  line: z.number().int().positive().optional(),
  // Set only when the reviewer's file imports the name: the specifier resolves
  // the definition far more precisely than a repository-wide name can.
  specifier: z.string().trim().min(1).max(500).optional(),
  imported: z.string().trim().min(1).max(255).optional(),
  kind: z.enum(["default", "module", "named", "namespace"]).optional(),
});

/**
 * The mutually exclusive ways one publish request may name AI-authored text.
 *
 * A deep-review finding is a row rather than a position in a job's result
 * array, so it is keyed by id; naming it alongside either index would leave the
 * publisher two disagreeing sources for the same comment body.
 */
const AI_COMMENT_SOURCE_KEYS = [
  "aiFindingIndex",
  "aiCommentIndex",
  "aiFindingId",
] as const;

export const publishReviewCommentSchema = z
  .object({
    unitId: z.string().uuid(),
    line: z.number().int().positive(),
    body: z.string().trim().min(1).max(10_000).optional(),
    aiJobId: z.string().uuid().optional(),
    aiFindingIndex: z.number().int().nonnegative().optional(),
    aiCommentIndex: z.number().int().nonnegative().optional(),
    // `ai_review_finding.id` is a derived varchar, not a uuid, so this is
    // bounded by the column width rather than parsed as one.
    aiFindingId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((value, context) => {
    const namedSources = AI_COMMENT_SOURCE_KEYS.filter(
      (key) => value[key] !== undefined,
    ).length;
    const isAiComment = value.aiJobId !== undefined || namedSources > 0;
    if (isAiComment && (value.aiJobId === undefined || namedSources !== 1)) {
      context.addIssue({
        code: "custom",
        message:
          "AI job and exactly one finding or comment reference must be provided together",
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

export const reviewThreadSchema = z.object({
  unitId: z.string().uuid(),
  threadExternalId: z.string().trim().min(1).max(500),
});

export const resolveReviewThreadSchema = reviewThreadSchema.extend({
  resolved: z.boolean(),
});

export const reviewThreadCommentSchema = reviewThreadSchema.extend({
  commentExternalId: z.string().trim().min(1).max(500),
});

export const editReviewThreadCommentSchema = reviewThreadCommentSchema.extend({
  body: z.string().trim().min(1).max(10_000),
});
