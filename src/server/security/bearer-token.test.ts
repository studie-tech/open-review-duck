import { describe, expect, it } from "vitest";
import { hasBearerToken } from "./bearer-token";

describe("hasBearerToken", () => {
  it("accepts only the complete expected bearer token", () => {
    expect(hasBearerToken("Bearer local-secret", "local-secret")).toBe(true);
    expect(hasBearerToken("Bearer local-secrex", "local-secret")).toBe(false);
    expect(hasBearerToken("Bearer short", "local-secret")).toBe(false);
    expect(hasBearerToken("Basic local-secret", "local-secret")).toBe(false);
    expect(hasBearerToken(null, "local-secret")).toBe(false);
    expect(hasBearerToken("Bearer local-secret", undefined)).toBe(false);
  });
});
