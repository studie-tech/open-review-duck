import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const container =
  process.env.LOCAL_E2E_CONTAINER ?? "reviewduck-local-playwright";
const baseUrl = process.env.LOCAL_E2E_BASE_URL ?? "http://127.0.0.1:3941";

/** Reads one-time bootstrap URLs without exposing their tokens in test output. */
function bootstrapUrls() {
  const result = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
  });
  const logs = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return Array.from(
    logs.matchAll(
      /http:\/\/localhost:3000\/api\/local\/bootstrap\?token=[^\s]+/g,
    ),
    (match) => match[0].replace("http://localhost:3000", baseUrl),
  );
}

/** Reads the newest one-time bootstrap URL from the appliance logs. */
function bootstrapUrl() {
  const urls = bootstrapUrls();
  const url = urls.at(-1);
  if (!url) throw new Error("Local appliance did not print a bootstrap URL");
  return url;
}

test("bootstraps local provider setup and preserves the session across restart", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/local\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Authorize this browser" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "docker exec --tty <container-name> reviewduck-local admin bootstrap",
    ),
  ).toBeVisible();

  await page.goto(bootstrapUrl());
  await expect(
    page.getByRole("heading", { name: "Choose where to focus." }),
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
    page.getByRole("heading", { name: "Connect your first code provider" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();

  const bootstrapCountBeforeRestart = bootstrapUrls().length;
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
  expect(bootstrapUrls()).toHaveLength(bootstrapCountBeforeRestart);

  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Choose where to focus." }),
  ).toBeVisible();
  await page.goto("/settings/providers");
  await expect(
    page.getByRole("heading", { name: "Code providers" }),
  ).toBeVisible();
});
