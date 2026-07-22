import { describe, expect, it, vi } from "vitest";
import { drainAiDispatches } from "./service";

vi.mock("~/env", () => ({ env: {} }));

describe("drainAiDispatches", () => {
  it("coalesces wake-ups and defaults to one local agent execution", async () => {
    let releaseQuery: (() => void) | undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const findMany = vi.fn(async () => {
      await queryGate;
      return [];
    });
    const database = {
      query: {
        aiDispatches: { findMany },
      },
    };

    const first = drainAiDispatches(database as never);
    const second = drainAiDispatches(database as never);
    releaseQuery?.();

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });
});
