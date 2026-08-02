import "server-only";

import { env } from "~/env";
import type { DeploymentMode } from "~/lib/deployment";

/** Returns the explicitly configured application deployment mode. */
export function deploymentMode(): DeploymentMode {
  return env.DEPLOYMENT_MODE;
}

/** Returns whether this process is a trusted, single-user local installation. */
export function isLocalDeployment() {
  return deploymentMode() === "local";
}

/** Fails early when SaaS mode is missing mandatory platform configuration. */
export function assertSaasConfigured() {
  if (isLocalDeployment()) return;
  const missing = [
    ["APP_URL", env.APP_URL],
    ["MIGRATION_DATABASE_URL", env.MIGRATION_DATABASE_URL],
    [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    ],
    ["CLERK_SECRET_KEY", env.CLERK_SECRET_KEY],
    ["CLERK_WEBHOOK_SIGNING_SECRET", env.CLERK_WEBHOOK_SIGNING_SECRET],
    ["UPLOADTHING_TOKEN", env.UPLOADTHING_TOKEN],
    ["STORAGE_ID_KEY", env.STORAGE_ID_KEY],
    ["KMS_KEY_ID", env.KMS_KEY_ID],
    ["AWS_KMS_ROLE_ARN", env.AWS_KMS_ROLE_ARN],
    ["OPENCODE_API_KEY", env.OPENCODE_API_KEY],
    ["OPENROUTER_MANAGEMENT_KEY", env.OPENROUTER_MANAGEMENT_KEY],
    ["OPENROUTER_MODEL_ALLOWLIST", env.OPENROUTER_MODEL_ALLOWLIST],
    [
      "OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD",
      env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD,
    ],
    ["OAUTH_STATE_SECRET", env.OAUTH_STATE_SECRET],
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_APP_SLUG", env.GITHUB_APP_SLUG],
    ["GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY],
    ["GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET],
    ["GITLAB_CLIENT_ID", env.GITLAB_CLIENT_ID],
    ["GITLAB_CLIENT_SECRET", env.GITLAB_CLIENT_SECRET],
    ["GITLAB_WEBHOOK_SECRET", env.GITLAB_WEBHOOK_SECRET],
    ["AZURE_ENTRA_CLIENT_ID", env.AZURE_ENTRA_CLIENT_ID],
    ["AZURE_ENTRA_CLIENT_SECRET", env.AZURE_ENTRA_CLIENT_SECRET],
    ["AZURE_WEBHOOK_SECRET", env.AZURE_WEBHOOK_SECRET],
    ["CRON_SECRET", env.CRON_SECRET],
    ["SENTRY_DSN", env.SENTRY_DSN],
    ["NEXT_PUBLIC_SENTRY_DSN", env.NEXT_PUBLIC_SENTRY_DSN],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `SaaS mode is missing required configuration: ${missing.join(", ")}`,
    );
  }
  if (!env.MIGRATION_DATABASE_URL || !env.APP_URL) {
    throw new Error("SaaS database and application URLs are required");
  }
  const runtimeDatabase = new URL(env.DATABASE_URL);
  const migrationDatabase = new URL(env.MIGRATION_DATABASE_URL);
  if (runtimeDatabase.port !== "6432" || migrationDatabase.port !== "5432") {
    throw new Error(
      "SaaS requires PlanetScale PgBouncer on port 6432 and direct migrations on port 5432",
    );
  }
  if (new URL(env.APP_URL).protocol !== "https:") {
    throw new Error("SaaS APP_URL must use HTTPS");
  }
  if (env.KMS_REGION !== "eu-central-1") {
    throw new Error("SaaS KMS must be colocated in eu-central-1");
  }
}
