// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import {
  aiJobActive,
  applyAiQuestionStreamUpdate,
  DeepReviewFindingRow,
  DeepReviewInlineFinding,
  deepReviewFacetCounts,
  groupDeepReviewFindings,
  releaseWaitingUnits,
  reshapeProviderThreads,
  restoreProviderThread,
  useReviewExitPrefetch,
  useTerminalReviewRefetch,
} from "./review-workspace";

type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];
type WorkspaceUnit = RouterOutputs["review"]["workspace"]["units"][number];
type ProviderConversationThread =
  RouterOutputs["review"]["providerConversations"]["threads"][number];

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
    // until seal-plan, so a predicate narrower than this reports a live
    // fan-out as finished.
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

describe("applyAiQuestionStreamUpdate", () => {
  const live = [
    {
      error: null,
      focusLine: 12,
      id: "live-1",
      progress: "Investigating the review revision…",
      question: "Why this cast?",
      result: { summary: "Because of the union." },
      status: "streaming" as const,
      threadId: "thread-1",
    },
  ];

  it("keeps the same array when the update restates the entry", () => {
    expect(
      applyAiQuestionStreamUpdate(live, "live-1", {
        progress: "Investigating the review revision…",
        status: "streaming",
        text: "Because of the union.",
      }),
    ).toBe(live);
  });

  it("keeps the same array for an update naming no live entry", () => {
    expect(
      applyAiQuestionStreamUpdate(live, "live-2", {
        progress: "Answer complete",
        status: "completed",
        text: "Done.",
      }),
    ).toBe(live);
  });

  it("maps a working heartbeat onto the running status", () => {
    expect(
      applyAiQuestionStreamUpdate(live, "live-1", {
        progress: "Waiting for the model provider…",
        status: "working",
        text: "",
      })[0],
    ).toMatchObject({
      progress: "Waiting for the model provider…",
      result: { summary: "Because of the union." },
      status: "running",
    });
  });

  it("takes the newer answer text and its comment proposals", () => {
    const commentProposals = [{ body: "Narrow it", line: 12, path: "a.ts" }];

    expect(
      applyAiQuestionStreamUpdate(live, "live-1", {
        commentProposals,
        progress: "Answer complete",
        status: "completed",
        text: "Because of the union, narrowed later.",
      })[0],
    ).toMatchObject({
      error: null,
      result: {
        commentProposals,
        summary: "Because of the union, narrowed later.",
      },
      status: "completed",
    });
  });

  it("records a failure reported by the stream", () => {
    expect(
      applyAiQuestionStreamUpdate(live, "live-1", {
        error: "The AI answer could not be completed.",
        progress: "Answer interrupted",
        status: "failed",
        text: "",
      })[0],
    ).toMatchObject({
      error: "The AI answer could not be completed.",
      status: "failed",
    });
  });
});

describe("reshapeProviderThreads", () => {
  const threads: ProviderConversationThread[] = [
    {
      externalId: "901",
      path: "src/retry.ts",
      line: 17,
      side: "right",
      status: "open",
      unitId: "unit-1",
      comments: [
        {
          externalId: "901",
          author: "reviewer",
          body: "Could this retain the previous behavior?",
          createdAt: "2026-07-20T10:00:00Z",
          publishedByAnotherReviewer: false,
        },
        {
          externalId: "902",
          author: "reviewer",
          body: "It does now.",
          createdAt: "2026-07-20T10:05:00Z",
          publishedByAnotherReviewer: false,
        },
      ],
    },
    {
      externalId: "910",
      path: "src/retry.ts",
      line: 42,
      side: "right",
      status: "resolved",
      unitId: "unit-2",
      comments: [
        {
          externalId: "910",
          author: "reviewer",
          body: "Handled.",
          createdAt: "2026-07-20T11:00:00Z",
          publishedByAnotherReviewer: false,
        },
      ],
    },
  ];

  it("flips only the named conversation between resolved and open", () => {
    const resolved = reshapeProviderThreads(threads, {
      kind: "resolution",
      threadExternalId: "901",
      resolved: true,
    });

    expect(resolved.map(({ status }) => status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(
      reshapeProviderThreads(resolved, {
        kind: "resolution",
        threadExternalId: "910",
        resolved: false,
      }).map(({ status }) => status),
    ).toEqual(["resolved", "open"]);
  });

  it("puts the edited text on the one comment that was rewritten", () => {
    const [thread] = reshapeProviderThreads(threads, {
      kind: "edit-comment",
      threadExternalId: "901",
      commentExternalId: "902",
      body: "It does after the retry cap.",
    });

    expect(thread?.comments.map(({ body }) => body)).toEqual([
      "Could this retain the previous behavior?",
      "It does after the retry cap.",
    ]);
  });

  it("removes a deleted comment while keeping its conversation", () => {
    const [thread] = reshapeProviderThreads(threads, {
      kind: "delete-comment",
      threadExternalId: "901",
      commentExternalId: "901",
    });

    expect(thread?.comments.map(({ externalId }) => externalId)).toEqual([
      "902",
    ]);
  });

  it("drops a deleted conversation from the list", () => {
    expect(
      reshapeProviderThreads(threads, {
        kind: "delete-thread",
        threadExternalId: "901",
      }).map(({ externalId }) => externalId),
    ).toEqual(["910"]);
  });

  it("leaves the conversations it was handed untouched", () => {
    reshapeProviderThreads(threads, {
      kind: "delete-comment",
      threadExternalId: "901",
      commentExternalId: "901",
    });

    expect(threads[0]?.comments).toHaveLength(2);
    expect(threads[0]?.status).toBe("open");
  });

  it("rolls back one failed change without erasing a sibling success", () => {
    const firstOptimistic = reshapeProviderThreads(threads, {
      kind: "resolution",
      threadExternalId: "901",
      resolved: true,
    });
    const bothOptimistic = reshapeProviderThreads(firstOptimistic, {
      kind: "edit-comment",
      threadExternalId: "910",
      commentExternalId: "910",
      body: "Confirmed by the provider.",
    });

    const rolledBack = restoreProviderThread(bothOptimistic, threads, "901");

    expect(rolledBack[0]?.status).toBe("open");
    expect(rolledBack[1]?.comments[0]?.body).toBe("Confirmed by the provider.");
  });

  it("restores a deleted thread in order without erasing a sibling success", () => {
    const deleted = reshapeProviderThreads(threads, {
      kind: "delete-thread",
      threadExternalId: "901",
    });
    const siblingUpdated = reshapeProviderThreads(deleted, {
      kind: "resolution",
      threadExternalId: "910",
      resolved: false,
    });

    const rolledBack = restoreProviderThread(siblingUpdated, threads, "901");

    expect(rolledBack.map(({ externalId }) => externalId)).toEqual([
      "901",
      "910",
    ]);
    expect(rolledBack[1]?.status).toBe("open");
  });
});

describe("useTerminalReviewRefetch", () => {
  const refetch = {
    aiUsage: vi.fn(),
    deepReview: vi.fn(),
    discussion: vi.fn(),
  };

  /** Renders the hook the way a rerendering view does: with fresh results. */
  function renderTerminalRefetch(status: string) {
    return renderHook(
      ({ status: current }: { status: string }) =>
        useTerminalReviewRefetch(current, {
          aiUsage: { refetch: refetch.aiUsage },
          deepReview: { refetch: refetch.deepReview },
          discussion: { refetch: refetch.discussion },
        }),
      { initialProps: { status } },
    );
  }

  it("pulls the tree once however often the view rerenders", () => {
    // Typing in the composer rerenders the workspace, and every render hands
    // the hook new query objects, so identity alone must not trigger a pull.
    const { rerender } = renderTerminalRefetch("completed");
    rerender({ status: "completed" });
    rerender({ status: "completed" });

    expect(refetch.discussion).toHaveBeenCalledOnce();
    expect(refetch.aiUsage).toHaveBeenCalledOnce();
    expect(refetch.deepReview).toHaveBeenCalledOnce();
  });

  it("waits for a terminal status and pulls again for the next run", () => {
    const { rerender } = renderTerminalRefetch("running");
    expect(refetch.deepReview).not.toHaveBeenCalled();

    rerender({ status: "failed" });
    expect(refetch.deepReview).toHaveBeenCalledOnce();

    rerender({ status: "queued" });
    rerender({ status: "completed" });
    expect(refetch.deepReview).toHaveBeenCalledTimes(2);
  });
});

describe("useReviewExitPrefetch", () => {
  const router = { prefetch: vi.fn() };

  /** Renders the hook the way the workspace does: with a stable router. */
  function renderExitPrefetch(destinations: {
    nextReviewId: string | undefined;
    reviewEnded: boolean;
  }) {
    return renderHook(
      (current: { nextReviewId: string | undefined; reviewEnded: boolean }) =>
        useReviewExitPrefetch(router, current),
      { initialProps: destinations },
    );
  }

  it("leaves both exits cold while the review is still under way", () => {
    renderExitPrefetch({ nextReviewId: "review-2", reviewEnded: false });

    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it("warms both exits once the review ends", () => {
    renderExitPrefetch({ nextReviewId: "review-2", reviewEnded: true });

    expect(router.prefetch).toHaveBeenCalledWith("/pullrequests");
    expect(router.prefetch).toHaveBeenCalledWith("/review/review-2");
  });

  it("warms the dashboard alone when no pull request is waiting", () => {
    renderExitPrefetch({ nextReviewId: undefined, reviewEnded: true });

    expect(router.prefetch).toHaveBeenCalledExactlyOnceWith("/pullrequests");
  });

  it("warms each destination once however often the view rerenders", () => {
    const { rerender } = renderExitPrefetch({
      nextReviewId: "review-2",
      reviewEnded: true,
    });
    rerender({ nextReviewId: "review-2", reviewEnded: true });
    rerender({ nextReviewId: "review-2", reviewEnded: true });

    expect(router.prefetch).toHaveBeenCalledTimes(2);
  });

  it("follows the queue when the next pull request changes", () => {
    const { rerender } = renderExitPrefetch({
      nextReviewId: "review-2",
      reviewEnded: true,
    });
    rerender({ nextReviewId: "review-3", reviewEnded: true });

    expect(router.prefetch).toHaveBeenCalledWith("/review/review-3");
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
    // A mismatch between the quoted snippet and the lines just above it is
    // the reader's one check on an ungrounded claim.
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

describe("releaseWaitingUnits", () => {
  /** Builds the wait-bearing fields of a workspace unit a release reads. */
  const unit = (id: string, waiting: boolean): WorkspaceUnit =>
    ({
      id,
      status: waiting ? "waiting" : "pending",
      waitingSince: waiting ? new Date(Date.UTC(2026, 7, 30, 10)) : null,
    }) as WorkspaceUnit;

  it("returns every named wait to the actionable path at once", () => {
    const released = releaseWaitingUnits(
      [unit("a", true), unit("b", true), unit("c", true)],
      ["a", "c"],
    );

    expect(
      released.map(({ id, status, waitingSince }) => ({
        id,
        status,
        waitingSince,
      })),
    ).toEqual([
      { id: "a", status: "pending", waitingSince: null },
      {
        id: "b",
        status: "waiting",
        waitingSince: new Date(Date.UTC(2026, 7, 30, 10)),
      },
      { id: "c", status: "pending", waitingSince: null },
    ]);
  });

  it("keeps the units it was handed untouched", () => {
    const units = [unit("a", true), unit("b", true)];
    const released = releaseWaitingUnits(units, ["a"]);

    expect(units[0]?.status).toBe("waiting");
    expect(released[1]).toBe(units[1]);
  });
});
