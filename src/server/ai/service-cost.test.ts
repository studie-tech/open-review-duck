import { describe, expect, it } from "vitest";
import { paidReservationMicroUsd } from "./cost";

describe("paid AI reservation cost", () => {
  it("converts catalog nano-dollar token prices into conservative micro-dollars", () => {
    expect(
      paidReservationMicroUsd(
        { input: 1_500, output: 250 },
        {
          promptNanoUsdPerToken: 2_000,
          completionNanoUsdPerToken: 8_000,
        },
      ),
    ).toBe(5_000);
  });

  it("rounds fractional micro-dollar exposure upward", () => {
    expect(
      paidReservationMicroUsd(
        { input: 1, output: 0 },
        {
          promptNanoUsdPerToken: 1,
          completionNanoUsdPerToken: 0,
        },
      ),
    ).toBe(1);
  });
});
