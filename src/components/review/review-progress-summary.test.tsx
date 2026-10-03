// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewFileEntries } from "~/lib/review-files";
import type { ProgressUnit } from "~/lib/review-progress";
import { ReviewProgressSummary } from "./review-progress-summary";

const units: (ProgressUnit & { id: string; revisionState: "initial" })[] = [
  {
    id: "one",
    path: "app.ts",
    language: "typescript",
    kind: "function",
    status: "signed_off",
    changedLineCount: 216,
    revisionState: "initial",
  },
  {
    id: "two",
    path: "data.json",
    language: "json",
    kind: "file",
    status: "pending",
    changedLineCount: 44312,
    revisionState: "initial",
  },
];
const files = reviewFileEntries(
  units.map((unit) => ({
    id: unit.id,
    path: unit.path,
    previousPath: null,
    changeType: "modified",
    additions: unit.changedLineCount,
    deletions: 0,
    isBinary: false,
    skipReason: null,
  })),
  units,
);

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      /** Accepts layout observation in jsdom. */
      observe() {}
      /** Releases the fake observer. */
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("review progress summary", () => {
  it("shows stable progress rows and moves large line counts into a keyboard-dismissable popup", () => {
    render(
      <ReviewProgressSummary
        files={files}
        units={units}
        mode="files"
        conceptsRemaining={0}
      />,
    );
    expect(screen.queryByText("Files reviewed")).not.toBeInTheDocument();
    expect(screen.queryByText("Units reviewed")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("modified")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Review details" });
    fireEvent.click(trigger);
    const popup = screen.getByRole("dialog", { name: "Review details" });
    expect(within(popup).getByText("Files reviewed")).toBeVisible();
    expect(within(popup).getByText("Units reviewed")).toBeVisible();
    expect(within(popup).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(within(popup).getByText("Code")).toBeVisible();
    expect(within(popup).getByText("Data & config")).toBeVisible();
    expect(
      within(popup.querySelectorAll("summary")[1] as HTMLElement).getByText(
        "44,312",
      ),
    ).toBeVisible();
    expect(within(popup).getByText("216 / 44,528")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close review details" }),
    ).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps small amounts of reviewed work visible in large PRs", () => {
    const first = units[0];
    if (!first) throw new Error("Missing review fixture");
    const large = Array.from({ length: 1000 }, (_, index) => ({
      ...first,
      status: index === 0 ? "signed_off" : "pending",
    }));
    render(
      <ReviewProgressSummary
        files={files}
        units={large}
        mode="files"
        conceptsRemaining={0}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0.1",
    );
  });

  it("updates live totals and dismisses on outside interaction", () => {
    const { rerender } = render(
      <ReviewProgressSummary
        files={files}
        units={units}
        mode="path"
        conceptsRemaining={3}
      />,
    );
    expect(screen.queryByText("Concepts remaining")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    rerender(
      <ReviewProgressSummary
        files={files}
        units={units.map((unit) => ({ ...unit, status: "signed_off" }))}
        mode="path"
        conceptsRemaining={0}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
