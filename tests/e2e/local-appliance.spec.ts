import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const container =
  process.env.LOCAL_E2E_CONTAINER ?? "reviewduck-local-playwright";
const baseUrl = process.env.LOCAL_E2E_BASE_URL ?? "http://127.0.0.1:3941";

/** Reads the one-time bootstrap URL without exposing its token in test output. */
function bootstrapUrl() {
  const result = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
  });
  const logs = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = logs.match(
    /http:\/\/localhost:3000\/api\/local\/bootstrap\?token=[^\s]+/,
  );
  if (!match) throw new Error("Local appliance did not print a bootstrap URL");
  return match[0].replace("http://localhost:3000", baseUrl);
}

test("bootstraps local provider setup and preserves the session across restart", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/local\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Authorize this browser" }),
  ).toBeVisible();

  await page.goto(bootstrapUrl());
  await expect(
    page.getByRole("heading", { name: "Good code deserves attention." }),
  ).toBeVisible();

  await page.goto("/settings/providers");
  await expect(
    page.getByRole("heading", { name: "Code providers" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Access tokens are encrypted before they are stored in your local data volume.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add connection" }),
  ).toBeVisible();

  execFileSync("docker", ["restart", container]);
  await expect
    .poll(
      () => {
        try {
          execFileSync("docker", [
            "exec",
            container,
            "curl",
            "--fail",
            "--silent",
            "http://127.0.0.1:3000/api/health",
          ]);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Good code deserves attention." }),
  ).toBeVisible();
  await page.goto("/settings/providers");
  await expect(
    page.getByRole("heading", { name: "Code providers" }),
  ).toBeVisible();
});
