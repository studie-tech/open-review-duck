// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardFilters } from "~/lib/dashboard-filters";
import { DashboardContent } from "./dashboard-content";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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
  recentSyncFailures: [] as Array<Record<string, unknown>>,
  failuresRefetch: vi.fn(),
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
      recentSyncFailures: {
        useQuery: vi.fn(() => ({
          data: queryState.recentSyncFailures,
          refetch: queryState.failuresRefetch,
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
  localStorage.clear();
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
  queryState.recentSyncFailures = [];
  queryState.failuresRefetch.mockReset();
  queryState.dashboardRefetch.mockReset();
  queryState.dashboardSetData.mockReset();
  queryState.dashboardInvalidate.mockReset();
  queryState.removeMutate.mockReset();
  queryState.restoreMutate.mockReset();
});

describe("DashboardContent", () => {
  /** Builds one dashboard item with focused test overrides. */
  const pullRequest = (
    overrides: Partial<
      ComponentProps<typeof DashboardContent>["initialPullRequests"][number]
    > & { id: string },
  ): ComponentProps<typeof DashboardContent>["initialPullRequests"][number] => {
    const { id, ...rest } = overrides;
    return {
      id,
      number: 42,
      title: "Improve the dashboard",
      authorLogin: "reviewer",
      authorAvatarUrl: null,
      state: "open",
      webUrl: "https://example.com/pull/42",
      updatedAt: new Date("2026-08-15T12:00:00Z"),
      additions: 12,
      deletions: 2,
      repositoryOwner: "acme",
      repositoryName: "web",
      provider: "github",
      queueState: "active",
      queueSource: "manual",
      removedAt: null,
      totalUnits: 4,
      signedUnits: 0,
      carriedSignOffs: 0,
      ...rest,
    };
  };

  it("shows durable sync progress and refreshes reviews when it finishes", async () => {
    const view = render(<DashboardContent initialPullRequests={[]} />);

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
    view.rerender(<DashboardContent initialPullRequests={[]} />);

    await waitFor(() =>
      expect(queryState.dashboardRefetch).toHaveBeenCalledTimes(1),
    );
    expect(queryState.failuresRefetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a recent synchronization failure visible with safe guidance", () => {
    queryState.activeSyncs = [];
    queryState.recentSyncFailures = [
      {
        id: "sync-failed",
        pullRequestNumber: 18_622,
        progress: 10,
        completedAt: new Date(),
        repositoryOwner: "DSAIE",
        repositoryName: "hub-app",
        provider: "azure_devops",
        title: "Track Chat AI token usage per user and model",
        message:
          "Azure DevOps denied access while loading this pull request. Reconnect a token with Code: Read & write access to this repository.",
      },
    ];

    render(<DashboardContent initialPullRequests={[]} />);

    expect(screen.getByText("A review could not be prepared")).toBeVisible();
    expect(screen.getByText("Azure DevOps").closest("p")).toHaveTextContent(
      "Azure DevOps · DSAIE/hub-app #18622",
    );
    expect(
      screen.getByText(/Failed at 10% while fetching pull request/),
    ).toHaveTextContent(
      "Reconnect a token with Code: Read & write access to this repository.",
    );
    expect(
      screen.getByRole("link", { name: "Review connection" }),
    ).toHaveAttribute("href", "/settings/providers");
  });

  it("prioritizes continued work and filters across providers", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    const items = [
      pullRequest({
        id: "ready",
        number: 102,
        title: "Retry settlement webhooks",
        authorLogin: "sonia",
        provider: "gitlab",
        repositoryOwner: "payments",
        repositoryName: "api",
      }),
      pullRequest({
        id: "continue",
        number: 101,
        title: "Inventory improvements",
        signedUnits: 2,
      }),
      pullRequest({
        id: "unsupported",
        number: 103,
        title: "Update generated assets",
        provider: "azure_devops",
        totalUnits: 0,
      }),
    ];
    const view = render(<DashboardContent initialPullRequests={items} />);

    const continued = screen.getByText("Inventory improvements");
    const ready = screen.getByText("Retry settlement webhooks");
    expect(
      continued.compareDocumentPosition(ready) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Continue reviewing")).toBeVisible();
    expect(screen.getAllByText("Ready to start").length).toBeGreaterThan(0);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "gitlab",
    );
    expect(screen.getByText("Retry settlement webhooks")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "In progress, 0" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Ready to start, 1" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Clear inbox filters" }),
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search pull requests" }),
      "payments/api #102 sonia",
    );
    expect(screen.getByText("Retry settlement webhooks")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Clear inbox filters" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "gitlab",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by repository" }),
      "gitlab:payments/api",
    );
    view.rerender(
      <DashboardContent
        initialPullRequests={items.filter(({ id }) => id !== "ready")}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Filter by repository" }),
      ).toHaveValue("all"),
    );
  });

  it("toggles closed history from My work without a side rail", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    render(
      <DashboardContent
        initialPullRequests={[
          pullRequest({ id: "open", title: "Inventory improvements" }),
          pullRequest({
            id: "closed",
            number: 88,
            title: "Merged settlement",
            state: "merged",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(screen.queryByText("Merged settlement")).not.toBeInTheDocument();
    expect(screen.queryByText("AI assistant")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Closed history, 1" }));
    expect(
      screen.getByRole("heading", { name: "Closed history" }),
    ).toBeVisible();
    expect(screen.getByText("Merged settlement")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Needs review, 1" }));
    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(screen.queryByText("Merged settlement")).not.toBeInTheDocument();
  });

  it("remembers inbox filters in localStorage and restores them on return", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    const items = [
      pullRequest({
        id: "ready",
        number: 102,
        title: "Retry settlement webhooks",
        authorLogin: "sonia",
        provider: "gitlab",
        repositoryOwner: "payments",
        repositoryName: "api",
      }),
      pullRequest({
        id: "continue",
        number: 101,
        title: "Inventory improvements",
        signedUnits: 2,
      }),
    ];
    const view = render(<DashboardContent initialPullRequests={items} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "gitlab",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by repository" }),
      "gitlab:payments/api",
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search pull requests" }),
      "sonia",
    );
    expect(dashboardFilters(localStorage)).toEqual({
      provider: "gitlab",
      repository: "gitlab:payments/api",
      search: "sonia",
    });

    view.unmount();
    render(<DashboardContent initialPullRequests={items} />);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Filter by provider" }),
      ).toHaveValue("gitlab");
    });
    expect(
      screen.getByRole("combobox", { name: "Filter by repository" }),
    ).toHaveValue("gitlab:payments/api");
    expect(
      screen.getByRole("searchbox", { name: "Search pull requests" }),
    ).toHaveValue("sonia");
    expect(screen.getByText("Retry settlement webhooks")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();
  });
});
