import { describe, expect, it } from "vitest";
import { themePreference } from "./theme-preference";

describe("themePreference", () => {
  it("accepts only supported persisted values", () => {
    expect(themePreference("dark")).toBe("dark");
    expect(themePreference("light")).toBe("light");
    expect(themePreference("system")).toBeUndefined();
    expect(themePreference(undefined)).toBeUndefined();
  });
});
