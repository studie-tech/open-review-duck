import { describe, expect, it } from "vitest";
import { takeOptimisticActionBatch } from "./optimistic-action-queue";

describe("optimistic action queue", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [20, 20],
    [21, 20],
    [100, 20],
  ])("takes %i queued saves as a batch of %i", (pendingCount, expected) => {
    const pending = Array.from({ length: pendingCount }, (_, index) => index);

    expect(takeOptimisticActionBatch(pending)).toHaveLength(expected);
    expect(pending).toHaveLength(pendingCount - expected);
  });

  it("sends the first action immediately and batches work stacked behind it", () => {
    const pending = ["first"];

    expect(takeOptimisticActionBatch(pending)).toEqual(["first"]);
    pending.push(
      ...Array.from({ length: 25 }, (_, index) => `queued-${index}`),
    );

    expect(takeOptimisticActionBatch(pending)).toHaveLength(20);
    expect(pending).toHaveLength(5);
  });
});
