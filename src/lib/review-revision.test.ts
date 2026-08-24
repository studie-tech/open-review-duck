import { describe, expect, it } from "vitest";
import {
  acknowledgedReviewRevision,
  acknowledgeReviewRevision,
  rememberedReviewPosition,
  rememberReviewPosition,
  shortRevision,
} from "./review-revision";

/** Creates a small in-memory implementation of the storage methods under test. */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("review revision acknowledgement", () => {
  it("round-trips the acknowledged revision for one pull request", () => {
    const storage = memoryStorage();
    const revision = {
      headSha: "a8cbd45ea14abda",
      snapshotId: "snapshot-24",
      version: 24,
    };

    acknowledgeReviewRevision(storage, "pr-1", revision);

    expect(acknowledgedReviewRevision(storage, "pr-1")).toEqual(revision);
    expect(acknowledgedReviewRevision(storage, "pr-2")).toBeUndefined();
  });

  it("ignores malformed persisted values", () => {
    const storage = memoryStorage();
    storage.setItem("reviewduck:review-revision:pr-1", '{"version":"24"}');

    expect(acknowledgedReviewRevision(storage, "pr-1")).toBeUndefined();
  });

  it("uses the conventional seven-character revision label", () => {
    expect(shortRevision("a8cbd45ea14abda")).toBe("a8cbd45");
  });

  it("remembers a review cursor only for its exact snapshot", () => {
    const storage = memoryStorage();

    rememberReviewPosition(storage, "pr-1", "snapshot-2", "unit-7");

    expect(rememberedReviewPosition(storage, "pr-1", "snapshot-2")).toBe(
      "unit-7",
    );
    expect(
      rememberedReviewPosition(storage, "pr-1", "snapshot-3"),
    ).toBeUndefined();
    expect(
      rememberedReviewPosition(storage, "pr-2", "snapshot-2"),
    ).toBeUndefined();
  });

  it("ignores a malformed review cursor", () => {
    const storage = memoryStorage();
    storage.setItem("reviewduck:review-position:pr-1", '{"unitId":42}');

    expect(
      rememberedReviewPosition(storage, "pr-1", "snapshot-2"),
    ).toBeUndefined();
  });
});
