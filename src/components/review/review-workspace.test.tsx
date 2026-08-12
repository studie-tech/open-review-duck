// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import {
  aiJobActive,
  DeepReviewFindingCard,
  deepReviewFacetCounts,
} from "./review-workspace";

type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];

/** Builds a surfaced deep-review finding with the fields a test overrides. */
function finding(
  overrides: Partial<DeepReviewFinding> = {},
): DeepReviewFinding {
  return {
    id: "finding-1",
    orderIndex: 0,
    severity: "critical",
    category: "security",
    state: "anchored",
    verdict: "not_refuted",
    verdictReason: null,
    path: "src/app.ts",
    startLine: 12,
    endLine: 14,
    anchorTier: "unit_current",
    anchorSide: "current",
    anchorAmbiguous: false,
    unitId: "unit-1",
    publishable: true,
    contentAvailable: true,
    title: "Unbounded read",
    body: "The handler reads the whole body into memory.",
    existingCode: "read(body)",
    suggestionCode: null,
    locations: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("aiJobActive", () => {
  it("keeps polling every non-terminal status, not only queued and running", () => {
    // A deep-review parent sits in `waiting_for_provider` from `startAiJob`
    // until seal-plan, so the old ["queued", "running"] predicate reported a
    // live fan-out as finished.
    for (const status of [
      "queued",
      "running",
      "waiting_for_provider",
      "streaming",
    ]) {
      expect(aiJobActive(status)).toBe(true);
    }
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(aiJobActive(status)).toBe(false);
    }
  });

  it("treats a missing status as inactive", () => {
    expect(aiJobActive(undefined)).toBe(false);
    expect(aiJobActive(null)).toBe(false);
    expect(aiJobActive("")).toBe(false);
  });
});

describe("deepReviewFacetCounts", () => {
  it("counts every facet value so empty options can be dropped", () => {
    const findings = [
      finding({ severity: "critical", category: "security" }),
      finding({ severity: "low", category: "security" }),
      finding({ severity: "low", category: "style" }),
    ];
    expect(
      deepReviewFacetCounts(findings, "severity", [
        "critical",
        "high",
        "medium",
        "low",
      ]),
    ).toEqual([
      { value: "critical", count: 1 },
      { value: "high", count: 0 },
      { value: "medium", count: 0 },
      { value: "low", count: 1 + 1 },
    ]);
    expect(
      deepReviewFacetCounts(findings, "category", ["security", "bug"]),
    ).toEqual([
      { value: "security", count: 2 },
      { value: "bug", count: 0 },
    ]);
  });
});

describe("DeepReviewFindingCard", () => {
  it("offers publication for an anchored finding that was not refuted", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    render(
      <DeepReviewFindingCard
        finding={finding()}
        providerName="GitHub"
        published={false}
        publishing={false}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByText("critical")).toBeVisible();
    expect(screen.getByText("security")).toBeVisible();
    expect(screen.getByText("src/app.ts:12")).toBeVisible();
    expect(screen.queryByText(/Not publishable/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Post to GitHub/ }));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("shows an already-published finding without a second post control", () => {
    render(
      <DeepReviewFindingCard
        finding={finding()}
        providerName="GitHub"
        published
        publishing={false}
        onPublish={vi.fn()}
      />,
    );

    expect(screen.getByText("Published")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Post to GitHub/ }),
    ).not.toBeInTheDocument();
  });

  it.each<[DeepReviewFinding["state"], string]>([
    ["unanchored", "No line in this revision matched the quoted code"],
    ["out_of_scope", "Anchored outside the lines this pull request changed"],
    ["ungrounded", "The agent never proved it read the code it reported on"],
    ["refuted", "A verification pass could not reproduce this"],
  ])("keeps a %s finding visible but unpublishable", (state, reason) => {
    render(
      <DeepReviewFindingCard
        finding={finding({ state, publishable: false })}
        providerName="GitHub"
        published={false}
        publishing={false}
        onPublish={vi.fn()}
      />,
    );

    // Visible, so a discarded finding stays distinguishable from one the run
    // never made — but with no way to put it on the pull request.
    expect(screen.getByText("Unbounded read")).toBeVisible();
    expect(screen.getByText(new RegExp(reason))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Post to GitHub/ }),
    ).not.toBeInTheDocument();
  });

  it("appends the verdict reason to a refuted finding", () => {
    render(
      <DeepReviewFindingCard
        finding={finding({
          state: "refuted",
          verdict: "refuted",
          verdictReason: "The guard clause above already handles it",
          publishable: false,
        })}
        providerName="GitHub"
        published={false}
        publishing={false}
      />,
    );

    expect(
      screen.getByText(/The guard clause above already handles it/),
    ).toBeVisible();
  });

  it("marks a finding whose sealed content could not be read", () => {
    render(
      <DeepReviewFindingCard
        finding={finding({ contentAvailable: false, title: "", body: "" })}
        providerName="GitHub"
        published={false}
        publishing={false}
        onPublish={vi.fn()}
      />,
    );

    expect(
      screen.getByText("This finding could not be decrypted"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Post to GitHub/ }),
    ).toBeDisabled();
  });

  it("names every location of a cross-file finding that has no path", () => {
    render(
      <DeepReviewFindingCard
        finding={finding({
          path: null,
          startLine: null,
          endLine: null,
          unitId: null,
          state: "unanchored",
          publishable: false,
          locations: [
            {
              path: "src/a.ts",
              anchorTier: "file_current",
              anchorSide: "current",
              startLine: 4,
              endLine: 6,
            },
            {
              path: "src/b.ts",
              anchorTier: null,
              anchorSide: null,
              startLine: null,
              endLine: null,
            },
          ],
        })}
        providerName="GitHub"
        published={false}
        publishing={false}
      />,
    );

    expect(screen.getByText("2 locations")).toBeVisible();
    expect(screen.getByText("src/a.ts:4")).toBeVisible();
    expect(screen.getByText("src/b.ts")).toBeVisible();
  });
});
