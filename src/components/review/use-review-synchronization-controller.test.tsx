// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewSynchronizationController } from "./use-review-synchronization-controller";

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

  it("loads a snapshot synced elsewhere once without queuing another sync", async () => {
    state.probe = { ...state.probe, current: true, snapshotId: "external" };
    const { rerender } = renderHook(() =>
      useReviewSynchronizationController(input),
    );
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.queue).not.toHaveBeenCalled();
    state.updatedAt += 5_000;
    rerender();
    expect(state.refresh).toHaveBeenCalledTimes(1);
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
