// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";

const hydrate = vi.hoisted(() => vi.fn());

vi.mock("~/lib/private-source-client", () => ({
  hydratePrivateReviewSources: hydrate,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { usePrivateWorkspaceSourceHydration } from "./use-private-workspace-source-hydration";

type Workspace = RouterOutputs["review"]["workspace"];
type Unit = Workspace["units"][number];

/** Creates a representative source-backed review unit. */
function reviewUnit(index: number): Unit {
  const path = `src/${String(index).padStart(2, "0")}.ts`;
  return {
    id: `unit-${index}`,
    path,
    kind: "function",
    status: "pending",
    revisionState: "initial",
    signOffOrigin: "none",
    changedSinceSignOff: false,
    waitingSince: null,
    source: "",
    previousSource: null,
    currentBlobId: `blob-${index}`,
    previousBlobId: null,
    startByte: 0,
    endByte: 4,
    previousStartByte: null,
    previousEndByte: null,
  } as Unit;
}

/** Creates a source-free private workspace with the requested file count. */
function workspace(count: number, snapshotId = "snapshot"): Workspace {
  const units = Array.from({ length: count }, (_item, index) =>
    reviewUnit(index),
  );
  return {
    snapshot: { id: snapshotId },
    units,
    fileContexts: units.map((unit) => ({ ...unit, kind: "file" })),
    files: units.map((unit) => ({
      id: `file-${unit.id}`,
      path: unit.path,
      previousPath: null,
      changeType: "modified",
      additions: 1,
      deletions: 0,
      isBinary: false,
      skipReason: null,
    })),
    concepts: units.map((unit, index) => ({
      id: `concept-${index}`,
      memberIds: [unit.id],
    })),
  } as unknown as Workspace;
}

afterEach(() => {
  cleanup();
  hydrate.mockReset();
});

describe("usePrivateWorkspaceSourceHydration", () => {
  it("replaces the ledger and cache when navigation changes snapshots", async () => {
    hydrate.mockImplementation(async (sources: Unit[], snapshotId: string) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((source) => ({ ...source, source: snapshotId })),
    }));
    const first = workspace(2, "snapshot-a");
    const second = workspace(3, "snapshot-b");
    const { result, rerender } = renderHook(
      ({ data }) => usePrivateWorkspaceSourceHydration(data, 0, "files"),
      { initialProps: { data: first } },
    );
    await waitFor(() =>
      expect(result.current.units[0]?.source).toBe("snapshot-a"),
    );

    rerender({ data: second });
    await waitFor(() => expect(result.current.units).toHaveLength(3));
    await waitFor(() =>
      expect(result.current.units[0]?.source).toBe("snapshot-b"),
    );
  });

  it("survives React strict effect replay without disposing its snapshot", async () => {
    hydrate.mockImplementation(async (sources: Unit[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((source) => ({ ...source, source: "verified" })),
    }));
    const data = workspace(3);
    const { result } = renderHook(
      () => usePrivateWorkspaceSourceHydration(data, 0, "files"),
      { wrapper: StrictMode },
    );

    await waitFor(() =>
      expect(result.current.sourceStatus("src/00.ts")).toBe("ready"),
    );
    expect(result.current.units[0]?.source).toBe("verified");
  });

  it("does not queue the server-default unit before local intent is restored", async () => {
    hydrate.mockImplementation(async (sources: Unit[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((source) => ({ ...source, source: "verified" })),
    }));
    const data = workspace(50);
    const { result, rerender } = renderHook(
      ({ activeIndex, intentReady }) =>
        usePrivateWorkspaceSourceHydration(
          data,
          activeIndex,
          "files",
          intentReady,
        ),
      { initialProps: { activeIndex: 0, intentReady: false } },
    );

    await act(() => Promise.resolve());
    expect(hydrate).not.toHaveBeenCalled();

    rerender({ activeIndex: 40, intentReady: true });
    await waitFor(() =>
      expect(result.current.sourceStatus("src/40.ts")).toBe("ready"),
    );
    const firstCall = hydrate.mock.calls[0]?.[0] as Unit[] | undefined;
    expect(firstCall?.[0]?.path).toBe("src/40.ts");
    expect(result.current.sourceStatus("src/00.ts")).toBe("idle");
  });

  it("loads only the active File-mode working set on a large review", async () => {
    hydrate.mockImplementation(async (sources: Unit[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((source) => ({
        ...source,
        source: `ready:${source.path}`,
      })),
    }));
    const data = workspace(50);
    const { result } = renderHook(() =>
      usePrivateWorkspaceSourceHydration(data, 25, "files"),
    );

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(10));

    expect(result.current.sourceStatus("src/25.ts")).toBe("ready");
    expect(result.current.units[25]?.source).toBe("ready:src/25.ts");
    // Five file tasks (active, next, and three other rendered neighbors), each
    // with one context stage and one unit-derivation stage—not all fifty files.
    expect(hydrate).toHaveBeenCalledTimes(10);
  });

  it("reuses verified files across mode changes and review-state updates", async () => {
    hydrate.mockImplementation(async (sources: Unit[]) => ({
      failures: [],
      successfulIndexes: sources.map((_source, index) => index),
      units: sources.map((source) => ({ ...source, source: "verified" })),
    }));
    const data = workspace(2);
    data.concepts = [
      { id: "shared-concept", memberIds: data.units.map(({ id }) => id) },
    ] as Workspace["concepts"];
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "files" | "path" }) =>
        usePrivateWorkspaceSourceHydration(data, 0, mode),
      { initialProps: { mode: "files" } },
    );
    await waitFor(() =>
      expect(result.current.sourceStatus("src/01.ts")).toBe("ready"),
    );
    const callsAfterFilesMode = hydrate.mock.calls.length;

    rerender({ mode: "path" });
    act(() =>
      result.current.setUnits((units) =>
        units.map((unit) =>
          unit.id === "unit-0" ? { ...unit, status: "signed_off" } : unit,
        ),
      ),
    );

    await waitFor(() =>
      expect(result.current.units[0]?.status).toBe("signed_off"),
    );
    expect(result.current.units[0]?.source).toBe("verified");
    expect(hydrate).toHaveBeenCalledTimes(callsAfterFilesMode);
  });
});
