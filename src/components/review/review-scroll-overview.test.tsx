// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampOverviewRatio,
  overviewMarksFromDiffRows,
  overviewRangeFromDiffRows,
  overviewViewportFromElements,
  ReviewScrollOverview,
  seekOverviewRatio,
} from "./review-scroll-overview";

afterEach(cleanup);

describe("overviewMarksFromDiffRows", () => {
  it("coalesces consecutive changed rows of the same kind", () => {
    expect(
      overviewMarksFromDiffRows([
        { kind: "unchanged" },
        { kind: "added" },
        { kind: "added" },
        { kind: "deleted" },
        { kind: "unchanged" },
      ]),
    ).toEqual([
      { end: 0.6, kind: "added", start: 0.2 },
      { end: 0.8, kind: "deleted", start: 0.6 },
    ]);
  });

  it("returns no marks for an empty or unchanged file", () => {
    expect(overviewMarksFromDiffRows([])).toEqual([]);
    expect(
      overviewMarksFromDiffRows([{ kind: "unchanged" }, { kind: "unchanged" }]),
    ).toEqual([]);
  });
});

describe("overviewRangeFromDiffRows", () => {
  it("places the unit band on current-side lines", () => {
    expect(
      overviewRangeFromDiffRows(
        [
          { kind: "unchanged", currentIndex: 0 },
          { kind: "added", currentIndex: 1 },
          { kind: "added", currentIndex: 2 },
          { kind: "unchanged", currentIndex: 3 },
        ],
        2,
        3,
      ),
    ).toEqual({ end: 0.75, start: 0.25 });
  });

  it("falls back to previous-side lines when a row has no current line", () => {
    expect(
      overviewRangeFromDiffRows(
        [
          { kind: "unchanged", previousIndex: 0 },
          { kind: "deleted", previousIndex: 1 },
          { kind: "deleted", previousIndex: 2 },
        ],
        2,
        3,
      ),
    ).toEqual({ end: 1, start: 1 / 3 });
  });
});

describe("overviewViewportFromElements", () => {
  it("maps the pane's intersection with the code root", () => {
    expect(
      overviewViewportFromElements(
        {
          getBoundingClientRect: () => ({
            bottom: 400,
            top: 100,
          }),
        } as Pick<Element, "getBoundingClientRect">,
        {
          getBoundingClientRect: () => ({
            height: 1000,
            top: 0,
          }),
        } as Pick<Element, "getBoundingClientRect">,
      ),
    ).toEqual({ end: 0.4, start: 0.1 });
  });

  it("clamps a pane that sits past either end of the file", () => {
    expect(clampOverviewRatio(-0.2)).toBe(0);
    expect(clampOverviewRatio(1.4)).toBe(1);
  });
});

describe("seekOverviewRatio", () => {
  it("centers the requested file position in the pane", () => {
    const scrollTo = vi.fn();
    seekOverviewRatio(
      { clientHeight: 200, scrollTo },
      { offsetHeight: 800, offsetTop: 40 },
      0.5,
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 340 });
  });
});

describe("ReviewScrollOverview", () => {
  it("exposes the visible window and seeks on click", () => {
    const onSeek = vi.fn();
    render(
      <ReviewScrollOverview
        label="Lines 1–40 of 200"
        marks={[{ end: 0.4, kind: "added", start: 0.2 }]}
        unitRange={{ end: 0.5, start: 0.1 }}
        viewport={{ end: 0.35, start: 0.1 }}
        onSeek={onSeek}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Lines 1–40 of 200" });
    expect(slider).toHaveAttribute("aria-valuenow", "10");
    expect(slider).toHaveAttribute("aria-valuetext", "10% to 35% of the file");
    expect(screen.getByText("Added")).toBeVisible();

    slider.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 100,
      }) as DOMRect;
    fireEvent.pointerDown(slider, { button: 0, clientX: 75 });
    expect(onSeek).toHaveBeenCalledWith(0.75);
  });

  it("moves the window from the keyboard", () => {
    const onSeek = vi.fn();
    render(
      <ReviewScrollOverview
        marks={[]}
        viewport={{ end: 0.3, start: 0.2 }}
        onSeek={onSeek}
      />,
    );

    const slider = screen.getByRole("slider", {
      name: "Visible region of this file",
    });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(0.29);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onSeek).toHaveBeenCalledWith(0);
  });
});
