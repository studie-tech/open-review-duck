import { describe, expect, it } from "vitest";
import { settleMaintenanceTasks } from "./maintenance-results";

describe("maintenance task settlement", () => {
  it("preserves successful results when another task fails", async () => {
    const result = await settleMaintenanceTasks({
      successful: async () => 3,
      failed: async () => {
        throw new Error("offline");
      },
    });

    expect(result).toEqual({
      failed: true,
      results: { successful: 3, failed: { error: "offline" } },
    });
  });
});
