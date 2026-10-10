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

// A lifecycle fetch may see a moved head even when the parallel metadata read
// still sees the reviewed revision. Both normal and bypass merges stay gated.
describe("scopedProviderLifecycle", () => {
  it.each(["next-head", "head"])(
    "gates merge and bypass on all live revisions: %s",
    async (liveHead) => {
      const { scopedProviderLifecycle } = await import("./provider-thread");
      const result = scopedProviderLifecycle(
        {
          connection: {
            id: "connection",
            credentialKind: "pat",
            provider: "github",
          },
          headSha: "head",
          baseSha: "base",
          snapshot: { headSha: "head", baseSha: "base" },
        },
        {
          checks: [],
          summary: "empty",
          pullRequestState: "open",
          headSha: liveHead,
          mergeable: true,
          canMerge: true,
          hasMergePermission: true,
          mergeActionLabel: "Merge",
          mergeBypassPermission: "allowed",
          canBypassMergeRequirements: true,
        },
        { headSha: "head", baseSha: "base" },
      );
      expect(result.revisionCurrent).toBe(liveHead === "head");
      expect(result.canMerge).toBe(liveHead === "head");
      expect(result.canBypassMergeRequirements).toBe(liveHead === "head");
    },
  );
});
