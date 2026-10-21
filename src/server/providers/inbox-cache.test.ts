import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedInboxDiscovery } from "./inbox-cache";

const result = {
  pullRequests: [],
  errors: [],
  repositoryCount: 1,
  mergeConflictKeys: [],
};

afterEach(() => vi.useRealTimers());

describe("inbox discovery cache", () => {
  it("deduplicates concurrent reads and reuses the result for a short burst", async () => {
    const database = {};
    /** Completes the provider read once both callers are waiting for it. */
    let finish = (_value: typeof result) => {};
    const load = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    const first = cachedInboxDiscovery(database, "workspace", "viewer", load);
    const second = cachedInboxDiscovery(database, "workspace", "viewer", load);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    finish(result);
    await expect(first).resolves.toEqual(result);
    await expect(
      cachedInboxDiscovery(database, "workspace", "viewer", load),
    ).resolves.toEqual(result);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes five seconds after completion, including a slow provider read", async () => {
    vi.useFakeTimers();
    const database = {};
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return result;
    });
    const first = cachedInboxDiscovery(database, "workspace", "viewer", load);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    await vi.advanceTimersByTimeAsync(4_999);
    await cachedInboxDiscovery(database, "workspace", "viewer", load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const refreshed = cachedInboxDiscovery(
      database,
      "workspace",
      "viewer",
      load,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await refreshed;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("isolates databases, workspaces, and reviewers", async () => {
    const database = {};
    const load = vi.fn(async () => result);
    await cachedInboxDiscovery(database, "workspace", "viewer", load);
    await cachedInboxDiscovery(database, "workspace", "other-viewer", load);
    await cachedInboxDiscovery(database, "other-workspace", "viewer", load);
    await cachedInboxDiscovery({}, "workspace", "viewer", load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not retain rejected reads or partial provider failures", async () => {
    const database = {};
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({
        ...result,
        errors: [
          {
            message: "unavailable",
            repositoryId: "repo",
            repositoryName: "app",
            repositoryOwner: "acme",
          },
        ],
      })
      .mockResolvedValue(result);
    await expect(
      cachedInboxDiscovery(database, "workspace", "viewer", load),
    ).rejects.toThrow("rate limited");
    expect(
      (await cachedInboxDiscovery(database, "workspace", "viewer", load))
        .errors,
    ).toHaveLength(1);
    await expect(
      cachedInboxDiscovery(database, "workspace", "viewer", load),
    ).resolves.toEqual(result);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
