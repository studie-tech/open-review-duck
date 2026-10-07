// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewSynchronizationController } from "./use-review-synchronization-controller";
import { useStagedReviewWorkspace } from "./use-staged-review-workspace";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  queue: vi.fn(),
  mutationOptions: undefined as
    | undefined
    | { onSuccess: (result: { syncId: string }) => void },
  probe: {
    current: false,
    headSha: "new",
    baseSha: "base",
    snapshotId: "loaded",
  },
  updatedAt: 1_000,
  status: undefined as undefined | { status: string; error?: string },
  probeOptions: {} as Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const router = { refresh: state.refresh };
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => utils,
    review: {
      poll: {
        useMutation: (options: typeof state.mutationOptions) => {
          state.mutationOptions = options;
          return { isPending: false, mutateAsync: state.queue };
        },
      },
      reset: { useMutation: () => ({ isPending: false }) },
      syncStatus: { useQuery: () => ({ data: state.status }) },
      revisionProbe: {
        useQuery: (_input: unknown, options: Record<string, unknown>) => {
          state.probeOptions = options;
          return {
            data: state.probe,
            dataUpdatedAt: state.updatedAt,
            isError: false,
          };
        },
      },
    },
  },
}));
const utils = {
  review: Object.fromEntries(
    [
      "activeSyncs",
      "dashboard",
      "gamification",
      "providerConversations",
      "providerReviewState",
      "providerLifecycle",
      "revisionProbe",
    ].map((key) => [key, { invalidate: state.invalidate }]),
  ),
};
const input = {
  manualSyncPending: false,
  onReset: vi.fn(),
  onRevisionAcknowledged: vi.fn(),
  sendReviewSession: vi.fn(),
  pullRequest: { id: "pr", provider: "github" },
  snapshot: { id: "loaded", headSha: "old", baseSha: "base", version: 1 },
} as unknown as Parameters<typeof useReviewSynchronizationController>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  state.probe = {
    current: false,
    headSha: "new",
    baseSha: "base",
    snapshotId: "loaded",
  };
  state.updatedAt = 1_000;
  state.status = undefined;
  state.queue.mockImplementation(async () => {
    state.mutationOptions?.onSuccess({ syncId: "sync" });
    return { syncId: "sync" };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Flushes the asynchronous mutation and its state updates. */
async function settle() {
  await act(async () => {});
}

describe("review synchronization", () => {
  it("automatically loads completed background work", async () => {
    const onBeforeLoad = vi.fn();
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController({ ...input, onBeforeLoad }),
    );
    await settle();
    state.status = { status: "completed" };
    rerender();
    await settle();
    expect(onBeforeLoad).toHaveBeenCalledOnce();
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("automatically resumes loading after a draft or save finishes", async () => {
    state.probe = { ...state.probe, current: true, snapshotId: "external" };
    const { result, rerender } = renderHook(
      ({ canLoadChanges }) =>
        useReviewSynchronizationController({ ...input, canLoadChanges }),
      { initialProps: { canLoadChanges: false } },
    );
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(result.current.updateAvailable).toBe(true);
    expect(toast.info).not.toHaveBeenCalled();
    rerender({ canLoadChanges: true });
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("rechecks draft readiness on subsequent renders without a new probe", async () => {
    state.probe = { ...state.probe, current: true, snapshotId: "external" };
    let draftOpen = true;
    const onBeforeLoad = vi.fn();
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController({
        ...input,
        canLoadChanges: () => !draftOpen,
        onBeforeLoad,
      }),
    );
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(onBeforeLoad).not.toHaveBeenCalled();
    draftOpen = false;
    rerender();
    await settle();
    expect(onBeforeLoad).toHaveBeenCalledOnce();
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("automatically loads a revision staged by an unrelated refresh", async () => {
    state.probe = { ...state.probe, current: true };
    const onBeforeLoad = vi.fn();
    renderHook(() =>
      useReviewSynchronizationController({
        ...input,
        stagedRevisionAvailable: true,
        onBeforeLoad,
      }),
    );
    await settle();
    expect(onBeforeLoad).toHaveBeenCalledOnce();
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("applies staged data automatically and ignores probes for already displayed snapshots", async () => {
    state.probe = { ...state.probe, current: true };
    type Workspace = Parameters<typeof useStagedReviewWorkspace>[0];
    const first = { snapshot: input.snapshot } as Workspace;
    const next = {
      snapshot: { ...input.snapshot, id: "external", headSha: "new" },
    } as Workspace;
    const { result, rerender } = renderHook(
      ({ incoming, canLoadChanges }) => {
        const staged = useStagedReviewWorkspace(incoming);
        useReviewSynchronizationController({
          ...input,
          snapshot: staged.displayed.snapshot,
          stagedRevisionAvailable: staged.available,
          canLoadChanges,
          onBeforeLoad: staged.requestLoad,
        });
        return staged.displayed;
      },
      { initialProps: { incoming: first, canLoadChanges: false } },
    );
    rerender({ incoming: next, canLoadChanges: false });
    await settle();
    expect(result.current).toBe(first);
    rerender({ incoming: next, canLoadChanges: true });
    await settle();
    expect(result.current).toBe(next);
    expect(state.refresh).toHaveBeenCalledOnce();
    rerender({ incoming: next, canLoadChanges: true });
    await settle();
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("checks every five seconds and always checks on focus and reconnect", async () => {
    renderHook(() => useReviewSynchronizationController(input));
    await settle();
    expect(state.probeOptions).toMatchObject({
      refetchInterval: 5_000,
      staleTime: 0,
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
    });
  });

  it("retries a failed head after a fresh probe without an immediate retry loop", async () => {
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(1);
    state.status = { status: "failed" };
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(1);
    state.status = undefined;
    state.updatedAt = 6_001;
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(2);
  });

  it("backs off failed jobs and stops after four failures until a new revision", async () => {
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    for (let attempt = 1; attempt <= 4; attempt++) {
      state.status = { status: "failed" };
      rerender();
      await settle();
      state.status = undefined;
      state.updatedAt += Math.min(5_000 * 2 ** (attempt - 1), 30_000) - 1;
      vi.mocked(Date.now).mockReturnValue(state.updatedAt);
      rerender();
      await settle();
      expect(state.queue).toHaveBeenCalledTimes(attempt);
      state.updatedAt += 1;
      vi.mocked(Date.now).mockReturnValue(state.updatedAt);
      rerender();
      await settle();
      expect(state.queue).toHaveBeenCalledTimes(Math.min(attempt + 1, 4));
    }
    state.updatedAt += 60_000;
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(4);
    state.probe = { ...state.probe, headSha: "another-head" };
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(5);
  });

  it("bounds queue failures and permits a manual retry after the circuit opens", async () => {
    state.queue.mockRejectedValue(new Error("Provider unavailable"));
    const { rerender, result } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    for (let attempt = 1; attempt <= 4; attempt++) {
      state.updatedAt += 60_000;
      vi.mocked(Date.now).mockReturnValue(state.updatedAt);
      rerender();
      await settle();
    }
    expect(state.queue).toHaveBeenCalledTimes(4);
    await act(async () => {
      await result.current.syncExternalData();
    });
    expect(state.queue).toHaveBeenCalledTimes(5);
  });

  it("automatically loads a snapshot synced elsewhere once per probe", async () => {
    state.probe = { ...state.probe, current: true, snapshotId: "external" };
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.queue).not.toHaveBeenCalled();
    state.updatedAt += 5_000;
    rerender();
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("syncs a moved base even if the head has already been synchronized", async () => {
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    state.status = { status: "completed" };
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(1);
    state.status = undefined;
    state.probe = { ...state.probe, baseSha: "next-base" };
    state.updatedAt += 5_000;
    rerender();
    await settle();
    expect(state.queue).toHaveBeenCalledTimes(2);
  });
});
