// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import {
  aiJobActive,
  deepReviewFacetCounts,
  DeepReviewFindingRow,
  DeepReviewInlineFinding,
  groupDeepReviewFindings,
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

/** Renders one inline finding card with only the props a case overrides. */
function renderCard(
  props: Partial<Parameters<typeof DeepReviewInlineFinding>[0]> = {},
) {
  return render(
    <DeepReviewInlineFinding
      finding={finding()}
      variant="line"
      locationIndex={0}
      providerName="GitHub"
      published={false}
      publishing={false}
      onCollapse={vi.fn()}
      onOpenLocation={vi.fn()}
      {...props}
    />,
  );
}

/** Renders one index row with only the props a case overrides. */
function renderRow(
  props: Partial<Parameters<typeof DeepReviewFindingRow>[0]> = {},
) {
  return render(
    <DeepReviewFindingRow
      finding={finding()}
      active={false}
      inActiveUnit={false}
      published={false}
      tabIndex={0}
      onOpen={vi.fn()}
      {...props}
    />,
  );
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

describe("groupDeepReviewFindings", () => {
  const units = [
    { path: "src/beta.ts" },
    { path: "src/alpha.ts" },
    { path: "src/gamma.ts" },
  ];

  it("puts the file holding the worst finding first", () => {
    const groups = groupDeepReviewFindings(
      [
        finding({ id: "a", path: "src/alpha.ts", severity: "low" }),
        finding({ id: "b", path: "src/beta.ts", severity: "critical" }),
        finding({ id: "c", path: "src/gamma.ts", severity: "medium" }),
      ],
      units,
    );

    expect(groups.map(({ label }) => label)).toEqual([
      "src/beta.ts",
      "src/gamma.ts",
      "src/alpha.ts",
    ]);
    expect(groups.every(({ kind }) => kind === "file")).toBe(true);
  });

  it("breaks a severity tie on the path, not on arrival order", () => {
    const groups = groupDeepReviewFindings(
      [
        finding({ id: "g", path: "src/gamma.ts", severity: "high" }),
        finding({ id: "b", path: "src/beta.ts", severity: "high" }),
      ],
      units,
    );

    expect(groups.map(({ path }) => path)).toEqual([
      "src/beta.ts",
      "src/gamma.ts",
    ]);
  });

  it("trails the two dead-end groups however severe their findings are", () => {
    // Both groups navigate nowhere useful, so severity must not float them
    // above a file the reviewer can actually open.
    const groups = groupDeepReviewFindings(
      [
        finding({ id: "survey", path: null, severity: "critical" }),
        finding({ id: "gone", path: "src/deleted.ts", severity: "critical" }),
        finding({ id: "here", path: "src/alpha.ts", severity: "low" }),
      ],
      units,
    );

    expect(
      groups.map(({ kind, label, findings }) => [
        kind,
        label,
        findings.map(({ id }) => id),
      ]),
    ).toEqual([
      ["file", "src/alpha.ts", ["here"]],
      ["unmatched", "No line matched", ["gone"]],
      ["survey", "Across this pull request", ["survey"]],
    ]);
  });

  it("reads a group in file order with unanchored findings last", () => {
    const groups = groupDeepReviewFindings(
      [
        finding({ id: "late", path: "src/alpha.ts", startLine: 90 }),
        finding({ id: "nowhere", path: "src/alpha.ts", startLine: null }),
        finding({ id: "early", path: "src/alpha.ts", startLine: 4 }),
      ],
      units,
    );

    expect(groups[0]?.findings.map(({ id }) => id)).toEqual([
      "early",
      "late",
      "nowhere",
    ]);
  });

  it("orders two findings on one line by their frozen run rank", () => {
    const groups = groupDeepReviewFindings(
      [
        finding({ id: "second", path: "src/alpha.ts", orderIndex: 7 }),
        finding({ id: "first", path: "src/alpha.ts", orderIndex: 3 }),
      ],
      units,
    );

    expect(groups[0]?.findings.map(({ id }) => id)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("DeepReviewInlineFinding", () => {
  it("offers publication for an anchored finding that was not refuted", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    renderCard({ onPublish });

    expect(screen.getByText("critical")).toBeVisible();
    expect(screen.getByText("security")).toBeVisible();
    // The card sits beside the accused line, so it names the line and not the
    // path the reviewer is already looking at.
    expect(screen.getByText("Lines 12–14")).toBeVisible();
    expect(screen.queryByText("src/app.ts:12")).not.toBeInTheDocument();
    expect(screen.queryByText(/Not publishable/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Post to GitHub/ }));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("names the file when it is mounted away from the accused line", () => {
    renderCard({ variant: "detached", onPublish: vi.fn() });

    expect(screen.getByText("src/app.ts:12")).toBeVisible();
    expect(screen.queryByText("Lines 12–14")).not.toBeInTheDocument();
  });

  it("shows the code the agent claims to have read", () => {
    // Fetched by the read path and displayed nowhere before this card: a
    // mismatch with the lines just above it is the reader's one check on an
    // ungrounded claim.
    renderCard({
      finding: finding({ existingCode: "const total = rows.length;" }),
    });

    expect(screen.getByText("Agent quoted")).toBeVisible();
    expect(screen.getByText("const total = rows.length;")).toBeVisible();
  });

  it("shows an already-published finding without a second post control", () => {
    renderCard({ published: true, onPublish: vi.fn() });

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
    renderCard({
      finding: finding({ state, publishable: false }),
      onPublish: vi.fn(),
    });

    // Visible, so a discarded finding stays distinguishable from one the run
    // never made — but with no way to put it on the pull request.
    expect(screen.getByText("Unbounded read")).toBeVisible();
    expect(screen.getByText(new RegExp(reason))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Post to GitHub/ }),
    ).not.toBeInTheDocument();
  });

  it("still offers to rewrite a finding it cannot publish itself", async () => {
    // The server only requires the line to sit inside the unit, so a reviewer
    // who agrees with an out-of-scope claim keeps an honest way to say so.
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderCard({
      finding: finding({ state: "out_of_scope", publishable: false }),
      onEdit,
    });

    await user.click(screen.getByRole("button", { name: /Edit first/ }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("appends the verdict reason to a refuted finding", () => {
    renderCard({
      finding: finding({
        state: "refuted",
        verdict: "refuted",
        verdictReason: "The guard clause above already handles it",
        publishable: false,
      }),
    });

    expect(
      screen.getByText(/The guard clause above already handles it/),
    ).toBeVisible();
  });

  it("marks a finding whose sealed content could not be read", () => {
    renderCard({
      finding: finding({ contentAvailable: false, title: "", body: "" }),
      onPublish: vi.fn(),
    });

    expect(
      screen.getByText("This finding could not be decrypted"),
    ).toBeVisible();
    // Absent rather than disabled: no retry can enable it, because the server
    // reads the body from the same sealed payload the client could not open.
    expect(
      screen.queryByRole("button", { name: /Post to GitHub/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit first/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("The body could not be decrypted.")).toBeVisible();
  });

  it("turns every location of a cross-file finding into a destination", async () => {
    const user = userEvent.setup();
    const onOpenLocation = vi.fn();
    renderCard({
      variant: "detached",
      locationIndex: 1,
      onOpenLocation,
      finding: finding({
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
      }),
    });

    expect(screen.getByText("Across this pull request")).toBeVisible();
    expect(screen.getByRole("button", { name: "src/b.ts" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "src/a.ts:4" }));
    expect(onOpenLocation).toHaveBeenCalledWith(0);
  });

  it("publishes and collapses from the keyboard while the card holds focus", async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    const onPublish = vi.fn();
    renderCard({ onCollapse, onPublish });
    const card = screen.getByText("Unbounded read").closest("article");
    if (!card) throw new Error("The finding card did not render");
    card.focus();

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onPublish).toHaveBeenCalledOnce();

    await user.keyboard("{Escape}");
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("refuses the publish stroke on a finding the server would reject", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    renderCard({
      finding: finding({ state: "out_of_scope", publishable: false }),
      onPublish,
    });
    const card = screen.getByText("Unbounded read").closest("article");
    if (!card) throw new Error("The finding card did not render");
    card.focus();

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onPublish).not.toHaveBeenCalled();
  });
});

describe("DeepReviewFindingRow", () => {
  it("carries the full title so a truncated row is still readable", () => {
    renderRow();

    expect(screen.getByText("Unbounded read")).toHaveAttribute(
      "title",
      "Unbounded read",
    );
  });

  it("shows a published finding as published even though it is verified", () => {
    // One 14px column, so the markers are a priority order rather than a set:
    // a published finding's verdict no longer changes what to do about it.
    renderRow({ published: true });

    expect(screen.getByLabelText("Published")).toBeInTheDocument();
    expect(screen.queryByLabelText("Verified")).not.toBeInTheDocument();
  });

  it("prefers the verdict marker to the withheld marker", () => {
    renderRow({ finding: finding({ publishable: false, state: "refuted" }) });

    expect(screen.getByLabelText("Verified")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("A verification pass could not reproduce this"),
    ).not.toBeInTheDocument();
  });

  it("explains in the marker why a withheld finding cannot be posted", () => {
    renderRow({
      finding: finding({
        publishable: false,
        state: "out_of_scope",
        verdict: "unverified",
      }),
    });

    expect(
      screen.getByLabelText(
        "Anchored outside the lines this pull request changed",
      ),
    ).toBeInTheDocument();
  });

  it("leaves an open, unverified finding with no marker at all", () => {
    renderRow({ finding: finding({ verdict: "unverified" }) });

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("names an undecryptable finding instead of showing an empty row", () => {
    renderRow({
      finding: finding({ contentAvailable: false, title: "", body: "" }),
    });

    expect(screen.getByText("Could not be decrypted")).toBeVisible();
  });

  it("marks the open finding for assistive technology, not just for the eye", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderRow({ active: true, onOpen });

    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("data-finding-row", "finding-1");

    await user.click(row);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
