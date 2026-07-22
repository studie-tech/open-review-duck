import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { applicationSecretSchema } from "./lib/environment-secret.js";

const environmentSecretSchema =
  process.env.NODE_ENV === "production"
    ? applicationSecretSchema
    : z.string().min(32);

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DEPLOYMENT_MODE: z
      .enum(["local", "authenticated"])
      .default("authenticated"),
    DATABASE_URL: z.string().url(),
    CLERK_SECRET_KEY: z.string().min(1).optional(),
    ENCRYPTION_KEY: environmentSecretSchema,
    ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .default("primary"),
    ENCRYPTION_PREVIOUS_KEYS: z.string().default("{}"),
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
    FLUE_BASE_URL: z.string().url(),
    FLUE_INTERNAL_SECRET: environmentSecretSchema,
    CRON_SECRET: environmentSecretSchema.optional(),
    SOURCE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    SOURCE_RETENTION_SNAPSHOTS: z.coerce.number().int().min(1).default(5),
    MANAGED_AI_DAILY_REQUEST_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(40),
    MANAGED_AI_WEEKLY_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(250_000),
    MANAGED_AI_MODEL: z.string().min(1).default("gpt-5-mini"),
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

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE,
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    ENCRYPTION_KEY_ID: process.env.ENCRYPTION_KEY_ID,
    ENCRYPTION_PREVIOUS_KEYS: process.env.ENCRYPTION_PREVIOUS_KEYS,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    FLUE_BASE_URL: process.env.FLUE_BASE_URL,
    FLUE_INTERNAL_SECRET: process.env.FLUE_INTERNAL_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    SOURCE_RETENTION_DAYS: process.env.SOURCE_RETENTION_DAYS,
    SOURCE_RETENTION_SNAPSHOTS: process.env.SOURCE_RETENTION_SNAPSHOTS,
    MANAGED_AI_DAILY_REQUEST_LIMIT: process.env.MANAGED_AI_DAILY_REQUEST_LIMIT,
    MANAGED_AI_WEEKLY_TOKEN_LIMIT: process.env.MANAGED_AI_WEEKLY_TOKEN_LIMIT,
    MANAGED_AI_MODEL: process.env.MANAGED_AI_MODEL,
    ALLOW_PRIVATE_PROVIDER_HOSTS: process.env.ALLOW_PRIVATE_PROVIDER_HOSTS,
    ALLOW_PRIVATE_AI_HOSTS: process.env.ALLOW_PRIVATE_AI_HOSTS,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for compilation-only CI builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
