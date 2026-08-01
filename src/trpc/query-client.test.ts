import { describe, expect, it } from "vitest";
import { shouldRetryQuery } from "./query-client";

describe("shouldRetryQuery", () => {
  it("does not retry rate limits or other expected client rejections", () => {
    expect(shouldRetryQuery(0, { data: { code: "TOO_MANY_REQUESTS" } })).toBe(
      false,
    );
    expect(shouldRetryQuery(0, { data: { code: "FORBIDDEN" } })).toBe(false);
  });

  it("retries transient failures at most three times", () => {
    expect(shouldRetryQuery(0, new Error("network"))).toBe(true);
    expect(
      shouldRetryQuery(2, { data: { code: "INTERNAL_SERVER_ERROR" } }),
    ).toBe(true);
    expect(shouldRetryQuery(3, new Error("network"))).toBe(false);
  });
});
