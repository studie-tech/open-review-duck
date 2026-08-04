import { createPrivateKey } from "node:crypto";
import { normalizeNodePostgresUrl } from "./db/url.js";

/**
 * @typedef {object} DeploymentConfiguration
 * @property {"local" | "saas"} DEPLOYMENT_MODE
 * @property {string} DATABASE_URL
 * @property {string | undefined} [MIGRATION_DATABASE_URL]
 * @property {string | undefined} [ENCRYPTION_KEY]
 * @property {string | undefined} [CRON_SECRET]
 * @property {string | undefined} [APP_URL]
 * @property {string | undefined} [NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY]
 * @property {string | undefined} [CLERK_SECRET_KEY]
 * @property {string | undefined} [CLERK_WEBHOOK_SIGNING_SECRET]
 * @property {string | undefined} [UPLOADTHING_TOKEN]
 * @property {string | undefined} [STORAGE_ID_KEY]
 * @property {string | undefined} [OPENROUTER_MANAGEMENT_KEY]
 * @property {string | undefined} [OPENROUTER_MODEL_ALLOWLIST]
 * @property {number | undefined} [OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD]
 * @property {string | undefined} [GITHUB_APP_ID]
 * @property {string | undefined} [GITHUB_APP_SLUG]
 * @property {string | undefined} [GITHUB_APP_CLIENT_ID]
 * @property {string | undefined} [GITHUB_APP_CLIENT_SECRET]
 * @property {string | undefined} [GITHUB_APP_PRIVATE_KEY]
 * @property {string | undefined} [GITHUB_WEBHOOK_SECRET]
 * @property {string | undefined} [GITLAB_CLIENT_ID]
 * @property {string | undefined} [GITLAB_CLIENT_SECRET]
 * @property {string | undefined} [OAUTH_STATE_SECRET]
 * @property {string | undefined} [SENTRY_DSN]
 * @property {string | undefined} [NEXT_PUBLIC_SENTRY_DSN]
 */

/**
 * Validates configuration shared by build-time deployment checks and runtime
 * initialization.
 *
 * @param {DeploymentConfiguration} configuration
 */
export function validateDeploymentConfiguration(configuration) {
  if (!configuration.ENCRYPTION_KEY) {
    throw new Error("Deployment is missing required ENCRYPTION_KEY");
  }
  if (configuration.DEPLOYMENT_MODE === "local") {
    if (!configuration.CRON_SECRET) {
      throw new Error("Local mode is missing required CRON_SECRET");
    }
    return;
  }
  /** @type {Array<readonly [string, unknown]>} */
  const required = [
    ["APP_URL", configuration.APP_URL],
    ["MIGRATION_DATABASE_URL", configuration.MIGRATION_DATABASE_URL],
    [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      configuration.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    ],
    ["CLERK_SECRET_KEY", configuration.CLERK_SECRET_KEY],
    [
      "CLERK_WEBHOOK_SIGNING_SECRET",
      configuration.CLERK_WEBHOOK_SIGNING_SECRET,
    ],
    ["UPLOADTHING_TOKEN", configuration.UPLOADTHING_TOKEN],
    ["STORAGE_ID_KEY", configuration.STORAGE_ID_KEY],
    ["OPENROUTER_MANAGEMENT_KEY", configuration.OPENROUTER_MANAGEMENT_KEY],
    ["OPENROUTER_MODEL_ALLOWLIST", configuration.OPENROUTER_MODEL_ALLOWLIST],
    [
      "OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD",
      configuration.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD,
    ],
    ["OAUTH_STATE_SECRET", configuration.OAUTH_STATE_SECRET],
    ["GITHUB_APP_ID", configuration.GITHUB_APP_ID],
    ["GITHUB_APP_SLUG", configuration.GITHUB_APP_SLUG],
    ["GITHUB_APP_CLIENT_ID", configuration.GITHUB_APP_CLIENT_ID],
    ["GITHUB_APP_CLIENT_SECRET", configuration.GITHUB_APP_CLIENT_SECRET],
    ["GITHUB_APP_PRIVATE_KEY", configuration.GITHUB_APP_PRIVATE_KEY],
    ["GITHUB_WEBHOOK_SECRET", configuration.GITHUB_WEBHOOK_SECRET],
    ["GITLAB_CLIENT_ID", configuration.GITLAB_CLIENT_ID],
    ["GITLAB_CLIENT_SECRET", configuration.GITLAB_CLIENT_SECRET],
    ["SENTRY_DSN", configuration.SENTRY_DSN],
    ["NEXT_PUBLIC_SENTRY_DSN", configuration.NEXT_PUBLIC_SENTRY_DSN],
    ["CRON_SECRET", configuration.CRON_SECRET],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `SaaS mode is missing required configuration: ${missing.join(", ")}`,
    );
  }
  if (!configuration.MIGRATION_DATABASE_URL || !configuration.APP_URL) {
    throw new Error("SaaS database and application URLs are required");
  }
  const runtimeDatabase = new URL(
    normalizeNodePostgresUrl(configuration.DATABASE_URL),
  );
  const migrationDatabase = new URL(configuration.MIGRATION_DATABASE_URL);
  const migrationPort = migrationDatabase.port || "5432";
  if (runtimeDatabase.port !== "6432" || migrationPort !== "5432") {
    throw new Error(
      "SaaS requires PlanetScale PgBouncer on port 6432 and direct migrations on port 5432",
    );
  }
  if (new URL(configuration.APP_URL).protocol !== "https:") {
    throw new Error("SaaS APP_URL must use HTTPS");
  }
  let githubKey;
  try {
    githubKey = createPrivateKey(
      configuration.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? "",
    );
  } catch (cause) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a readable private key", {
      cause,
    });
  }
  if (githubKey.asymmetricKeyType !== "rsa") {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be an RSA private key");
  }
}
