import { describe, expect, it, vi } from "vitest";
import { pruneExpiredAiStreamLeases } from "./stream-leases";

describe("AI stream lease maintenance", () => {
  it("returns the number of expired leases removed", async () => {
    const returning = vi.fn(async () => [{ id: "one" }, { id: "two" }]);
    const where = vi.fn(() => ({ returning }));
    const database = { delete: vi.fn(() => ({ where })) };

    await expect(pruneExpiredAiStreamLeases(database as never)).resolves.toBe(
      2,
    );
    expect(where).toHaveBeenCalledOnce();
  });
});
