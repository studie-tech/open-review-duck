import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrivateWorkspaceSourceStore,
  type WorkspaceSourcePriority,
} from "./private-workspace-source-store";

interface TestSource {
  id: string;
  kind: string;
  path: string;
  source: string;
  previousSource: string | null;
  currentBlobId: string | null;
  previousBlobId: string | null;
  startByte: number;
  endByte: number;
  previousStartByte: number | null;
  previousEndByte: number | null;
}

/** Creates a private source reference for store tests. */
function source(path: string, id = path): TestSource {
  return {
    id,
    kind: "function",
    path,
    source: "",
    previousSource: null,
    currentBlobId: `blob:${path}`,
    previousBlobId: null,
    startByte: 0,
    endByte: 4,
    previousStartByte: null,
    previousEndByte: null,
  };
}

/** Creates a manually controlled asynchronous source load. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("PrivateWorkspaceSourceStore", () => {
  it("promotes a newly selected path ahead of queued prefetches", async () => {
    const first = deferred();
    const order: string[] = [];
    const hydrate = vi.fn(async (sources: readonly TestSource[]) => {
      const path = sources[0]?.path ?? "";
      // Context and unit derivation are two stages of the same file request.
      if (!order.includes(path)) {
        order.push(path);
        if (path === "a.ts") await first.promise;
      }
      return {
        failures: [],
        successfulIndexes: sources.map((_source, index) => index),
        units: sources.map((item) => ({ ...item, source: item.path })),
      };
    });
    const sources = [source("a.ts"), source("b.ts"), source("c.ts")];
    const store = new PrivateWorkspaceSourceStore({
      snapshotId: "snapshot",
      units: sources,
      contexts: sources,
      concurrency: 1,
      hydrate: hydrate as never,
    });

    const a = store.request("a.ts", "preview");
    const b = store.request("b.ts", "preview");
    const c = store.request("c.ts", "preview");
    expect(store.request("c.ts", "active")).toBe(c);
    first.resolve();
    await Promise.all([a, b, c]);

    expect(order).toEqual(["a.ts", "c.ts", "b.ts"]);
    expect(store.status("c.ts")).toBe("ready");
    store.dispose();
  });

  it("loads one file context before deriving every same-file unit", async () => {
    const calls: string[][] = [];
    const hydrate = vi.fn(async (sources: readonly TestSource[]) => {
      calls.push(sources.map(({ id }) => id));
      return {
        failures: [],
        successfulIndexes: sources.map((_source, index) => index),
        units: sources.map((item) => ({ ...item, source: `ready:${item.id}` })),
      };
    });
    const store = new PrivateWorkspaceSourceStore({
      snapshotId: "snapshot",
      units: [source("shared.ts", "one"), source("shared.ts", "two")],
      contexts: [source("shared.ts", "context")],
      concurrency: 4,
      hydrate: hydrate as never,
    });

    const result = await store.request("shared.ts", "active");

    expect(calls).toEqual([["context"], ["one", "two"]]);
    expect(result.context?.source).toBe("ready:context");
    expect(result.units.map(({ source: text }) => text)).toEqual([
      "ready:one",
      "ready:two",
    ]);
    store.dispose();
  });

  it("retains ready source across later priority and mode intent", async () => {
    const hydrate = vi.fn(async (sources: readonly TestSource[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((item) => ({ ...item, source: "ready" })),
    }));
    const store = new PrivateWorkspaceSourceStore({
      snapshotId: "snapshot",
      units: [source("shared.ts")],
      contexts: [],
      hydrate: hydrate as never,
    });

    const first = await store.request("shared.ts", "preview");
    const second = await store.request("shared.ts", "active");

    expect(second).toBe(first);
    expect(hydrate).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("bounds retained files with a least-recently-used policy", async () => {
    const hydrate = vi.fn(async (sources: readonly TestSource[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((item) => ({ ...item, source: "ready" })),
    }));
    const store = new PrivateWorkspaceSourceStore({
      snapshotId: "snapshot",
      units: [source("one.ts"), source("two.ts"), source("three.ts")],
      contexts: [],
      maximumReadyFiles: 2,
      hydrate: hydrate as never,
    });

    await store.request("one.ts", "active");
    await store.request("two.ts", "active");
    // Touch one so two becomes the eviction candidate.
    await store.request("one.ts", "active");
    await store.request("three.ts", "active");

    expect(store.status("one.ts")).toBe("ready");
    expect(store.status("two.ts")).toBe("idle");
    expect(store.status("three.ts")).toBe("ready");
    expect(store.result("two.ts")).toBeUndefined();
    store.dispose();
  });

  it("clears a failed object's promise before an explicit retry", async () => {
    let attempt = 0;
    const hydrate = vi.fn(async (sources: readonly TestSource[]) => {
      attempt += 1;
      return attempt === 1
        ? {
            failures: [{ cause: new Error("temporary"), path: "retry.ts" }],
            successfulIndexes: [],
            units: [...sources],
          }
        : {
            failures: [],
            successfulIndexes: [0],
            units: sources.map((item) => ({ ...item, source: "ready" })),
          };
    });
    const store = new PrivateWorkspaceSourceStore({
      snapshotId: "snapshot",
      units: [source("retry.ts")],
      contexts: [],
      hydrate: hydrate as never,
    });

    await expect(store.request("retry.ts", "active")).rejects.toThrow(
      "temporary",
    );
    await expect(store.retry("retry.ts")).resolves.toMatchObject({
      units: [{ source: "ready" }],
    });
    expect(store.status("retry.ts")).toBe("ready");
    store.dispose();
  });

  it.each<WorkspaceSourcePriority>(["active", "next", "preview"])(
    "deduplicates repeated %s requests for one path",
    async (priority) => {
      const pending = deferred();
      const hydrate = vi.fn(async (sources: readonly TestSource[]) => {
        await pending.promise;
        return {
          failures: [],
          successfulIndexes: [0],
          units: [...sources],
        };
      });
      const store = new PrivateWorkspaceSourceStore({
        snapshotId: "snapshot",
        units: [source("one.ts")],
        contexts: [],
        hydrate: hydrate as never,
      });

      const first = store.request("one.ts", priority);
      const second = store.request("one.ts", "active");
      expect(second).toBe(first);
      pending.resolve();
      await first;
      expect(hydrate).toHaveBeenCalledTimes(1);
      store.dispose();
    },
  );
});
