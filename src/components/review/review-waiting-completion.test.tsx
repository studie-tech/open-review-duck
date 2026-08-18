// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterWaitingReviewConcepts,
  orderWaitingReviewConcepts,
  ReviewWaitingCompletion,
  type WaitingReviewConcept,
} from "./review-waiting-completion";

afterEach(cleanup);

const shortcutProps = {
  dashboardShortcut: [{ key: "g" }, { key: "r" }],
  dismissShortcut: [{ key: "Escape" }],
  nextReviewShortcut: [{ key: "n", shift: true }],
};

/** Builds a waiting-concept fixture with focused per-test overrides. */
const waitingConcept = (
  index: number,
  overrides: Partial<WaitingReviewConcept> = {},
): WaitingReviewConcept => ({
  commentCount: 1,
  id: `concept-${index}`,
  latestComment: {
    author: "reviewer",
    body: `Question about behavior ${index}`,
  },
  paths: [`src/concept-${index}.ts`],
  threadCount: 1,
  title: `Concept ${index}`,
  unitIds: [`unit-${index}`],
  waitingSince: new Date(Date.UTC(2026, 7, index + 1, 10)),
  ...overrides,
});

describe("waiting review concept selection", () => {
  it("orders the oldest wait first without mutating its input", () => {
    const newer = waitingConcept(4);
    const older = waitingConcept(1);
    const unknown = waitingConcept(8, { waitingSince: null });
    const input = [unknown, newer, older];

    expect(orderWaitingReviewConcepts(input).map(({ id }) => id)).toEqual([
      older.id,
      newer.id,
      unknown.id,
    ]);
    expect(input).toEqual([unknown, newer, older]);
  });

  it("searches concept titles, files, authors, and comment bodies", () => {
    const concepts = [
      waitingConcept(1, { paths: ["src/bloodline.ts"] }),
      waitingConcept(2, {
        latestComment: { author: "Mathias", body: "Does Sage Mode apply?" },
      }),
    ];

    expect(filterWaitingReviewConcepts(concepts, "bloodline")).toEqual([
      concepts[0],
    ]);
    expect(filterWaitingReviewConcepts(concepts, "sage mode")).toEqual([
      concepts[1],
    ]);
    expect(filterWaitingReviewConcepts(concepts, "mathias")).toEqual([
      concepts[1],
    ]);
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
        concepts={[waitingConcept(1)]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={9}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={onDismiss}
        onNextReview={vi.fn()}
        onOpenConcept={vi.fn()}
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
    expect(screen.getByRole("button", { name: /Dashboard/ })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();

    outside.focus();
    expect(dismiss).toHaveFocus();
    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("shows keyboard shortcuts on the end-state actions", () => {
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        concepts={[waitingConcept(1)]}
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
        onOpenConcept={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    for (const name of [/Keep review open/, /Dashboard/, /Review next PR/]) {
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
        concepts={[waitingConcept(1, { waitingSince: null })]}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={9}
        totalConcepts={10}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenConcept={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 1 concept/i }));
    expect(screen.getByText("Waiting for provider activity")).toBeVisible();
  });

  it("summarizes a large waiting set before rendering its rows", async () => {
    const concepts = Array.from({ length: 42 }, (_, index) =>
      waitingConcept(index),
    );
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        concepts={concepts}
        providerName="GitHub"
        queueLoading={false}
        reviewedConcepts={132}
        totalConcepts={174}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenConcept={vi.fn()}
        onStopWaiting={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "You’re caught up." }),
    ).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.queryByText("Question about behavior 20")).toBeNull();

    await user.click(screen.getByRole("button", { name: /View 42 concepts/i }));
    expect(
      screen.getByRole("heading", {
        name: "42 concepts waiting for response",
      }),
    ).toBeVisible();
    expect(screen.getByText("Question about behavior 20")).toBeVisible();
  });

  it("searches the waiting room and exposes concept-level actions", async () => {
    const onOpenConcept = vi.fn();
    const onStopWaiting = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        concepts={[
          waitingConcept(1, { title: "Bloodline behavior" }),
          waitingConcept(2, {
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
        onOpenConcept={onOpenConcept}
        onStopWaiting={onStopWaiting}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 2 concepts/i }));
    await user.type(
      screen.getByRole("textbox", { name: "Find a waiting concept" }),
      "sage",
    );
    expect(screen.getByText("Sage mode validation")).toBeVisible();
    expect(screen.getByText(/40 comments/)).toBeVisible();
    expect(screen.queryByText("Bloodline behavior")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenConcept).toHaveBeenCalledWith("concept-2");
    await user.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(onStopWaiting).toHaveBeenCalledWith("concept-2");
  });

  it("allows only one waiting concept release at a time", async () => {
    const onStopWaiting = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWaitingCompletion
        {...shortcutProps}
        concepts={[waitingConcept(1), waitingConcept(2)]}
        providerName="GitHub"
        queueLoading={false}
        releasingConceptId="concept-1"
        reviewedConcepts={10}
        totalConcepts={12}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
        onOpenConcept={vi.fn()}
        onStopWaiting={onStopWaiting}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View 2 concepts/i }));
    const resuming = screen.getByRole("button", { name: "Resuming…" });
    const otherRelease = screen.getByRole("button", { name: "Stop waiting" });
    expect(resuming).toBeDisabled();
    expect(resuming.querySelector(".animate-spin")).toBeInTheDocument();
    expect(otherRelease).toBeDisabled();

    await user.click(otherRelease);
    expect(onStopWaiting).not.toHaveBeenCalled();
  });
});
