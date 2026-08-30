import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./concurrency";

describe("mapWithLimit", () => {
  it("limits concurrent operations and preserves ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
