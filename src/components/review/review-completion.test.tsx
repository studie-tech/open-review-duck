// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findNextReview,
  ReviewCompletion,
  type ReviewCompletionCandidate,
} from "./review-completion";

afterEach(cleanup);

const reviews: ReviewCompletionCandidate[] = [
  {
    id: "current",
    number: 1,
    repositoryName: "duck",
    repositoryOwner: "acme",
    signedUnits: 12,
    title: "Current",
    totalUnits: 12,
  },
  {
    id: "empty",
    number: 2,
    repositoryName: "duck",
    repositoryOwner: "acme",
    signedUnits: 0,
    title: "Not prepared",
    totalUnits: 0,
  },
  {
    id: "complete",
    number: 3,
    repositoryName: "duck",
    repositoryOwner: "acme",
    signedUnits: 4,
    title: "Already complete",
    totalUnits: 4,
  },
  {
    id: "next",
    number: 4,
    repositoryName: "duck",
    repositoryOwner: "acme",
    signedUnits: 2,
    title: "Tighten the review queue",
    totalUnits: 9,
  },
];

describe("findNextReview", () => {
  it("selects the first prepared, unfinished review other than the current PR", () => {
    expect(findNextReview(reviews, "current")?.id).toBe("next");
  });

  it("skips removed and provider-closed pull requests", () => {
    const unfinished = reviews[3];
    if (!unfinished) throw new Error("Missing unfinished review fixture");
    expect(
      findNextReview(
        [
          {
            ...unfinished,
            id: "removed",
            queueState: "removed",
          },
          {
            ...unfinished,
            id: "merged",
            state: "merged",
          },
          {
            ...unfinished,
            id: "available",
            queueState: "active",
            state: "open",
          },
        ],
        "current",
      )?.id,
    ).toBe("available");
  });
});

describe("ReviewCompletion", () => {
  it("contains focus within an accessible modal and restores it on close", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const user = userEvent.setup();
    const { unmount } = render(
      <ReviewCompletion
        completedFiles={7}
        completedUnits={24}
        dashboardShortcut={[{ key: "g" }, { key: "r" }]}
        dismissShortcut={[{ key: "Escape" }]}
        nextReview={reviews[3]}
        nextReviewShortcut={[{ key: "n", shift: true }]}
        providerReview={<div>Provider approval</div>}
        queueLoading={false}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Review complete." });
    const dismiss = screen.getByRole("button", {
      name: "Close summary and browse reviewed files",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dismiss).toHaveFocus();

    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: /Review next PR/i }),
    ).toHaveFocus();

    await user.tab();
    expect(dismiss).toHaveFocus();

    outside.focus();
    expect(dismiss).toHaveFocus();
    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("summarizes the accomplishment and continues to the next review", async () => {
    const onNextReview = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewCompletion
        completedFiles={7}
        completedUnits={24}
        dashboardShortcut={[{ key: "g" }, { key: "r" }]}
        dismissShortcut={[{ key: "Escape" }]}
        nextReview={reviews[3]}
        nextReviewShortcut={[{ key: "n", shift: true }]}
        providerReview={<div>Provider approval</div>}
        queueLoading={false}
        onDashboard={vi.fn()}
        onDismiss={vi.fn()}
        onNextReview={onNextReview}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Review complete." }),
    ).toBeVisible();
    expect(screen.getByText("24")).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("Tighten the review queue")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Review next PR/i }));
    expect(onNextReview).toHaveBeenCalledOnce();
  });

  it("makes the cleared queue explicit and keeps inbox navigation available", async () => {
    const onDashboard = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewCompletion
        completedFiles={3}
        completedUnits={8}
        dashboardShortcut={[{ key: "g" }, { key: "r" }]}
        dismissShortcut={[{ key: "Escape" }]}
        nextReviewShortcut={[{ key: "n", shift: true }]}
        providerReview={<div>Provider approval</div>}
        queueLoading={false}
        onDashboard={onDashboard}
        onDismiss={vi.fn()}
        onNextReview={vi.fn()}
      />,
    );

    expect(screen.getByText("Your review queue is clear")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Review next PR/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Pull requests/i }));
    expect(onDashboard).toHaveBeenCalledOnce();
  });
});
