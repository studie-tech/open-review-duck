import { z } from "zod";

export const aiProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const aiProtocolSchema = z.enum([
  "openai-responses",
  "openai-completions",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
]);
export type AiProtocol = z.infer<typeof aiProtocolSchema>;

const headerValueSchema = z.string().min(1).max(2_000);
export const aiHeadersSchema = z
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
  apiProtocol: aiProtocolSchema,
  apiKey: z.string().trim().min(1).optional(),
  headers: aiHeadersSchema.default({}),
  baseUrl: z.string().url().optional(),
  contextWindow: z.number().int().min(1_024).max(10_000_000),
  maxTokens: z.number().int().min(16).max(1_000_000),
  storeResponses: z.boolean(),
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

export const saveAiConfigurationSchema = aiConfigurationSchema
  .extend({ verificationToken: z.string().min(1).max(2_000).optional() })
  .superRefine(validateProviderUrl);

export const startAiJobSchema = z.discriminatedUnion("kind", [
  z
    .object({
      pullRequestId: z.string().uuid(),
      unitId: z.string().uuid(),
      kind: z.literal("explain"),
    })
    .strict(),
  z
    .object({
      pullRequestId: z.string().uuid(),
      kind: z.literal("review"),
    })
    .strict(),
]);

export const startPendingExplanationsSchema = z
  .object({
    pullRequestId: z.string().uuid(),
    unitIds: z.array(z.string().uuid()).min(1).max(2_000),
  })
  .strict();

export const aiJobLookupSchema = z.object({
  pullRequestId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
});

export const aiResultSchema = z.object({
  summary: z.string().min(1).max(20_000),
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
