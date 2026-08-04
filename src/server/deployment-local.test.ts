import { describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    CRON_SECRET: undefined,
    DATABASE_URL: "postgresql://local:local@localhost:5432/local",
    DEPLOYMENT_MODE: "local",
    ENCRYPTION_KEY: "test-encryption-key",
  },
}));

import { assertDeploymentConfigured } from "./deployment";

describe("local deployment configuration", () => {
  it("requires the secret used by the retention maintenance loop", () => {
    expect(() => assertDeploymentConfigured()).toThrow(
      "Local mode is missing required CRON_SECRET",
    );
  });
});
