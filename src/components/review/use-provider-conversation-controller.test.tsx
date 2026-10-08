// @vitest-environment jsdom

import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  type UseQueryOptions,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import { useProviderConversationController } from "./use-provider-conversation-controller";

type Conversations = RouterOutputs["review"]["providerConversations"];
const state = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    review: {
      providerConversations: { useQuery: useConversationsQuery },
      unitDiscussion: { useQuery: () => ({}) },
      ...Object.fromEntries(
        [
          "publishComment",
          "replyToThread",
          "setThreadResolution",
          "editThreadComment",
          "deleteThreadComment",
          "deleteThread",
        ].map((name) => [name, { useMutation: () => ({ isPending: false }) }]),
      ),
    },
  },
}));

/** Uses real query timers while replacing only the provider transport. */
function useConversationsQuery(
  _input: unknown,
  options: Omit<UseQueryOptions<Conversations>, "queryKey" | "queryFn">,
) {
  return useQuery<Conversations>({
    ...options,
    queryKey: ["providerConversations", "pr"],
    queryFn: state.fetch,
  });
}

let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.fetch.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

/** Provides a query cache for the controller's actual polling behavior. */
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("provider conversation refresh", () => {
  it("picks up external resolution and new threads without waiting review items", async () => {
    const thread = { externalId: "thread", unitId: "unit", status: "open" };
    const data = {
      provider: "github",
      threads: [thread],
      answeredUnitIds: [],
    };
    state.fetch.mockResolvedValue(data);
    const { result } = renderHook(
      () =>
        useProviderConversationController({
          clearDraft: vi.fn(),
          pullRequest: { id: "pr", provider: "github" } as Parameters<
            typeof useProviderConversationController
          >[0]["pullRequest"],
          refreshIntervalMs: 45_000,
          unitPathById: new Map(),
          visibleUnitIds: ["unit"],
        }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.visibleThreads).toEqual([thread]);

    const resolved = { ...thread, status: "resolved" };
    state.fetch.mockResolvedValue({ ...data, threads: [resolved] });
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect(result.current.visibleThreads).toEqual([resolved]);

    const added = { ...thread, externalId: "new-thread" };
    state.fetch.mockResolvedValue({ ...data, threads: [resolved, added] });
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect(result.current.visibleThreads).toEqual([resolved, added]);
  });
});
