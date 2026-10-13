// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movedCodeRanges } from "~/lib/moved-code";
import type { ReviewMode } from "~/lib/review-files";
import { ReviewModeSwitch } from "./review-mode-switch";
import { ReviewMovedCodeToggle } from "./review-moved-code-toggle";
import { SideBySideUnitDiff } from "./review-workspace-diff";
import { ReviewConceptFileCardPreview } from "./review-workspace-source";
import { useDimMovedCode } from "./use-dim-moved-code";

vi.mock("~/lib/syntax-highlighting", () => ({
  useHighlightedSource: (source: string) =>
    source.split("\n").map((text) => ({
      text,
      tokens: [{ text, className: "", from: 0, to: text.length }],
    })),
}));

let wide = true;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: wide,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

const oldSource =
  "export function shippingCost(total: number) {\n  if (total >= 50) return 0;\n  return 5;\n}";
const newSource = oldSource.replace("50", "75");
const ranges = movedCodeRanges([
  { path: "old.ts", previousSource: oldSource, currentSource: "" },
  { path: "new.ts", previousSource: "", currentSource: newSource },
]);

/** Exercises the real preference, navigation switch and shared renderer together. */
function DisplayHarness() {
  const [mode, setMode] = useState<ReviewMode>("files");
  const { dimMovedCode, changeDimMovedCode } = useDimMovedCode();
  return (
    <>
      <ReviewModeSwitch mode={mode} onChange={setMode} />
      <ReviewMovedCodeToggle
        checked={dimMovedCode}
        onChange={changeDimMovedCode}
      />
      <SideBySideUnitDiff
        key={mode}
        previousSource=""
        currentSource={newSource}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        movedLines={dimMovedCode ? ranges[1] : undefined}
        onSelectReviewLine={vi.fn()}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  wide = true;
  vi.restoreAllMocks();
});

describe("Dim moved code", () => {
  it("dims a deleted neighbor card on the base side without repeating its stored source on the head", () => {
    render(
      <ReviewConceptFileCardPreview
        members={
          [
            {
              id: "deleted-unit",
              path: "old.ts",
              language: "typescript",
              kind: "function",
              name: "shippingCost",
              startLine: 1,
              endLine: 4,
              changeType: "deleted",
              source: oldSource,
              previousSource: oldSource,
              changedLineCount: 4,
              status: "pending",
            },
          ] as never
        }
        index={0}
        count={1}
        fileSource={oldSource}
        previousFileSource={oldSource}
        movedLines={ranges[0]}
        onSelect={vi.fn()}
        onCommentLine={vi.fn()}
      />,
    );
    expect(screen.getAllByText(oldSource.split("\n")[0] ?? "")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Open actions for deleted line 1" }),
    ).toHaveClass("grayscale");
    expect(
      screen.getByRole("button", { name: "Open actions for deleted line 2" }),
    ).not.toHaveClass("grayscale");
    expect(
      screen.queryByRole("button", { name: "Open actions for current line 1" }),
    ).not.toBeInTheDocument();
  });
  it("keeps the setting and edited lines highlighted across Files and Guided and a reload", () => {
    const view = render(<DisplayHarness />);
    const toggle = screen.getByRole("button", { name: "Dim moved code" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    const moved = screen.getByRole("button", {
      name: "Open actions for current line 1",
    });
    const edited = screen.getByRole("button", {
      name: "Open actions for current line 2",
    });
    expect(moved).toHaveClass("grayscale");
    expect(edited).not.toHaveClass("grayscale");
    fireEvent.click(screen.getByRole("tab", { name: "Guided" }));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Open actions for current line 1" }),
    ).toHaveClass("grayscale");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    view.unmount();
    render(<DisplayHarness />);
    expect(
      screen.getByRole("button", { name: "Dim moved code" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dim moved code" }));
    expect(
      screen.getByRole("button", { name: "Open actions for current line 1" }),
    ).not.toHaveClass("grayscale");
  });

  it.each([true, false])(
    "dims each side separately in the wide=%s layout without disabling line actions",
    (isWide) => {
      wide = isWide;
      const onSelect = vi.fn();
      render(
        <SideBySideUnitDiff
          previousSource={oldSource}
          currentSource=""
          language="typescript"
          previousStartLine={36}
          currentStartLine={1}
          movedLines={{
            previous: [
              { startLine: 36, endLine: 36 },
              { startLine: 38, endLine: 39 },
            ],
            current: [],
          }}
          onSelectReviewLine={onSelect}
        />,
      );
      const moved = screen.getByRole("button", {
        name: "Open actions for deleted line 36",
      });
      expect(moved).toHaveClass("grayscale");
      expect(
        screen.getByRole("button", {
          name: "Open actions for deleted line 37",
        }),
      ).not.toHaveClass("grayscale");
      fireEvent.click(moved);
      expect(onSelect).toHaveBeenCalledWith(36);
    },
  );

  it("preserves finding and keyboard colors above the gray treatment", () => {
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={newSource}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        movedLines={ranges[1]}
        findingLine={1}
        keyboardLine={3}
        onSelectReviewLine={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open actions for current line 1" }),
    ).not.toHaveClass("grayscale");
    expect(
      screen.getByRole("button", { name: "Open actions for current line 3" }),
    ).not.toHaveClass("grayscale");
    expect(
      screen.getByRole("button", { name: "Open actions for current line 4" }),
    ).toHaveClass("grayscale");
  });

  it("keeps the toggle usable when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<DisplayHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Dim moved code" }));
    fireEvent.click(screen.getByRole("tab", { name: "Guided" }));
    expect(
      screen.getByRole("button", { name: "Dim moved code" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
