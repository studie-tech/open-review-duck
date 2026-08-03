import { beforeAll, describe, expect, it, vi } from "vitest";

const { configuration } = vi.hoisted(() => ({
  configuration: {
    DEPLOYMENT_MODE: "saas",
    ENCRYPTION_KEY: "test-encryption-key",
    APP_URL: "https://reviewduck.example",
    DATABASE_URL: "postgresql://user:password@db.pg.psdb.cloud:5432/postgres",
    MIGRATION_DATABASE_URL:
      "postgresql://user:password@db.pg.psdb.cloud/postgres",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test",
    CLERK_SECRET_KEY: "sk_test",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
    UPLOADTHING_TOKEN: "uploadthing-test",
    STORAGE_ID_KEY: "storage-test",
    OPENROUTER_MANAGEMENT_KEY: "openrouter-management-test",
    OPENROUTER_MODEL_ALLOWLIST: "openai/gpt-test",
    OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD: 20,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "reviewduck-test",
    GITHUB_APP_PRIVATE_KEY: "private-key-test",
    GITHUB_WEBHOOK_SECRET: "github-webhook-test",
    GITLAB_CLIENT_ID: "gitlab-client-test",
    GITLAB_CLIENT_SECRET: "gitlab-secret-test",
    AZURE_ENTRA_CLIENT_ID: "azure-client-test",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  } as Record<string, unknown>,
}));

vi.mock("~/env", () => ({ env: configuration }));
vi.mock("node:crypto", () => ({
  createPrivateKey: () => ({ asymmetricKeyType: "rsa" }),
}));

import { assertDeploymentConfigured } from "./deployment";

describe("deployment configuration", () => {
  beforeAll(() => {
    Object.assign(configuration, {
      OPENCODE_API_KEY: undefined,
      OAUTH_STATE_SECRET: undefined,
      GITHUB_APP_CLIENT_ID: undefined,
      GITHUB_APP_CLIENT_SECRET: undefined,
      AZURE_ENTRA_CLIENT_SECRET: undefined,
      CRON_SECRET: undefined,
    });
  });

  it("still rejects missing baseline application configuration", () => {
    const uploadToken = configuration.UPLOADTHING_TOKEN;
    configuration.UPLOADTHING_TOKEN = undefined;
    expect(() => assertDeploymentConfigured()).toThrow(
      "SaaS mode is missing required configuration: UPLOADTHING_TOKEN",
    );
    configuration.UPLOADTHING_TOKEN = uploadToken;
  });

  it("allows feature-specific integrations to remain unconfigured", () => {
    expect(() => assertDeploymentConfigured()).not.toThrow();
  });
});
