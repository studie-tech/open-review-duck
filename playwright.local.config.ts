import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "local-appliance.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.LOCAL_E2E_BASE_URL ?? "http://127.0.0.1:3941",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
