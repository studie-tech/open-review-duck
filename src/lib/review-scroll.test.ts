import { describe, expect, it, vi } from "vitest";
import {
  afterLayoutSettle,
  scrollTopAfterContextReveal,
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

describe("scrollTopAfterContextReveal", () => {
  it("keeps appended content below the fold and peeks downward", () => {
    expect(
      scrollTopAfterContextReveal({
        direction: 1,
        previousScrollTop: 400,
        previousScrollHeight: 800,
        nextScrollHeight: 1200,
        viewportHeight: 400,
        step: 72,
      }),
    ).toBe(540);
  });

  it("preserves prepended content and peeks upward", () => {
    expect(
      scrollTopAfterContextReveal({
        direction: -1,
        previousScrollTop: 100,
        previousScrollHeight: 800,
        nextScrollHeight: 1200,
        viewportHeight: 400,
        step: 72,
      }),
    ).toBe(360);
  });

  it("does not overscroll when only a few lines were revealed", () => {
    expect(
      scrollTopAfterContextReveal({
        direction: 1,
        previousScrollTop: 400,
        previousScrollHeight: 800,
        nextScrollHeight: 840,
        viewportHeight: 400,
        step: 72,
      }),
    ).toBe(440);
  });
});

describe("afterLayoutSettle", () => {
  it("waits until the measured value changes", () => {
    const queue: FrameRequestCallback[] = [];
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      queue.push(callback);
      return queue.length;
    }) as typeof requestAnimationFrame;
    let value = 10;
    const onSettle = vi.fn();
    afterLayoutSettle(() => value, 10, onSettle);
    expect(onSettle).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
    value = 20;
    queue.shift()?.(0);
    expect(onSettle).toHaveBeenCalledOnce();
    globalThis.requestAnimationFrame = original;
  });
});
