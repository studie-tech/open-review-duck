import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./token-usage";

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
