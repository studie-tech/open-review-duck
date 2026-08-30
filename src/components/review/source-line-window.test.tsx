// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SourceLineWindow,
  WINDOWED_SOURCE_LINE_COUNT,
} from "./source-line-window";

type IntersectionReport = (entries: Array<{ isIntersecting: boolean }>) => void;

const observedBlocks: Array<{
  element: Element;
  report: IntersectionReport;
}> = [];

/** Stands in for the browser observer so a test drives block mounting itself. */
class TestIntersectionObserver {
  private readonly callback: IntersectionReport;

  /** Keeps the callback so observed blocks can report through it. */
  constructor(callback: IntersectionReport) {
    this.callback = callback;
  }

  /** Records a block in document order for the test to report on. */
  observe(element: Element) {
    observedBlocks.push({ element, report: this.callback });
  }

  /** Drops every block this observer was watching. */
  disconnect() {
    for (let index = observedBlocks.length - 1; index >= 0; index -= 1) {
      if (observedBlocks[index]?.report === this.callback) {
        observedBlocks.splice(index, 1);
      }
    }
  }
}

beforeEach(() => {
  observedBlocks.length = 0;
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders one identifiable row per line so a test can ask what is mounted. */
function renderLines(count: number, pinnedLines?: readonly number[]) {
  return render(
    <SourceLineWindow
      items={Array.from({ length: count }, (_, index) => index)}
      pinnedLines={pinnedLines}
      rowHeight={21}
      startLine={1}
      renderLine={(_, lineNumber) => (
        <div key={lineNumber} data-testid={`line-${lineNumber}`} />
      )}
    />,
  );
}

/** Reports intersection for one observed block, newest observation wins. */
function reportIntersection(block: number, isIntersecting: boolean) {
  const observed = observedBlocks[block];
  if (!observed) throw new Error(`block ${block} is not observed`);
  act(() => observed.report([{ isIntersecting }]));
}

describe("SourceLineWindow", () => {
  it("mounts every line of source short enough to read at once", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT);
    expect(screen.getByTestId("line-1")).toBeInTheDocument();
    expect(
      screen.getByTestId(`line-${WINDOWED_SOURCE_LINE_COUNT}`),
    ).toBeInTheDocument();
    expect(observedBlocks).toHaveLength(0);
  });

  it("mounts only the leading blocks of longer source", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT + 1);
    expect(screen.getByTestId("line-1")).toBeInTheDocument();
    expect(screen.getByTestId("line-200")).toBeInTheDocument();
    expect(screen.queryByTestId("line-201")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`line-${WINDOWED_SOURCE_LINE_COUNT + 1}`),
    ).not.toBeInTheDocument();
  });

  it("reserves the height of the lines it has not mounted", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT + 1);
    const trailing = observedBlocks.at(-1)?.element;
    expect(trailing).toHaveStyle({ height: "21px" });
    expect(observedBlocks[4]?.element).toHaveStyle({ height: "1050px" });
  });

  it("mounts a block once it comes near the viewport", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT + 1);
    reportIntersection(8, true);
    expect(
      screen.getByTestId(`line-${WINDOWED_SOURCE_LINE_COUNT + 1}`),
    ).toBeInTheDocument();
  });

  it("keeps a pinned line mounted however far down the file it sits", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT + 1, [380]);
    expect(screen.getByTestId("line-380")).toBeInTheDocument();
    expect(screen.queryByTestId("line-201")).not.toBeInTheDocument();
  });

  it("mounts a block that becomes pinned while it is out of the window", () => {
    const { rerender } = renderLines(WINDOWED_SOURCE_LINE_COUNT + 1);
    expect(screen.queryByTestId("line-380")).not.toBeInTheDocument();
    rerender(
      <SourceLineWindow
        items={Array.from(
          { length: WINDOWED_SOURCE_LINE_COUNT + 1 },
          (_, index) => index,
        )}
        pinnedLines={[380]}
        rowHeight={21}
        startLine={1}
        renderLine={(_, lineNumber) => (
          <div key={lineNumber} data-testid={`line-${lineNumber}`} />
        )}
      />,
    );
    expect(screen.getByTestId("line-380")).toBeInTheDocument();
  });

  it("holds a pinned block open when the observer reports it is away", () => {
    renderLines(WINDOWED_SOURCE_LINE_COUNT + 1, [380]);
    reportIntersection(7, false);
    expect(screen.getByTestId("line-380")).toBeInTheDocument();
  });

  it("gives back exactly the height a folded block had measured", () => {
    const height = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 1234,
    });
    try {
      renderLines(WINDOWED_SOURCE_LINE_COUNT + 1);
      reportIntersection(0, false);
      expect(screen.queryByTestId("line-1")).not.toBeInTheDocument();
      expect(observedBlocks[0]?.element).toHaveStyle({ height: "1234px" });
    } finally {
      if (height) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
      }
    }
  });
});
