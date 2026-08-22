import { describe, expect, it } from "vitest";
import { formatTokenCount, parseOptionalReviewTokenCap } from "./token-usage";

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_250, "1.3k"],
    [9_999, "10k"],
    [12_400, "12k"],
    [999_999, "1m"],
    [1_000_000, "1m"],
    [1_250_000, "1.3m"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe("parseOptionalReviewTokenCap", () => {
  it("treats an empty field as no limit", () => {
    expect(parseOptionalReviewTokenCap("")).toEqual({ cap: null, valid: true });
    expect(parseOptionalReviewTokenCap("  ")).toEqual({
      cap: null,
      valid: true,
    });
  });

  it("accepts a whole token count", () => {
    expect(parseOptionalReviewTokenCap("50000")).toEqual({
      cap: 50_000,
      valid: true,
    });
    expect(parseOptionalReviewTokenCap("50,000")).toEqual({
      cap: 50_000,
      valid: true,
    });
  });

  it("rejects zero, fractions, and overflow", () => {
    expect(parseOptionalReviewTokenCap("0").valid).toBe(false);
    expect(parseOptionalReviewTokenCap("1.5").valid).toBe(false);
    expect(parseOptionalReviewTokenCap("abc").valid).toBe(false);
    expect(parseOptionalReviewTokenCap("1000000001").valid).toBe(false);
  });
});
