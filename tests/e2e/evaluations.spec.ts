import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../src/server/api/root";

const baseURL = process.env.EVAL_E2E_BASE_URL ?? "http://localhost:3677";
const providerURL = process.env.EVAL_E2E_PROVIDER_URL;
const screenshots = path.resolve("docs/evaluations/screenshots");

/** Captures settled UI from the top so fixed navigation stays in its correct place. */
async function captureScreenshot(page: Page, filename: string) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await page.screenshot({
    path: path.join(screenshots, filename),
    fullPage: true,
    animations: "disabled",
    style: "nextjs-portal { visibility: hidden; }",
  });
}

test("curates cases, runs both stages, compares snapshots and handles failure", async ({
  page,
  context,
}) => {
  test.skip(
    !providerURL,
    "Requires an isolated local app and deterministic QA provider; see docs/evaluations/README.md",
  );
  expect(process.env.DEPLOYMENT_MODE).toBe("local");
  const bootstrap = execFileSync(
    process.execPath,
    ["scripts/local-bootstrap.mjs"],
    { encoding: "utf8", env: { ...process.env, PORT: new URL(baseURL).port } },
  );
  const url = bootstrap.match(
    /http:\/\/localhost:\d+\/api\/local\/bootstrap\?token=\S+/,
  )?.[0];
  if (!url) throw new Error("Bootstrap URL not found");
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Choose where to focus." }),
  ).toBeVisible();
  const cookies = await context.cookies();
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseURL}/api/trpc`,
        transformer: superjson,
        headers: {
          cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        },
      }),
    ],
  });
  await client.ai.saveConfiguration.mutate({
    provider: "openai_compatible",
    model: "reviewduck-eval-fixture",
    baseUrl: providerURL,
    useManagedModels: false,
    mode: "on_demand",
    reviewPullRequests: false,
    autoPublishFindings: false,
  });
  await mkdir(screenshots, { recursive: true });
  await page.goto("/evaluations");
  await expect(
    page.getByRole("heading", { name: "Reviewer lab" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  const datasetName = "Correctness regression suite";
  await page.getByLabel("Dataset name").fill(datasetName);
  await page
    .getByRole("button", { name: "Create dataset", exact: true })
    .click();
  await expect(page.getByLabel("Dataset", { exact: true })).toContainText(
    datasetName,
  );
  await expect(
    page.getByRole("button", { name: "Create dataset", exact: true }),
  ).toHaveCount(0);
  const selected = await page
    .getByLabel("Dataset", { exact: true })
    .inputValue();
  const examples = [
    {
      title: "Null user crashes the profile route",
      path: "src/auth/profile.ts",
      source:
        "export function displayName(user: User | null) {\n  return user.name.trim();\n}",
      finding:
        "A null user is dereferenced before a guard, crashing anonymous profile requests.",
      label: "bug",
      rationale:
        "Anonymous requests pass null. A null check is required before reading name.",
    },
    {
      title: "Zero-count average produces Infinity",
      path: "src/metrics/average.ts",
      source:
        "export function average(total: number, count: number) {\n  return total / count;\n}",
      finding: "An empty sample divides by zero and returns Infinity.",
      label: "bug",
      rationale: "The count can be zero before the first event arrives.",
    },
    {
      title: "Existing null guard makes this a false alarm",
      path: "src/auth/guarded-profile.ts",
      source:
        "export function displayName(user: User | null) {\n  if (!user) return 'Anonymous';\n  return user.name.trim();\n}",
      finding: "The reviewer claims a null user can reach user.name.",
      label: "false_positive",
      rationale:
        "The early return narrows user before the property access. This is already safe.",
    },
    {
      title: "Clamped denominator cannot divide by zero",
      path: "src/metrics/safe-average.ts",
      source:
        "export function average(total: number, count: number) {\n  return total / Math.max(1, count);\n}",
      finding: "The reviewer claims an empty sample divides by zero.",
      label: "false_positive",
      rationale: "Math.max guarantees a denominator of at least one.",
    },
  ] as const;
  for (const [index, example] of examples.entries()) {
    await page.getByRole("button", { name: "Add case", exact: true }).click();
    await page.getByLabel("Case title").fill(example.title);
    await page.getByLabel("File path").fill(example.path);
    await page.getByLabel("Ground-truth label").selectOption(example.label);
    await page.getByLabel("Finding or missed bug").fill(example.finding);
    await page.getByLabel("Why is this label correct?").fill(example.rationale);
    await page.getByLabel("Frozen source code").fill(example.source);
    if (index === 2) await captureScreenshot(page, "02-case-editor.png");
    await page.getByRole("button", { name: "Save case", exact: true }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${example.title}`) }),
    ).toBeVisible();
  }
  await client.evaluations.saveCase.mutate({
    datasetId: selected,
    example: {
      ...examples[0],
      title: "Holdout: missing customer guard",
      split: "holdout",
    },
  });
  await client.evaluations.saveCase.mutate({
    datasetId: selected,
    example: {
      ...examples[0],
      title: "Needs triage: session expiration edge case",
      label: "unlabeled",
    },
  });
  await page.reload();
  await page.getByLabel("Dataset", { exact: true }).selectOption(selected);
  await expect(
    page.getByText("3 real bugs · 2 false positives · 1 need labeling"),
  ).toBeVisible();
  await captureScreenshot(page, "01-dataset.png");
  await page.getByLabel("Search cases").fill("denominator");
  await expect(
    page.getByRole("button", { name: /^Clamped denominator/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Null user crashes/ }),
  ).toHaveCount(0);
  await page.getByLabel("Search cases").fill("");
  await page.getByRole("button", { name: /^Experiments/ }).click();
  await page.getByRole("button", { name: /^Finding verification/ }).click();
  await page.getByLabel("Experiment name").fill("Baseline · current verifier");
  await page.getByRole("button", { name: "Run 4 cases", exact: true }).click();
  await expect(
    page.getByText("4/4 executed · 4 scored · 0 need matching · 0 failed", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  const initialRuns = (
    await client.evaluations.detail.query({ datasetId: selected })
  ).runs;
  const baselineId = initialRuns[0]?.id;
  if (!baselineId) throw new Error("Baseline missing");
  await page
    .getByRole("button", { name: "New experiment", exact: true })
    .click();
  await page
    .getByLabel("Experiment name")
    .fill("Candidate · verify existing guards");
  const current = await page.getByLabel("Candidate system prompt").inputValue();
  await page
    .getByLabel("Candidate system prompt")
    .fill(
      `${current}\n\nBefore retaining a finding, check whether a guard already proves it impossible. Cite the guard when rejecting an unsupported alarm.`,
    );
  await captureScreenshot(page, "03-prompt-experiment.png");
  await page.getByRole("button", { name: "Run 4 cases", exact: true }).click();
  await expect(
    page.getByText("4/4 executed · 4 scored · 0 need matching · 0 failed", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 120_000 });
  await page.getByLabel("Compare baseline").selectOption(baselineId);
  await expect(
    page.getByText("Baseline: Baseline · current verifier", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0%", { exact: true })).toBeVisible();
  await captureScreenshot(page, "04-comparison.png");
  await page.getByText(examples[2].title, { exact: true }).click();
  await expect(
    page.getByText(examples[2].rationale, { exact: true }),
  ).toBeVisible();
  const sourceToggle = page
    .getByText("Frozen source", { exact: true })
    .filter({ visible: true });
  await sourceToggle.click();
  await expect(sourceToggle.locator("..").locator("pre")).toContainText(
    examples[2].source,
  );
  await sourceToggle.click();
  await captureScreenshot(page, "05-outcome-inspection.png");
  // Historical cases and labels must not follow later edits.
  const latest = await client.evaluations.detail.query({ datasetId: selected });
  const first = latest.cases.find((c) => c.title === examples[0].title);
  if (!first) throw new Error("Case missing");
  await client.evaluations.saveCase.mutate({
    datasetId: selected,
    id: first.id,
    example: {
      ...(await client.evaluations.case.query({
        datasetId: selected,
        id: first.id,
      })),
      rationale: "Updated annotation after baseline",
    },
  });
  const frozen = await client.evaluations.run.query({
    datasetId: selected,
    runId: baselineId,
  });
  expect(frozen.cases.find((c) => c.id === first.id)?.rationale).toBe(
    examples[0].rationale,
  );
  const live = await client.evaluations.prompts.query();
  expect(live.verification).toBe(current);
  // Discovery uses the real SDK tool loop and requires explicit matching.
  await page
    .getByRole("button", { name: "New experiment", exact: true })
    .click();
  await page.getByRole("button", { name: /^Frozen-file discovery/ }).click();
  await page.getByLabel("Experiment name").fill("Discovery · blind replay");
  await page.getByRole("button", { name: "Run 4 cases", exact: true }).click();
  await expect(
    page.getByText("4/4 executed · 2 scored · 2 need matching · 0 failed", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 120_000 });
  await page.getByText(examples[0].title, { exact: true }).click();
  await page
    .getByRole("button", { name: "Reported target issue", exact: true })
    .click();
  await expect(
    page.getByText("4/4 executed · 3 scored · 1 need matching · 0 failed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reported target issue", exact: true }),
  ).toBeEnabled();
  await captureScreenshot(page, "06-discovery-matching.png");
  // Failed providers are visible and excluded from denominators.
  const failure = await client.evaluations.startRun.mutate({
    datasetId: selected,
    name: "QA · provider failure",
    mode: "verification",
    split: "holdout",
    prompt: "QA_FORCE_FAILURE",
  });
  await expect
    .poll(
      async () =>
        (
          await client.evaluations.run.query({
            datasetId: selected,
            runId: failure.id,
          })
        ).status,
      { timeout: 90_000 },
    )
    .toBe("completed");
  const failed = await client.evaluations.run.query({
    datasetId: selected,
    runId: failure.id,
  });
  expect(failed.metrics.graded).toBe(0);
  expect(failed.cases[0]?.result?.prediction).toBe("error");
  const slowURL = new URL("/qa/slow", providerURL);
  const beforeSlow = await (await fetch(slowURL)).json();
  const cancel = await client.evaluations.startRun.mutate({
    datasetId: selected,
    name: "QA · cancellation",
    mode: "verification",
    split: "development",
    prompt: "QA_SLOW",
  });
  await expect
    .poll(async () => (await (await fetch(slowURL)).json()).started)
    .toBe(beforeSlow.started + 1);
  await client.evaluations.cancel.mutate({
    datasetId: selected,
    runId: cancel.id,
  });
  expect(
    (
      await client.evaluations.run.query({
        datasetId: selected,
        runId: cancel.id,
      })
    ).status,
  ).toBe("cancelled");
  await expect
    .poll(
      async () => {
        const run = await client.evaluations.run.query({
          datasetId: selected,
          runId: cancel.id,
        });
        return {
          status: run.status,
          persisted: run.cases.filter((row) => row.result).length,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ status: "cancelled", persisted: 1 });
  // Allow the workflow to advance beyond the in-flight result before checking its terminal state.
  await page.waitForTimeout(2000);
  const settled = await client.evaluations.run.query({
    datasetId: selected,
    runId: cancel.id,
  });
  expect(settled.status).toBe("cancelled");
  expect(settled.cases.filter((row) => row.result)).toHaveLength(1);
  expect(await (await fetch(slowURL)).json()).toEqual({
    started: beforeSlow.started + 1,
    finished: beforeSlow.finished + 1,
  });
  // Browser reload and mobile navigation preserve access and layout.
  await page.reload();
  await page.getByLabel("Dataset", { exact: true }).selectOption(selected);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Your ground truth" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await captureScreenshot(page, "07-mobile.png");
  // Inspect every working view at narrow phone, tablet and desktop widths.
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(
      page.getByRole("heading", { name: "Your ground truth" }),
    ).toBeVisible();
    const heading = await page
      .getByRole("heading", { name: "Your ground truth" })
      .boundingBox();
    expect(heading?.y).toBeLessThan(430);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await captureScreenshot(page, `responsive-cases-${width}.png`);
    await page.getByRole("button", { name: "Add case", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await captureScreenshot(page, `responsive-editor-${width}.png`);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /^Experiments/ }).click();
    await page
      .getByLabel("Experiment history", { exact: true })
      .selectOption(baselineId);
    await expect(
      page.getByRole("heading", { name: "Baseline · current verifier" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await captureScreenshot(page, `responsive-results-${width}.png`);
    await page
      .getByRole("button", { name: "New experiment", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await captureScreenshot(page, `responsive-prompt-${width}.png`);
    await page.getByRole("button", { name: /^Cases/ }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(screenshots, "responsive-mobile-overview.png"),
    animations: "disabled",
    style: "nextjs-portal { visibility: hidden; }",
  });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await captureScreenshot(page, "responsive-cases-dark-390.png");
  await page.getByRole("button", { name: /^Experiments/ }).click();
  await page
    .getByLabel("Experiment history", { exact: true })
    .selectOption(baselineId);
  await expect(
    page.getByRole("heading", { name: "Baseline · current verifier" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await captureScreenshot(page, "responsive-results-dark-390.png");
  await page.getByRole("button", { name: "Toggle color theme" }).click();
});
