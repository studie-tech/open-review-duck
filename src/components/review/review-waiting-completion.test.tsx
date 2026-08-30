// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterWaitingReviewUnits,
  orderWaitingReviewUnits,
  ReviewWaitingCompletion,
  type WaitingReviewUnit,
} from "./review-waiting-completion";

afterEach(cleanup);

const shortcutProps = {
  dashboardShortcut: [{ key: "g" }, { key: "r" }],
  dismissShortcut: [{ key: "Escape" }],
  nextReviewShortcut: [{ key: "n", shift: true }],
};

/** Builds a waiting-unit fixture with focused per-test overrides. */
const waitingUnit = (
  index: number,
  overrides: Partial<WaitingReviewUnit> = {},
): WaitingReviewUnit => ({
  answered: false,
  commentCount: 1,
  id: `unit-${index}`,
  latestComment: {
    author: "reviewer",
    body: `Question about behavior ${index}`,
  },
  path: `src/unit-${index}.ts`,
  threadCount: 1,
  title: `Unit ${index}`,
  waitingSince: new Date(Date.UTC(2026, 7, index + 1, 10)),
  ...overrides,
});

describe("waiting review unit selection", () => {
  it("orders the oldest wait first without mutating its input", () => {
    const newer = waitingUnit(4);
    const older = waitingUnit(1);
    const unknown = waitingUnit(8, { waitingSince: null });
    const input = [unknown, newer, older];

    expect(orderWaitingReviewUnits(input).map(({ id }) => id)).toEqual([
      older.id,
      newer.id,
      unknown.id,
    ]);
    expect(input).toEqual([unknown, newer, older]);
  });

  it("puts an answered unit ahead of one that waited longer", () => {
    const answered = waitingUnit(6, { answered: true });
    const older = waitingUnit(1);

    expect(
      orderWaitingReviewUnits([older, answered]).map(({ id }) => id),
    ).toEqual([answered.id, older.id]);
  });

  it("searches unit titles, files, authors, and comment bodies", () => {
    const units = [
      waitingUnit(1, { path: "src/bloodline.ts" }),
      waitingUnit(2, {
        latestComment: { author: "Mathias", body: "Does Sage Mode apply?" },
      }),
    ];

    expect(filterWaitingReviewUnits(units, "bloodline")).toEqual([units[0]]);
    expect(filterWaitingReviewUnits(units, "sage mode")).toEqual([units[1]]);
    expect(filterWaitingReviewUnits(units, "mathias")).toEqual([units[1]]);
  });
});

describe("ReviewWaitingCompletion", () => {
  it("contains focus within an accessible modal and restores it on close", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { unmount } = render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[waitingUnit(1)]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={9}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={onDismiss}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "You’re caught up." });
    const dismiss = screen.getByRole("button", {
      name: "Close waiting dialog and keep review open",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dismiss).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: /Pull requests/ })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();

    outside.focus();
    expect(dismiss).toHaveFocus();
    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("surfaces answered units as ready to resume", async () => {
    const onStopWaiting = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[
          waitingUnit(1, { answered: true, title: "Answered unit" }),
          waitingUnit(2, { title: "Still waiting" }),
        ]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={8}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={onStopWaiting}
      />,
    );

    expect(screen.getByText("Ready now").nextSibling).toHaveTextContent("1");
    expect(screen.getByText(/1 response is ready to review/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /View 2 units/i }));
    expect(screen.getByText("Response received")).toBeVisible();
    const resume = screen.getByRole("button", { name: /Resume review/ });
    await user.click(resume);
    expect(onStopWaiting).toHaveBeenCalledWith("unit-1");
    expect(
      screen.getByRole("button", { name: /Stop waiting/ }),
    ).toBeInTheDocument();
  });

  it("shows keyboard shortcuts on the end-state actions", () => {
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[waitingUnit(1)]}
        nextReview={{
          id: "next-pr",
          number: 7,
          repositoryName: "open-review-duck",
          repositoryOwner: "studie-tech",
          signedUnits: 2,
          title: "Improve settings UX",
          totalUnits: 9,
        }}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={9}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    for (const name of [
      /Keep review open/,
      /Pull requests/,
      /Review next PR/,
    ]) {
      expect(
        screen.getByRole("button", { name }).querySelector("kbd"),
      ).toBeInTheDocument();
    }
  });

  it("explains when provider activity has no known wait timestamp", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[waitingUnit(1, { waitingSince: null })]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={9}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 1 unit/i }));
    expect(screen.getByText("Waiting for provider activity")).toBeVisible();
  });

  it("summarizes a large waiting set before rendering its rows", async () => {
    const units = Array.from({ length: 42 }, (_, index) => waitingUnit(index));
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={units}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={132}
        totalConcepts={174}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "You’re caught up." }),
    ).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.queryByText("Question about behavior 20")).toBeNull();

    await user.click(screen.getByRole("button", { name: /View 42 units/i }));
    expect(
      screen.getByRole("heading", {
        name: "42 units waiting for response",
      }),
    ).toBeVisible();
    expect(screen.getByText("Question about behavior 20")).toBeVisible();
  });

  it("searches the waiting room and exposes unit-level actions", async () => {
    const onOpenUnit = vi.fn();
    const onStopWaiting = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[
          waitingUnit(1, { title: "Bloodline behavior" }),
          waitingUnit(2, {
            commentCount: 40,
            title: "Sage mode validation",
          }),
        ]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={10}
        totalConcepts={12}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={onOpenUnit}
        onStopWaiting={onStopWaiting}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 2 units/i }));
    await user.type(
      screen.getByRole("textbox", { name: "Find a waiting unit" }),
      "sage",
    );
    expect(screen.getByText("Sage mode validation")).toBeVisible();
    expect(screen.getByText(/40 comments/)).toBeVisible();
    expect(screen.queryByText("Bloodline behavior")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenUnit).toHaveBeenCalledWith("unit-2");
    await user.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(onStopWaiting).toHaveBeenCalledWith("unit-2");
  });

  it("releases each waiting unit without waiting on the others", async () => {
    const onStopWaiting = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        units={[waitingUnit(1), waitingUnit(2)]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={10}
        totalConcepts={12}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenUnit={vi.fn()}
        onStopWaiting={onStopWaiting}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 2 units/i }));
    const releases = screen.getAllByRole("button", { name: "Stop waiting" });
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release).toBeEnabled();
      await user.click(release);
    }

    expect(onStopWaiting.mock.calls).toEqual([["unit-1"], ["unit-2"]]);
  });
});
