import { z } from "zod";

const aiProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

const headerValueSchema = z.string().min(1).max(2_000);
const aiHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
    headerValueSchema,
  )
  .refine((headers) => Object.keys(headers).length <= 32, {
    message: "At most 32 custom headers are allowed",
  });

const aiConfigurationSchema = z.object({
  provider: aiProviderSchema,
  model: z.string().trim().min(1).max(160),
  apiKey: z.string().trim().min(1).optional(),
  clearApiKey: z.boolean().default(false),
  clearHeaders: z.boolean().default(false),
  headers: aiHeadersSchema.default({}),
  baseUrl: z.string().url().optional(),
  useManagedModels: z.boolean(),
  mode: z.enum(["off", "on_demand", "automatic"]),
  reviewPullRequests: z.boolean(),
});

/** Validates an optional provider URL against the selected AI protocol. */
function validateProviderUrl(
  value: z.infer<typeof aiConfigurationSchema>,
  context: z.RefinementCtx,
) {
  if (
    !value.useManagedModels &&
    !value.baseUrl &&
    !["openai", "anthropic", "openrouter", "google", "mistral"].includes(
      value.provider,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "Custom providers require a base URL",
    });
  }
}

export const testAiConfigurationSchema = aiConfigurationSchema
  .extend({ useManagedModels: z.literal(false) })
  .superRefine(validateProviderUrl);

export const saveAiConfigurationSchema =
  aiConfigurationSchema.superRefine(validateProviderUrl);

export const startAiJobSchema = z.discriminatedUnion("kind", [
  z
    .object({
      pullRequestId: z.string().uuid(),
      unitId: z.string().uuid(),
      kind: z.literal("explain"),
      question: z.string().trim().min(1).max(4_000).optional(),
      focusLine: z.number().int().positive().optional(),
      threadId: z.string().uuid().optional(),
    })
    .superRefine((input, context) => {
      if (
        Boolean(input.question) !== Boolean(input.focusLine) ||
        Boolean(input.question) !== Boolean(input.threadId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Questions must identify one focused source line and conversation",
        });
      }
    })
    .strict(),
  z
    .object({
      pullRequestId: z.string().uuid(),
      kind: z.literal("review"),
    })
    .strict(),
]);

export const aiJobLookupSchema = z.object({
  pullRequestId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
});

export const deleteAiQuestionThreadSchema = z.object({
  pullRequestId: z.string().uuid(),
  unitId: z.string().uuid(),
  jobIds: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "AI conversation jobs must be unique",
    }),
});

export const aiResultSchema = z.object({
  summary: z.string().min(1).max(20_000),
  commentProposals: z
    .array(
      z.object({
        body: z.string().min(1).max(10_000),
        path: z.string().min(1).max(2_000),
        line: z.number().int().positive(),
      }),
    )
    .max(3)
    .default([]),
  annotations: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(2_000),
        path: z.string().min(1).max(2_000),
        line: z.number().int().positive(),
        endLine: z.number().int().positive().optional(),
      }),
    )
    .max(20)
    .default([]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["info", "warning", "critical"]),
        title: z.string().min(1).max(300),
        body: z.string().min(1).max(10_000),
        path: z.string().min(1).max(2_000).optional(),
        line: z.number().int().positive().optional(),
      }),
    )
    .max(100),
});
