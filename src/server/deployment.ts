import "server-only";

import { createPrivateKey } from "node:crypto";
import { env } from "~/env";
import type { DeploymentMode } from "~/lib/deployment";
import { normalizeNodePostgresUrl } from "./db/url";

let deploymentConfigurationValidated = false;

/** Returns the explicitly configured application deployment mode. */
export function deploymentMode(): DeploymentMode {
  return env.DEPLOYMENT_MODE;
}

/** Returns whether this process is a trusted, single-user local installation. */
export function isLocalDeployment() {
  return deploymentMode() === "local";
}

/** Fails early when the selected deployment is missing mandatory configuration. */
export function assertDeploymentConfigured() {
  if (deploymentConfigurationValidated) return;
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Deployment is missing required ENCRYPTION_KEY");
  }
  if (isLocalDeployment()) {
    deploymentConfigurationValidated = true;
    return;
  }
  // Feature-specific credentials are validated by the routes and services that use them.
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
    ["OPENROUTER_MANAGEMENT_KEY", env.OPENROUTER_MANAGEMENT_KEY],
    ["OPENROUTER_MODEL_ALLOWLIST", env.OPENROUTER_MODEL_ALLOWLIST],
    [
      "OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD",
      env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD,
    ],
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_APP_SLUG", env.GITHUB_APP_SLUG],
    ["GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY],
    ["GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET],
    ["GITLAB_CLIENT_ID", env.GITLAB_CLIENT_ID],
    ["GITLAB_CLIENT_SECRET", env.GITLAB_CLIENT_SECRET],
    ["AZURE_ENTRA_CLIENT_ID", env.AZURE_ENTRA_CLIENT_ID],
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
  const runtimeDatabase = new URL(normalizeNodePostgresUrl(env.DATABASE_URL));
  const migrationDatabase = new URL(env.MIGRATION_DATABASE_URL);
  const migrationPort = migrationDatabase.port || "5432";
  if (runtimeDatabase.port !== "6432" || migrationPort !== "5432") {
    throw new Error(
      "SaaS requires PlanetScale PgBouncer on port 6432 and direct migrations on port 5432",
    );
  }
  if (new URL(env.APP_URL).protocol !== "https:") {
    throw new Error("SaaS APP_URL must use HTTPS");
  }
  let githubKey: ReturnType<typeof createPrivateKey>;
  try {
    githubKey = createPrivateKey(
      env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? "",
    );
  } catch (cause) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a readable private key", {
      cause,
    });
  }
  if (githubKey.asymmetricKeyType !== "rsa") {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be an RSA private key");
  }
  deploymentConfigurationValidated = true;
}
