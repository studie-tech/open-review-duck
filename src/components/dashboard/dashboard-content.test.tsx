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
      startedAt: new Date(),
      repositoryOwner: "reviewduck",
      repositoryName: "app",
      provider: "azure_devops",
      title: "Make synchronization visible",
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
      planUsage: {
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
      startedAt: new Date(),
      repositoryOwner: "reviewduck",
      repositoryName: "app",
      provider: "azure_devops",
      title: "Make synchronization visible",
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
      initialAiPlanUsage: null,
      localMode: true,
    };
    const view = render(<DashboardContent {...properties} />);

    expect(screen.getByText("Preparing a review")).toBeVisible();
    expect(screen.getByText("Azure DevOps").closest("p")).toHaveTextContent(
      "Azure DevOps · reviewduck/app #42",
    );
    expect(screen.getByText("Make synchronization visible")).toBeVisible();
    expect(
      screen.getByText("Fetching pull request and changed files"),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", {
        name: "reviewduck/app #42 synchronization progress",
      }),
    ).toHaveAttribute("aria-valuenow", "25");
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
        initialAiPlanUsage={null}
        localMode={testCase.localMode}
      />,
    );

    expect(screen.getByText(testCase.status)).toBeVisible();
  });

  it("shows SaaS monthly token usage and an upgrade link", () => {
    queryState.activeSyncs = [];
    render(
      <DashboardContent
        initialPullRequests={[]}
        initialAiConfiguration={{
          mode: "on_demand",
          managedModel: "provider/model",
          managedModels: ["provider/model"],
          reviewPullRequests: false,
          configuration: {
            provider: "openrouter",
            model: "provider/model",
            baseUrl: null,
            useManagedModels: true,
            hasApiKey: false,
            hasHeaders: false,
          },
          disclosure: { accepted: false, version: "test" },
        }}
        initialAiPlanUsage={{
          tier: "free",
          subscribed: false,
          usedTokens: 25_000,
          limitTokens: 100_000,
          remainingTokens: 75_000,
          resetsAt: new Date("2026-09-01T00:00:00Z"),
        }}
        localMode={false}
      />,
    );

    expect(screen.getByText("25k / 100k")).toBeVisible();
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/settings/ai",
    );
    expect(
      screen.getByRole("progressbar", { name: "Monthly AI token usage" }),
    ).toHaveAttribute("aria-valuenow", "25000");
  });
});
