import { describe, expect, it } from "vitest";
import { isPeekableToken, peekPlacement } from "./symbol-peek";

describe("peekable tokens", () => {
  it.each([
    ["tok-function", "retryRequest"],
    ["tok-typeName", "RetryPolicy"],
    ["tok-variableName", "retries"],
    ["", "helper"],
    ["tok-variableName tok-local", "scoped"],
  ])("looks up a %s token named %s", (className, text) => {
    expect(isPeekableToken({ className, text })).toBe(true);
  });

  it.each([
    ["tok-keyword", "const"],
    ["tok-typeName", "string"],
    ["tok-string", "retryRequest"],
    ["tok-comment", "retryRequest"],
    ["tok-number", "42"],
    ["tok-operator", "=>"],
    ["", "3"],
    ["", "  "],
    ["", "user.name"],
  ])("leaves a %s token holding %s alone", (className, text) => {
    expect(isPeekableToken({ className, text })).toBe(false);
  });

  it("treats a keyword as a keyword whatever its casing", () => {
    expect(isPeekableToken({ className: "", text: "Class" })).toBe(false);
  });
});

describe("definition card placement", () => {
  const viewport = { height: 900, width: 1400 };

  it("sits under the name when there is room", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 200, top: 284 },
      viewport,
    );

    expect(placement.placement).toBe("below");
    expect(placement.top).toBe(306);
    expect(placement.left).toBe(200);
  });

  it("flips above a name near the bottom of the viewport", () => {
    const placement = peekPlacement(
      { bottom: 880, left: 200, top: 864 },
      viewport,
    );

    expect(placement.placement).toBe("above");
    expect(placement.top).toBe(858);
  });

  it("keeps a card anchored to the right edge inside the viewport", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 1380, top: 284 },
      viewport,
    );

    expect(placement.left).toBe(1400 - 460 - 12);
  });

  it("never places a card off the left edge of a narrow viewport", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 4, top: 284 },
      { height: 900, width: 380 },
    );

    expect(placement.left).toBe(12);
  });

  it("gives the card the taller side when neither side is roomy", () => {
    const placement = peekPlacement(
      { bottom: 250, left: 10, top: 234 },
      { height: 300, width: 1400 },
    );

    expect(placement.placement).toBe("above");
    expect(placement.maxHeight).toBe(222);
  });
});
