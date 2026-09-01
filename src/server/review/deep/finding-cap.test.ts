import { describe, expect, it } from "vitest";
import { findingCapacity } from "./finding-cap";

describe("findingCapacity", () => {
  it("releases reserved room when asynchronous preparation fails", async () => {
    const capacity = findingCapacity(1);

    await expect(
      capacity.withReservation(1, async (accepted) => {
        expect(accepted).toBe(1);
        throw new Error("injected preparation failure");
      }),
    ).rejects.toThrow("injected preparation failure");
    await expect(
      capacity.withReservation(1, async (accepted) => accepted),
    ).resolves.toBe(1);
  });
});
