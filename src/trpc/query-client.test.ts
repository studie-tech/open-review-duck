import { describe, expect, it } from "vitest";
import { createQueryClient } from "./query-client";

describe("query retry policy", () => {
  it("does not amplify an authentication failure after transport refresh", () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("retry policy missing");

    const unauthorized = Object.assign(new Error("UNAUTHORIZED"), {
      data: { code: "UNAUTHORIZED" },
    });
    expect(retry(0, unauthorized)).toBe(false);
    expect(retry(2, new Error("temporary failure"))).toBe(true);
    expect(retry(3, new Error("temporary failure"))).toBe(false);
  });
});
