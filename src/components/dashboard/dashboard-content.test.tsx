// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardContent } from "./dashboard-content";

const queryState = vi.hoisted(() => ({
  activeSyncs: [
    {
      id: "sync-1",
      repositoryId: "repository-1",
      pullRequestNumber: 42,
      status: "running",
      progress: 25,
      createdAt: new Date(),
    },
  ] as Array<Record<string, unknown>>,
  dashboardRefetch: vi.fn(),
  dashboardSetData: vi.fn(),
  dashboardInvalidate: vi.fn(),
  removeMutate: vi.fn(),
  restoreMutate: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: vi.fn(() => ({
      review: {
        dashboard: {
          setData: queryState.dashboardSetData,
          invalidate: queryState.dashboardInvalidate,
        },
      },
    })),
    ai: {
      configuration: {
        useQuery: vi.fn((_input, options) => ({
          data: options.initialData,
        })),
      },
    },
    review: {
      removeFromQueue: {
        useMutation: vi.fn(() => ({ mutate: queryState.removeMutate })),
      },
      restoreToQueue: {
        useMutation: vi.fn(() => ({ mutate: queryState.restoreMutate })),
      },
      activeSyncs: {
        useQuery: vi.fn(() => ({
          data: queryState.activeSyncs,
          isFetched: true,
        })),
      },
      dashboard: {
        useQuery: vi.fn((_input, options) => ({
          data: options.initialData,
          refetch: queryState.dashboardRefetch,
        })),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  queryState.activeSyncs = [
    {
      id: "sync-1",
      repositoryId: "repository-1",
      pullRequestNumber: 42,
      status: "running",
      progress: 25,
      createdAt: new Date(),
    },
  ];
  queryState.dashboardRefetch.mockReset();
  queryState.dashboardSetData.mockReset();
  queryState.dashboardInvalidate.mockReset();
  queryState.removeMutate.mockReset();
  queryState.restoreMutate.mockReset();
});

describe("DashboardContent", () => {
  it("shows durable sync progress and refreshes reviews when it finishes", async () => {
    const properties = {
      initialPullRequests: [],
      initialAiConfiguration: {
        mode: "off" as const,
        managedModel: "big-pickle",
        managedModels: ["big-pickle"],
        reviewPullRequests: false,
        configuration: {
          provider: "opencode",
          model: "big-pickle",
          apiProtocol: "ai-sdk",
          baseUrl: null,
          contextWindow: 0,
          maxTokens: 8_000,
          storeResponses: false,
          useManagedModels: true,
          hasApiKey: false,
          hasHeaders: false,
        },
        disclosure: {
          accepted: false,
          version: "test",
        },
      },
      localMode: true,
    };
    const view = render(<DashboardContent {...properties} />);

    expect(screen.getByText("Preparing a review")).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "Your review is being prepared",
      }),
    ).toBeVisible();

    queryState.activeSyncs = [];
    view.rerender(<DashboardContent {...properties} />);

    await waitFor(() =>
      expect(queryState.dashboardRefetch).toHaveBeenCalledTimes(1),
    );
  });
});
