import { describe, expect, it } from "vitest";
import {
  shouldRevealLeadingContext,
  verticalRangesOverlap,
} from "./review-scroll";

describe("verticalRangesOverlap", () => {
  it("recognizes the review unit start anywhere inside the code viewport", () => {
    expect(
      verticalRangesOverlap(
        { top: 100, bottom: 700 },
        { top: 640, bottom: 660 },
      ),
    ).toBe(true);
  });

  it("does not treat a unit above the viewport as visible", () => {
    expect(
      verticalRangesOverlap({ top: 100, bottom: 700 }, { top: 60, bottom: 80 }),
    ).toBe(false);
  });
});

describe("shouldRevealLeadingContext", () => {
  it("reveals local source context when imports occupy the physical scrollback", () => {
    expect(
      shouldRevealLeadingContext({
        atPhysicalBoundary: false,
        unitStartVisible: true,
        sideBySideVisible: false,
        contextAvailable: true,
        contextBefore: 0,
        availableBefore: 21,
      }),
    ).toBe(true);
  });

  it("keeps ordinary scrolling inside a longer review unit", () => {
    expect(
      shouldRevealLeadingContext({
        atPhysicalBoundary: false,
        unitStartVisible: false,
        sideBySideVisible: false,
        contextAvailable: true,
        contextBefore: 0,
        availableBefore: 21,
      }),
    ).toBe(false);
  });

  it("does not interfere with side-by-side diff context", () => {
    expect(
      shouldRevealLeadingContext({
        atPhysicalBoundary: true,
        unitStartVisible: true,
        sideBySideVisible: true,
        contextAvailable: true,
        contextBefore: 0,
        availableBefore: 21,
      }),
    ).toBe(false);
  });

  it("stops revealing context after the beginning of the file is visible", () => {
    expect(
      shouldRevealLeadingContext({
        atPhysicalBoundary: true,
        unitStartVisible: true,
        sideBySideVisible: false,
        contextAvailable: true,
        contextBefore: 21,
        availableBefore: 21,
      }),
    ).toBe(false);
  });
});
