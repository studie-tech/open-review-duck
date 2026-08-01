import { describe, expect, it } from "vitest";
import { partitionReviewQueue } from "./review-queue";

const item = {
  queueState: "active" as const,
  state: "open" as const,
  signedUnits: 0,
  totalUnits: 3,
};

describe("partitionReviewQueue", () => {
  it("keeps only active unfinished work in needs-review", () => {
    const result = partitionReviewQueue([
      { ...item, id: "active" },
      { ...item, id: "reviewed", signedUnits: 3 },
      { ...item, id: "merged", state: "merged" as const },
      { ...item, id: "removed", queueState: "removed" as const },
    ]);

    expect(result.needsReview.map(({ id }) => id)).toEqual(["active"]);
    expect(result.reviewed.map(({ id }) => id)).toEqual(["reviewed"]);
    expect(result.closed.map(({ id }) => id)).toEqual(["merged"]);
    expect(result.removed.map(({ id }) => id)).toEqual(["removed"]);
  });

  it("does not place closed removed work in two history sections", () => {
    const result = partitionReviewQueue([
      {
        ...item,
        id: "closed-removed",
        state: "closed" as const,
        queueState: "removed" as const,
      },
    ]);

    expect(result.closed).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
  });
});
