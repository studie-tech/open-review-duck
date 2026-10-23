// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  reviewUnitIsCollapsed,
  reviewUnitStartsCollapsed,
} from "./review-file-card";
import { useReviewFileFolds } from "./use-review-file-folds";

afterEach(cleanup);

const first = {
  id: "first",
  path: "src/first.ts",
  status: "signed_off",
  signOffOrigin: "preserved",
};
const sibling = { ...first, id: "other-concept" };
const pending = { ...first, id: "pending", status: "pending" };
const otherFile = { ...first, id: "other-file", path: "src/other.ts" };
const units = [first, sibling, pending, otherFile];

/** Reads unit folds through the same status defaults used by both code views. */
function renderFolds(selectedUnit = first) {
  const initialProps: {
    selectedUnit: typeof first;
    inspected?: boolean;
  } = { selectedUnit };
  return renderHook(
    ({ selectedUnit, inspected = true }) => {
      const folds = useReviewFileFolds();
      return {
        ...folds,
        fullFileVisible: folds.fullFilePaths.has(selectedUnit.path),
        isCollapsed: (member: (typeof units)[number]) =>
          reviewUnitIsCollapsed({
            hasVisibleConversation: false,
            inspected,
            override: folds.unitFoldOverrides.get(member.id),
            startsCollapsed: reviewUnitStartsCollapsed(member),
            signOffOrigin: member.signOffOrigin,
          }),
      };
    },
    { initialProps, wrapper: StrictMode },
  );
}

describe("Full file folds", () => {
  it("restores automatic and manual folds after temporary chevron changes", () => {
    const { result } = renderFolds();
    act(() => {
      result.current.setUnitFoldOverrides(
        new Map([
          [sibling.id, false],
          [pending.id, true],
        ]),
      );
    });
    const previous = units.map(result.current.isCollapsed);
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    expect(result.current.fullFileVisible).toBe(true);
    expect([first, sibling, pending].map(result.current.isCollapsed)).toEqual([
      false,
      false,
      false,
    ]);
    expect(result.current.isCollapsed(otherFile)).toBe(true);
    act(() => {
      result.current.setUnitFoldOverrides((current) =>
        new Map(current).set(sibling.id, true),
      );
    });
    expect(result.current.isCollapsed(sibling)).toBe(true);
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    expect(result.current.fullFileVisible).toBe(false);
    expect(units.map(result.current.isCollapsed)).toEqual(previous);
  });

  it("keeps Full file and its original folds when another unit becomes selected", () => {
    const { result, rerender } = renderFolds();
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    rerender({ selectedUnit: sibling });
    expect(result.current.fullFileVisible).toBe(true);
    expect(result.current.isCollapsed(sibling)).toBe(false);
    act(() => {
      result.current.toggleFullFile(sibling.path, units);
    });
    expect(result.current.fullFileVisible).toBe(false);
    expect(result.current.isCollapsed(first)).toBe(true);
    expect(result.current.isCollapsed(sibling)).toBe(true);
  });

  it("keeps automatic folds responsive to later review-status changes", () => {
    const { result } = renderFolds();
    for (let toggle = 0; toggle < 2; toggle++) {
      act(() => {
        result.current.toggleFullFile(first.path, units);
      });
    }
    expect(result.current.isCollapsed({ ...first, status: "pending" })).toBe(
      false,
    );
    expect(
      result.current.isCollapsed({ ...pending, status: "signed_off" }),
    ).toBe(true);
  });

  it("does not pin inspected units open after the reviewer leaves the file", () => {
    const inspectedUnit = { ...first, signOffOrigin: "current" };
    const { result, rerender } = renderFolds(inspectedUnit);
    expect(result.current.isCollapsed(inspectedUnit)).toBe(false);
    for (let toggle = 0; toggle < 2; toggle++) {
      act(() => {
        result.current.toggleFullFile(first.path, [inspectedUnit]);
      });
    }
    rerender({ selectedUnit: otherFile, inspected: false });
    expect(result.current.isCollapsed(inspectedUnit)).toBe(true);
  });

  it("opens same-file units outside the current concept and survives file inspection", () => {
    const { result } = renderFolds();
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    expect(result.current.isCollapsed(sibling)).toBe(false);
    act(() => {
      result.current.clearUnitFoldOverrides(first.path, [first.id, sibling.id]);
    });
    expect(result.current.fullFileVisible).toBe(true);
    expect(result.current.isCollapsed(first)).toBe(false);
    expect(result.current.isCollapsed(sibling)).toBe(false);
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    expect(result.current.isCollapsed(sibling)).toBe(true);
  });

  it("keeps saved folds for different files independent", () => {
    const { result } = renderFolds();
    for (const member of [first, otherFile]) {
      act(() => {
        result.current.toggleFullFile(member.path, units);
      });
    }
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    expect(result.current.fullFilePaths.has(first.path)).toBe(false);
    expect(result.current.isCollapsed(first)).toBe(true);
    expect(result.current.fullFilePaths.has(otherFile.path)).toBe(true);
    expect(result.current.isCollapsed(otherFile)).toBe(false);
    act(() => {
      result.current.toggleFullFile(otherFile.path, units);
    });
    expect(result.current.isCollapsed(otherFile)).toBe(true);
  });

  it("clears saved views on revision changes and captures fresh folds next time", () => {
    const { result } = renderFolds();
    act(() => {
      result.current.toggleFullFile(first.path, units);
    });
    act(() => result.current.resetFileFolds());
    expect(result.current.fullFileVisible).toBe(false);
    expect(result.current.unitFoldOverrides.size).toBe(0);
    act(() => {
      result.current.setUnitFoldOverrides(new Map([[first.id, false]]));
    });
    for (let toggle = 0; toggle < 2; toggle++) {
      act(() => {
        result.current.toggleFullFile(first.path, units);
      });
    }
    expect(result.current.fullFileVisible).toBe(false);
    expect(result.current.isCollapsed(first)).toBe(false);
    act(() => result.current.clearUnitFoldOverrides(first.path, [first.id]));
    expect(result.current.isCollapsed(first)).toBe(true);
  });
});
