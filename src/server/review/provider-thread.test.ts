import { describe, expect, it } from "vitest";
import { providerRevisionIsCurrent } from "./provider-thread";

describe("providerRevisionIsCurrent", () => {
  it("requires the remote, pull request, and snapshot to share one revision", () => {
    expect(
      providerRevisionIsCurrent(
        {
          headSha: "head",
          baseSha: "base",
          snapshot: { headSha: "head", baseSha: "base" },
        },
        { headSha: "head", baseSha: "base" },
      ),
    ).toBe(true);
    expect(
      providerRevisionIsCurrent(
        {
          headSha: "head",
          baseSha: "base",
          snapshot: { headSha: "head", baseSha: "base" },
        },
        { headSha: "next", baseSha: "base" },
      ),
    ).toBe(false);
    expect(
      providerRevisionIsCurrent(
        { headSha: "head", baseSha: "base", snapshot: null },
        { headSha: "head", baseSha: "base" },
      ),
    ).toBe(false);
  });
});
