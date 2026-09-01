// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hydrate = vi.hoisted(() => vi.fn());

vi.mock("./private-source-client", () => ({
  hydratePrivateReviewSources: hydrate,
}));

import {
  preservePrivateSourceReviewState,
  usePrivateSourceHydration,
} from "./use-private-source-hydration";

interface TestSource {
  id: string;
  path: string;
  source: string;
  status: string;
  changedSinceSignOff: boolean;
  waitingSince: Date | null;
  currentBlobId: string | null;
  previousBlobId: string | null;
  startByte: number;
  endByte: number;
  previousStartByte: number | null;
  previousEndByte: number | null;
}

/** Builds a private range with review state that hydration must not erase. */
function source(id: string, overrides: Partial<TestSource> = {}): TestSource {
  return {
    id,
    path: `src/${id}.ts`,
    source: "",
    status: "pending",
    changedSinceSignOff: false,
    waitingSince: null,
    currentBlobId: `blob-${id}`,
    previousBlobId: null,
    startByte: 0,
    endByte: 4,
    previousStartByte: null,
    previousEndByte: null,
    ...overrides,
  };
}

/** Installs a deterministic animation-frame clock backed by fake timers. */
function installFrameClock() {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
}

afterEach(() => {
  cleanup();
  hydrate.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePrivateSourceHydration", () => {
  it("coalesces replacements at one frame and preserves live review fields", async () => {
    installFrameClock();
    const first = source("one", {
      status: "signed_off",
      changedSinceSignOff: true,
      waitingSince: new Date("2026-01-01T00:00:00Z"),
    });
    const second = source("two");
    let finish: (() => void) | undefined;
    hydrate.mockImplementation(
      async (
        sources: TestSource[],
        _snapshotId: string,
        _cache: Map<string, Promise<Uint8Array>>,
        _concurrency: number,
        _signal: AbortSignal,
        onHydrated: (index: number, hydrated: TestSource) => void,
      ) =>
        new Promise((resolve) => {
          sources.forEach((item, index) => {
            onHydrated(index, {
              ...item,
              source: `hydrated ${item.id}`,
              status: "pending",
              changedSinceSignOff: false,
              waitingSince: null,
            });
          });
          finish = () =>
            resolve({
              failures: [],
              successfulIndexes: [0, 1],
              units: sources,
            });
        }),
    );
    const preserve = vi.fn(preservePrivateSourceReviewState<TestSource>);
    const { result } = renderHook(() =>
      usePrivateSourceHydration({
        snapshotId: "snapshot-1",
        sources: [first, second],
        hydrationSources: [second, first],
        sourceKey: ({ id }) => id,
        preserveSourceState: preserve,
      }),
    );

    expect(result.current.sources.map(({ source }) => source)).toEqual([
      "",
      "",
    ]);
    expect(preserve).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));
    expect(result.current.sources.map(({ source }) => source)).toEqual([
      "hydrated one",
      "hydrated two",
    ]);
    expect(preserve).toHaveBeenCalledTimes(2);
    expect(result.current.successfulSourceKeys).toEqual(
      new Set(["one", "two"]),
    );
    expect(result.current.sources[0]).toMatchObject({
      status: "signed_off",
      changedSinceSignOff: true,
      waitingSince: new Date("2026-01-01T00:00:00Z"),
    });
    await act(async () => finish?.());
    expect(result.current.pending).toBe(false);
    expect(result.current.settledSourceKeys).toEqual(new Set(["one", "two"]));
  });

  it("aborts work and cancels a scheduled batch during cleanup", () => {
    installFrameClock();
    let capturedSignal: AbortSignal | undefined;
    let capturedCache: Map<string, Promise<Uint8Array>> | undefined;
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    hydrate.mockImplementation(
      (
        sources: TestSource[],
        _snapshotId: string,
        cache: Map<string, Promise<Uint8Array>>,
        _concurrency: number,
        signal: AbortSignal,
        onHydrated: (index: number, hydrated: TestSource) => void,
      ) => {
        capturedSignal = signal;
        capturedCache = cache;
        cache.set("blob-one", Promise.resolve(new Uint8Array()));
        const first = sources[0];
        if (first) onHydrated(0, { ...first, source: "too late" });
        return new Promise(() => {});
      },
    );
    const { unmount } = renderHook(() =>
      usePrivateSourceHydration({
        snapshotId: "snapshot-1",
        sources: [source("one")],
        sourceKey: ({ id }) => id,
      }),
    );

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedCache?.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not restart or replace hydration on a same-snapshot refresh", async () => {
    hydrate.mockImplementation(async (sources: TestSource[]) => ({
      failures: [],
      successfulIndexes: sources.map((_item, index) => index),
      units: sources,
    }));
    const { result, rerender } = renderHook(
      ({ sources }: { sources: TestSource[] }) =>
        usePrivateSourceHydration({
          snapshotId: "snapshot-1",
          sources,
          sourceKey: ({ id }) => id,
        }),
      { initialProps: { sources: [source("original")] } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));

    rerender({ sources: [source("refresh")] });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(result.current.sources[0]?.id).toBe("original");
  });

  it("shares one cache and reports primary and related failures together", async () => {
    const caches: Array<Map<string, Promise<Uint8Array>>> = [];
    const concurrency: number[] = [];
    hydrate.mockImplementation(
      async (
        sources: TestSource[],
        _snapshotId: string,
        cache: Map<string, Promise<Uint8Array>>,
        limit: number,
      ) => {
        caches.push(cache);
        concurrency.push(limit);
        return {
          failures: [
            { cause: new Error(sources[0]?.id), path: sources[0]?.path ?? "" },
          ],
          successfulIndexes: [],
          units: sources,
        };
      },
    );
    const onFailures = vi.fn();
    const { result } = renderHook(() =>
      usePrivateSourceHydration({
        snapshotId: "snapshot-1",
        sources: [source("primary")],
        sourceKey: ({ id }) => id,
        sourceConcurrency: 6,
        relatedSources: [source("related")],
        relatedSourceKey: ({ id }) => id,
        relatedConcurrency: 2,
        onFailures,
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));

    expect(caches).toHaveLength(2);
    expect(caches[0]).toBe(caches[1]);
    expect(concurrency).toEqual([6, 2]);
    expect(onFailures).toHaveBeenCalledTimes(1);
    expect(onFailures.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ path: "src/primary.ts" }),
      expect.objectContaining({ path: "src/related.ts" }),
    ]);
  });
});
