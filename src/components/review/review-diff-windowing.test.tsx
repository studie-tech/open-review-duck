// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainLines } from "~/lib/highlight-tokens";
import { SideBySideUnitDiff } from "./review-workspace-diff";

vi.mock("~/lib/syntax-highlighting", () => ({
  useHighlightedSource: (source: string) => plainLines(source),
}));

const blocks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

beforeEach(() => {
  blocks.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      /** Retains callbacks so tests can simulate scrolling past a block. */
      constructor(
        callback: (entries: Array<{ isIntersecting: boolean }>) => void,
      ) {
        blocks.push(callback);
      }
      /** Does not need real browser geometry in jsdom. */
      observe() {}
      /** Leaves callbacks available for test assertions. */
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const currentSource = Array.from(
  { length: 1_000 },
  (_, index) => `new value ${index + 1}`,
).join("\n");
const previousSource = Array.from(
  { length: 1_000 },
  (_, index) => `old value ${index + 1}`,
).join("\n");

/** Renders either a new file or a replacement with inline review details. */
function longDiff(
  added: boolean,
  pinnedLines?: readonly number[],
  onSelectReviewLine = vi.fn(),
) {
  return (
    <SideBySideUnitDiff
      previousSource={added ? "" : previousSource}
      currentSource={currentSource}
      language="text"
      previousStartLine={1}
      currentStartLine={1}
      expanded
      pinnedLines={pinnedLines}
      onSelectReviewLine={onSelectReviewLine}
      renderBeforeLine={(line) => <div>Unit heading {line}</div>}
      renderLineDetails={(line) => <div>Review details {line}</div>}
    />
  );
}

describe.each([true, false])("diff windowing (added=%s)", (added) => {
  it("mounts a bounded first paint and reveals the last block on approach", () => {
    render(longDiff(added));
    expect(screen.getByText("new value 1")).toBeInTheDocument();
    expect(screen.getByText("new value 200")).toBeInTheDocument();
    expect(screen.queryByText("new value 201")).not.toBeInTheDocument();
    expect(screen.queryByText("new value 1000")).not.toBeInTheDocument();
    act(() => blocks.at(-1)?.([{ isIntersecting: true }]));
    expect(screen.getByText("new value 1000")).toBeInTheDocument();
  });

  it("retains unit labels, comments and anchors after a block remounts", () => {
    render(longDiff(added));
    act(() => blocks[0]?.([{ isIntersecting: false }]));
    expect(screen.queryByText("Unit heading 1")).not.toBeInTheDocument();
    act(() => blocks[0]?.([{ isIntersecting: true }]));
    expect(screen.getAllByText("Unit heading 1")).toHaveLength(1);
    expect(screen.getAllByText("Review details 1")).toHaveLength(1);
    expect(document.getElementById("review-line-1")).toBeInTheDocument();
  });

  it("mounts navigation targets and keeps their inline actions usable", () => {
    const onSelectReviewLine = vi.fn();
    const { rerender } = render(longDiff(added));
    expect(document.getElementById("review-line-751")).not.toBeInTheDocument();
    rerender(longDiff(added, [751], onSelectReviewLine));
    expect(document.getElementById("review-line-751")).toBeInTheDocument();
    expect(screen.getByText("Review details 751")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open actions for current line 751" }),
    );
    expect(onSelectReviewLine).toHaveBeenCalledWith(751);
  });
});
