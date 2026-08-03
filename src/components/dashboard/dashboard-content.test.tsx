// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
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
        configuration: null,
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

  const statusCases = [
    {
      name: "disabled configuration",
      status: "Off",
      localMode: true,
      mode: "off" as const,
      configuration: null,
    },
    {
      name: "unconfigured local provider",
      status: "Setup",
      localMode: true,
      mode: "on_demand" as const,
      configuration: null,
    },
    {
      name: "managed free model",
      status: "Free",
      localMode: false,
      mode: "on_demand" as const,
      configuration: {
        provider: "opencode",
        model: "big-pickle",
        baseUrl: null,
        useManagedModels: true,
        hasApiKey: false,
        hasHeaders: false,
      },
    },
    {
      name: "managed subscriber model",
      status: "Subscriber",
      localMode: false,
      mode: "on_demand" as const,
      configuration: {
        provider: "openrouter",
        model: "provider/model",
        baseUrl: null,
        useManagedModels: true,
        hasApiKey: false,
        hasHeaders: false,
      },
    },
    {
      name: "configured local provider",
      status: "Connected",
      localMode: true,
      mode: "on_demand" as const,
      configuration: {
        provider: "ollama",
        model: "local-model",
        baseUrl: "http://host.docker.internal:11434/v1",
        useManagedModels: false,
        hasApiKey: false,
        hasHeaders: false,
      },
    },
  ] satisfies Array<{
    name: string;
    status: string;
    localMode: boolean;
    mode: ComponentProps<
      typeof DashboardContent
    >["initialAiConfiguration"]["mode"];
    configuration: ComponentProps<
      typeof DashboardContent
    >["initialAiConfiguration"]["configuration"];
  }>;

  it.each(statusCases)("shows $status for $name", (testCase) => {
    queryState.activeSyncs = [];
    render(
      <DashboardContent
        initialPullRequests={[]}
        initialAiConfiguration={{
          mode: testCase.mode,
          managedModel: "big-pickle",
          managedModels: ["big-pickle"],
          reviewPullRequests: false,
          configuration: testCase.configuration,
          disclosure: { accepted: false, version: "test" },
        }}
        localMode={testCase.localMode}
      />,
    );

    expect(screen.getByText(testCase.status)).toBeVisible();
  });
});
