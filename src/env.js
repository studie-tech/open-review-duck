import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { applicationSecretSchema } from "./lib/environment-secret.js";

const environmentSecretSchema =
  process.env.NODE_ENV === "production"
    ? applicationSecretSchema
    : z.string().min(32);

export const env = createEnv({
  /** Server-only configuration validated before application initialization. */
  server: {
    DEPLOYMENT_MODE: z.enum(["local", "saas"]).default("saas"),
    DATABASE_URL: z.string().url(),
    MIGRATION_DATABASE_URL: z.string().url().optional(),
    CLERK_SECRET_KEY: z.string().min(1).optional(),
    ENCRYPTION_KEY: environmentSecretSchema.optional(),
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
    CRON_SECRET: environmentSecretSchema.optional(),
    APP_URL: z.string().url().optional(),
    LOCAL_DATA_DIR: z.string().min(1).default("/data"),
    LOCAL_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    STORAGE_ID_KEY: environmentSecretSchema.optional(),
    UPLOADTHING_TOKEN: z.string().min(1).optional(),
    OPENROUTER_MANAGEMENT_KEY: z.string().min(1).optional(),
    OPENROUTER_MODEL_ALLOWLIST: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !value.includes(","), {
        error: "OPENROUTER_MODEL_ALLOWLIST must contain one model slug",
      })
      .optional(),
    OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD: z.coerce
      .number()
      .positive()
      .optional(),
    BIG_PICKLE_DISCLOSURE_VERSION: z.string().min(1).default("2026-07-29"),
    GITHUB_APP_ID: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/)
      .optional(),
    GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_APP_CLIENT_SECRET: environmentSecretSchema.optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: environmentSecretSchema.optional(),
    GITLAB_CLIENT_ID: z.string().min(1).optional(),
    GITLAB_CLIENT_SECRET: environmentSecretSchema.optional(),
    AZURE_ENTRA_CLIENT_ID: z.string().min(1).optional(),
    AZURE_ENTRA_CLIENT_SECRET: environmentSecretSchema.optional(),
    AZURE_ENTRA_TENANT_ID: z
      .string()
      .regex(
        /^(?:organizations|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
      )
      .default("organizations"),
    OAUTH_STATE_SECRET: environmentSecretSchema.optional(),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
    SOURCE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    SOURCE_RETENTION_SNAPSHOTS: z.coerce.number().int().min(1).default(5),
    MANAGED_AI_DAILY_REQUEST_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(40),
    MANAGED_AI_USER_DAILY_REQUEST_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(100_000),
    MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000_000),
    AI_MAX_MODEL_STEPS: z.coerce.number().int().min(9).max(64).default(64),
    AI_MAX_TOOL_CALLS: z.coerce.number().int().min(32).max(256).default(256),
    AI_MAX_DISTINCT_FILES: z.coerce
      .number()
      .int()
      .min(16)
      .max(200)
      .default(200),
    AI_MAX_SOURCE_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(8_388_608)
      .default(8_388_608),
    AI_MAX_DURATION_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(1_800_000)
      .default(1_800_000),
    ALLOW_PRIVATE_PROVIDER_HOSTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ALLOW_PRIVATE_AI_HOSTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /** Public build-time configuration safe to expose to browser bundles. */
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
    NEXT_PUBLIC_DEPLOYMENT_MODE: z.enum(["local", "saas"]).optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  },

  /** Explicit environment mapping compatible with Node, Edge, and browser builds. */
  runtimeEnv: {
    DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE,
    DATABASE_URL: process.env.DATABASE_URL,
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    APP_URL: process.env.APP_URL,
    LOCAL_DATA_DIR: process.env.LOCAL_DATA_DIR,
    LOCAL_SESSION_TTL_DAYS: process.env.LOCAL_SESSION_TTL_DAYS,
    STORAGE_ID_KEY: process.env.STORAGE_ID_KEY,
    UPLOADTHING_TOKEN: process.env.UPLOADTHING_TOKEN,
    OPENROUTER_MANAGEMENT_KEY: process.env.OPENROUTER_MANAGEMENT_KEY,
    OPENROUTER_MODEL_ALLOWLIST: process.env.OPENROUTER_MODEL_ALLOWLIST,
    OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD:
      process.env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD,
    BIG_PICKLE_DISCLOSURE_VERSION: process.env.BIG_PICKLE_DISCLOSURE_VERSION,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITLAB_CLIENT_ID: process.env.GITLAB_CLIENT_ID,
    GITLAB_CLIENT_SECRET: process.env.GITLAB_CLIENT_SECRET,
    AZURE_ENTRA_CLIENT_ID: process.env.AZURE_ENTRA_CLIENT_ID,
    AZURE_ENTRA_CLIENT_SECRET: process.env.AZURE_ENTRA_CLIENT_SECRET,
    AZURE_ENTRA_TENANT_ID: process.env.AZURE_ENTRA_TENANT_ID,
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
    SOURCE_RETENTION_DAYS: process.env.SOURCE_RETENTION_DAYS,
    SOURCE_RETENTION_SNAPSHOTS: process.env.SOURCE_RETENTION_SNAPSHOTS,
    MANAGED_AI_DAILY_REQUEST_LIMIT: process.env.MANAGED_AI_DAILY_REQUEST_LIMIT,
    MANAGED_AI_USER_DAILY_REQUEST_LIMIT:
      process.env.MANAGED_AI_USER_DAILY_REQUEST_LIMIT,
    MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT:
      process.env.MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT,
    MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT:
      process.env.MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT,
    AI_MAX_MODEL_STEPS: process.env.AI_MAX_MODEL_STEPS,
    AI_MAX_TOOL_CALLS: process.env.AI_MAX_TOOL_CALLS,
    AI_MAX_DISTINCT_FILES: process.env.AI_MAX_DISTINCT_FILES,
    AI_MAX_SOURCE_BYTES: process.env.AI_MAX_SOURCE_BYTES,
    AI_MAX_DURATION_MS: process.env.AI_MAX_DURATION_MS,
    ALLOW_PRIVATE_PROVIDER_HOSTS: process.env.ALLOW_PRIVATE_PROVIDER_HOSTS,
    ALLOW_PRIVATE_AI_HOSTS: process.env.ALLOW_PRIVATE_AI_HOSTS,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_DEPLOYMENT_MODE: process.env.NEXT_PUBLIC_DEPLOYMENT_MODE,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  },
  /** Compilation-only CI may bypass runtime secret validation. */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /** Optional variables treat empty deployment fields as absent. */
  emptyStringAsUndefined: true,
});
