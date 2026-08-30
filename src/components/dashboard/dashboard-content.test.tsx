// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardFilters } from "~/lib/dashboard-filters";
import { PullRequestsContent } from "./dashboard-content";

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
  syncMutate: vi.fn(),
  unimported: {
    pullRequests: [] as Array<Record<string, unknown>>,
    errors: [] as Array<Record<string, unknown>>,
    manualRepositoryCount: 0,
  },
  unimportedError: undefined as { message: string } | undefined,
  unimportedRefetch: vi.fn(),
  unimportedInvalidate: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: vi.fn(() => ({
      review: {
        dashboard: {
          setData: queryState.dashboardSetData,
          invalidate: queryState.dashboardInvalidate,
        },
        activeSyncs: { invalidate: vi.fn() },
      },
      provider: {
        listUnimportedPullRequests: {
          invalidate: queryState.unimportedInvalidate,
        },
        listOpenPullRequests: { invalidate: vi.fn() },
      },
    })),
    provider: {
      listUnimportedPullRequests: {
        useQuery: vi.fn(() => ({
          data: queryState.unimported,
          error: queryState.unimportedError,
          isError: Boolean(queryState.unimportedError),
          isLoading: false,
          refetch: queryState.unimportedRefetch,
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
      sync: {
        useMutation: vi.fn(() => ({
          mutate: queryState.syncMutate,
          isPending: false,
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
  queryState.syncMutate.mockReset();
  queryState.unimportedRefetch.mockReset();
  queryState.unimportedInvalidate.mockReset();
  queryState.unimported = {
    pullRequests: [],
    errors: [],
    manualRepositoryCount: 0,
  };
  queryState.unimportedError = undefined;
});

describe("PullRequestsContent", () => {
  /** Builds one dashboard item with focused test overrides. */
  const pullRequest = (
    overrides: Partial<
      ComponentProps<typeof PullRequestsContent>["initialPullRequests"][number]
    > & { id: string },
  ): ComponentProps<
    typeof PullRequestsContent
  >["initialPullRequests"][number] => {
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
    const view = render(<PullRequestsContent initialPullRequests={[]} />);

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
    view.rerender(<PullRequestsContent initialPullRequests={[]} />);

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
        repositoryId: "repository-failed",
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

    render(<PullRequestsContent initialPullRequests={[]} />);

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
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("retries a failed synchronization from the inbox", async () => {
    const user = userEvent.setup();
    queryState.activeSyncs = [];
    queryState.recentSyncFailures = [
      {
        id: "sync-failed",
        repositoryId: "repository-failed",
        pullRequestNumber: 18_622,
        progress: 10,
        completedAt: new Date(),
        repositoryOwner: "DSAIE",
        repositoryName: "hub-app",
        provider: "azure_devops",
        title: "Track Chat AI token usage per user and model",
        message: "Azure DevOps denied access while loading this pull request.",
      },
    ];

    render(<PullRequestsContent initialPullRequests={[]} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(queryState.syncMutate).toHaveBeenCalledWith({
      repositoryId: "repository-failed",
      number: 18_622,
    });
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
    const view = render(<PullRequestsContent initialPullRequests={items} />);

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
    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(screen.getByRole("option", { name: "payments/api" }));
    view.rerender(
      <PullRequestsContent
        initialPullRequests={items.filter(({ id }) => id !== "ready")}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Filter by repository" }),
      ).toHaveTextContent("All repositories"),
    );
  });

  it("toggles closed history from My work without a side rail", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    render(
      <PullRequestsContent
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
    const view = render(<PullRequestsContent initialPullRequests={items} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "gitlab",
    );
    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(screen.getByRole("option", { name: "payments/api" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search pull requests" }),
      "sonia",
    );
    expect(dashboardFilters(localStorage)).toEqual({
      provider: "gitlab",
      repositories: ["gitlab:payments/api"],
      search: "sonia",
      showDrafts: true,
    });

    view.unmount();
    render(<PullRequestsContent initialPullRequests={items} />);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Filter by provider" }),
      ).toHaveValue("gitlab");
    });
    expect(
      screen.getByRole("button", { name: "Filter by repository" }),
    ).toHaveTextContent("payments/api");
    expect(
      screen.getByRole("searchbox", { name: "Search pull requests" }),
    ).toHaveValue("sonia");
    expect(screen.getByText("Retry settlement webhooks")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();
  });

  it("can keep more than one repository selected in the inbox filter", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    render(
      <PullRequestsContent
        initialPullRequests={[
          pullRequest({
            id: "ready",
            number: 102,
            title: "Retry settlement webhooks",
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
            id: "other",
            number: 88,
            title: "Azure handoff",
            provider: "azure_devops",
            repositoryOwner: "ops",
            repositoryName: "hub",
          }),
        ]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(
      screen.getByRole("option", { name: "payments/api · GitLab" }),
    );
    await user.click(screen.getByRole("option", { name: "acme/web · GitHub" }));

    expect(
      screen.getByRole("button", { name: "Filter by repository" }),
    ).toHaveTextContent("2 repositories");
    expect(screen.getByText("Retry settlement webhooks")).toBeVisible();
    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(screen.queryByText("Azure handoff")).not.toBeInTheDocument();
    expect(dashboardFilters(localStorage).repositories).toEqual([
      "gitlab:payments/api",
      "github:acme/web",
    ]);
  });

  it("hides draft pull requests from the inbox when the drafts switch is off", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    render(
      <PullRequestsContent
        initialPullRequests={[
          pullRequest({
            id: "open",
            title: "Inventory improvements",
          }),
          pullRequest({
            id: "draft",
            number: 1393,
            title: "Draft contribution flow",
            state: "draft",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(screen.getByText("Draft contribution flow")).toBeVisible();
    expect(screen.getByText("Draft · Ready to start")).toBeVisible();
    const draftsSwitch = screen.getByRole("switch", {
      name: "Show draft pull requests",
    });
    expect(draftsSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(draftsSwitch);
    expect(draftsSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(
      screen.queryByText("Draft contribution flow"),
    ).not.toBeInTheDocument();
    expect(dashboardFilters(localStorage).showDrafts).toBe(false);
    expect(
      screen.getByRole("button", { name: "Ready to start, 1" }),
    ).toBeVisible();
  });

  it("only claims drafts are hidden when the filtered view still has them", async () => {
    queryState.activeSyncs = [];
    const user = userEvent.setup();
    render(
      <PullRequestsContent
        initialPullRequests={[
          pullRequest({
            id: "open",
            title: "Inventory improvements",
            provider: "gitlab",
            repositoryOwner: "payments",
            repositoryName: "api",
          }),
          pullRequest({
            id: "draft",
            number: 1393,
            title: "Draft contribution flow",
            state: "draft",
          }),
        ]}
      />,
    );

    await user.click(
      screen.getByRole("switch", { name: "Show draft pull requests" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "gitlab",
    );
    expect(screen.getByText("Inventory improvements")).toBeVisible();
    expect(
      screen.queryByText("Draft pull requests are hidden"),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by provider" }),
      "github",
    );
    expect(screen.getByText("Draft pull requests are hidden")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show drafts" })).toBeVisible();
  });

  it("lists un-imported pull requests from manual repositories and can prepare them", async () => {
    queryState.activeSyncs = [];
    queryState.unimported = {
      manualRepositoryCount: 1,
      errors: [],
      pullRequests: [
        {
          additions: 4,
          authorAvatarUrl: null,
          authorLogin: "mira",
          deletions: 1,
          externalId: "pr-77",
          number: 77,
          provider: "github",
          repositoryId: "repository-manual",
          repositoryName: "platform",
          repositoryOwner: "acme",
          sourceBranch: "metrics",
          state: "open",
          targetBranch: "main",
          title: "Add usage metrics",
          webUrl: "https://example.com/pull/77",
        },
      ],
    };
    const user = userEvent.setup();
    render(
      <PullRequestsContent
        initialPullRequests={[
          pullRequest({ id: "ready", title: "Inventory improvements" }),
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Un-imported, 1" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Un-imported PRs" }),
    ).toBeVisible();
    expect(screen.getByText("Add usage metrics")).toBeVisible();
    expect(screen.getByText("Not in your queue")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add for review" }));
    expect(queryState.syncMutate).toHaveBeenCalledWith({
      repositoryId: "repository-manual",
      number: 77,
    });

    await user.click(screen.getByRole("button", { name: "Un-imported, 1" }));
    expect(
      screen.getByRole("heading", { name: "Un-imported PRs" }),
    ).toBeVisible();
    expect(screen.getByText("Add usage metrics")).toBeVisible();
    expect(
      screen.queryByText("Inventory improvements"),
    ).not.toBeInTheDocument();
  });

  it("keeps the drafts switch available for un-imported pull requests", async () => {
    queryState.activeSyncs = [];
    queryState.unimported = {
      manualRepositoryCount: 1,
      errors: [],
      pullRequests: [
        {
          additions: 2,
          authorAvatarUrl: null,
          authorLogin: "mira",
          deletions: 0,
          externalId: "pr-78",
          number: 78,
          provider: "github",
          repositoryId: "repository-manual",
          repositoryName: "platform",
          repositoryOwner: "acme",
          sourceBranch: "draft-metrics",
          state: "draft",
          targetBranch: "main",
          title: "Draft usage metrics",
          webUrl: "https://example.com/pull/78",
        },
      ],
    };
    const user = userEvent.setup();
    render(<PullRequestsContent initialPullRequests={[]} />);

    expect(screen.getByText("Draft usage metrics")).toBeVisible();
    const draftsSwitch = screen.getByRole("switch", {
      name: "Show draft pull requests",
    });
    await user.click(draftsSwitch);
    expect(screen.queryByText("Draft usage metrics")).not.toBeInTheDocument();
    expect(screen.getByText("Draft pull requests are hidden")).toBeVisible();
  });

  it("keeps the un-imported retry path when the provider query fails alone", async () => {
    queryState.activeSyncs = [];
    queryState.unimportedError = {
      message: "GitHub rate limited the open pull request list.",
    };
    const user = userEvent.setup();
    render(<PullRequestsContent initialPullRequests={[]} />);

    expect(
      screen.getByText("Un-imported pull requests could not be loaded"),
    ).toBeVisible();
    expect(
      screen.getByText("GitHub rate limited the open pull request list."),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect your first repository" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(queryState.unimportedRefetch).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Un-imported, 0" }));
    expect(
      screen.getByRole("heading", { name: "Un-imported PRs" }),
    ).toBeVisible();
  });
});
