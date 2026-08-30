// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampOverviewRatio,
  overviewMarksFromDiffRows,
  overviewRangeFromDiffRows,
  overviewViewportFromElements,
  ReviewScrollOverview,
  ReviewScrollOverviewStrip,
  seekOverviewRatio,
  shouldShowReviewScrollOverview,
  useReviewCodeOverview,
} from "./review-scroll-overview";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("shouldShowReviewScrollOverview", () => {
  const mixed = [
    { kind: "unchanged" as const },
    { kind: "added" as const },
    { kind: "unchanged" as const },
  ];

  it("hides a file that is only additions or only deletions", () => {
    expect(
      shouldShowReviewScrollOverview([{ kind: "added" }, { kind: "added" }], {
        end: 0.4,
        start: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowReviewScrollOverview(
        [{ kind: "deleted" }, { kind: "deleted" }],
        { end: 0.4, start: 0 },
      ),
    ).toBe(false);
  });

  it("hides a mixed file that already fits in the pane", () => {
    expect(shouldShowReviewScrollOverview(mixed, { end: 1, start: 0 })).toBe(
      false,
    );
  });

  it("shows a mixed file when some of it is off-screen", () => {
    expect(shouldShowReviewScrollOverview(mixed, { end: 0.4, start: 0 })).toBe(
      true,
    );
    expect(shouldShowReviewScrollOverview(mixed, { end: 1, start: 0.2 })).toBe(
      true,
    );
  });

  it("keeps a mixed file mapped after the reviewer opens the whole file", () => {
    expect(
      shouldShowReviewScrollOverview(
        mixed,
        { end: 1, start: 0 },
        {
          revealWholeFile: true,
        },
      ),
    ).toBe(true);
    expect(
      shouldShowReviewScrollOverview(
        [{ kind: "added" }, { kind: "added" }],
        { end: 1, start: 0 },
        { revealWholeFile: true },
      ),
    ).toBe(false);
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

class StubResizeObserver {
  /** Ignores observation; the harness drives measurement by hand. */
  observe() {}

  /** Ignores teardown; the harness drives measurement by hand. */
  disconnect() {}
}

describe("useReviewCodeOverview", () => {
  /** Builds a code pane whose scroll offset the test controls. */
  function createPane() {
    const pane = document.createElement("div");
    const code = document.createElement("div");
    const position = { top: 0 };
    Object.defineProperty(pane, "scrollTop", { get: () => position.top });
    pane.getBoundingClientRect = () => ({ bottom: 100, top: 0 }) as DOMRect;
    code.getBoundingClientRect = () =>
      ({ height: 400, top: -position.top }) as DOMRect;
    return { code, pane, position };
  }

  it("moves the ruler without re-rendering the pane owner", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { code, pane, position } = createPane();
    const onRender = vi.fn();
    const updateRef = { current: () => {} };

    /** Renders the hook alongside the strip that consumes its viewport. */
    function Harness() {
      const { update, viewport } = useReviewCodeOverview(
        { current: pane },
        { current: code },
        "unit",
      );
      updateRef.current = update;
      onRender();
      return (
        <ReviewScrollOverviewStrip
          marks={[]}
          rows={[{ kind: "unchanged" }, { kind: "added" }]}
          viewport={viewport}
          onSeek={() => {}}
        />
      );
    }

    /** Runs every animation frame the hook has queued. */
    function flushFrames() {
      const pending = frames.splice(0, frames.length);
      act(() => {
        for (const callback of pending) callback(0);
      });
    }

    render(<Harness />);
    expect(screen.queryByRole("slider")).toBeNull();

    flushFrames();
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "0% to 25% of the file",
    );
    expect(onRender).toHaveBeenCalledTimes(1);

    position.top = 40;
    act(() => updateRef.current());
    flushFrames();
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "10% to 35% of the file",
    );

    position.top = 80;
    act(() => updateRef.current());
    flushFrames();
    const rendersWhileScrolling = onRender.mock.calls.length;

    position.top = 120;
    act(() => updateRef.current());
    flushFrames();
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "30% to 55% of the file",
    );
    expect(onRender).toHaveBeenCalledTimes(rendersWhileScrolling);
  });
});
