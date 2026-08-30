// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportedRepository } from "./provider-common";
import { RepositoryDetail } from "./repository-detail";

const queryState = vi.hoisted(() => ({
  activeSyncs: [] as Array<Record<string, unknown>>,
  dashboard: [] as Array<Record<string, unknown>>,
  failedSyncs: [] as Array<Record<string, unknown>>,
  openPullRequests: [] as Array<Record<string, unknown>>,
  openError: undefined as { message: string } | undefined,
  syncMutate: vi.fn(),
  syncOnMutate: undefined as ((input: { number: number }) => void) | undefined,
  dashboardRefetch: vi.fn(),
  failuresRefetch: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      review: {
        activeSyncs: { invalidate: vi.fn() },
        dashboard: { invalidate: vi.fn() },
        recentSyncFailures: { invalidate: vi.fn() },
      },
      provider: {
        listUnimportedPullRequests: { invalidate: vi.fn() },
        listOpenPullRequests: { invalidate: vi.fn() },
      },
    }),
    provider: {
      listOpenPullRequests: {
        useQuery: () => ({
          data: queryState.openPullRequests,
          error: queryState.openError,
          isError: Boolean(queryState.openError),
          isFetching: false,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
    },
    review: {
      activeSyncs: {
        useQuery: () => ({ data: queryState.activeSyncs }),
      },
      dashboard: {
        useQuery: () => ({
          data: queryState.dashboard,
          refetch: queryState.dashboardRefetch,
        }),
      },
      recentSyncFailures: {
        useQuery: () => ({
          data: queryState.failedSyncs,
          refetch: queryState.failuresRefetch,
        }),
      },
      sync: {
        useMutation: (options?: {
          onMutate?: (input: { number: number }) => void;
        }) => {
          queryState.syncOnMutate = options?.onMutate;
          return {
            isPending: false,
            mutate: (input: { number: number; repositoryId: string }) => {
              queryState.syncOnMutate?.(input);
              queryState.syncMutate(input);
            },
            variables: undefined,
          };
        },
      },
    },
  },
}));

const repository = {
  id: "repository-1",
  externalId: "1",
  owner: "LEO-Pharma-R-D-Data-Analytics",
  name: "flakegraph",
  provider: "github",
  connectionName: "LEO-Pharma-R-D-Data-Analytics",
  credentialKind: "github_app",
  connectionId: "conn-1",
  webUrl: "https://github.com/LEO-Pharma-R-D-Data-Analytics/flakegraph",
  reviewIntakeMode: "manual",
  intakeLastAttemptAt: null,
  intakeLastReconciledAt: null,
  intakeLastError: null,
} as ImportedRepository;

afterEach(() => {
  cleanup();
  queryState.activeSyncs = [];
  queryState.dashboard = [];
  queryState.failedSyncs = [];
  queryState.openPullRequests = [];
  queryState.openError = undefined;
  queryState.syncMutate.mockReset();
  queryState.dashboardRefetch.mockReset();
  queryState.failuresRefetch.mockReset();
});

describe("RepositoryDetail", () => {
  it("keeps a prepared pull request visible as an in-flight job", async () => {
    const user = userEvent.setup();
    queryState.openPullRequests = [
      {
        externalId: "pr-2",
        number: 2,
        title: "Implement FlakeGraph knowledge graph processor",
        sourceBranch: "cripdk/flake_graph_initial",
        targetBranch: "main",
      },
    ];

    const view = render(
      <RepositoryDetail
        intakeUpdatePending={false}
        onReconcile={vi.fn()}
        onRemove={vi.fn()}
        onRequestIntakeChange={vi.fn()}
        reconcilePending={false}
        repository={repository}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prepare review" }));
    expect(queryState.syncMutate).toHaveBeenCalledWith({
      repositoryId: "repository-1",
      number: 2,
    });
    expect(screen.getByText("Preparing…")).toBeVisible();
    expect(
      screen.getByRole("progressbar", {
        name: "#2 synchronization progress",
      }),
    ).toHaveAttribute("aria-valuenow", "0");
    expect(
      screen.queryByRole("button", { name: "Prepare review" }),
    ).not.toBeInTheDocument();

    queryState.activeSyncs = [
      {
        id: "sync-1",
        repositoryId: "repository-1",
        pullRequestNumber: 2,
        status: "running",
        progress: 35,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        provider: "github",
        title: "Implement FlakeGraph knowledge graph processor",
      },
    ];
    view.rerender(
      <RepositoryDetail
        intakeUpdatePending={false}
        onReconcile={vi.fn()}
        onRemove={vi.fn()}
        onRequestIntakeChange={vi.fn()}
        reconcilePending={false}
        repository={repository}
      />,
    );

    expect(screen.getByText("Preparing…")).toBeVisible();
    expect(
      screen.getByRole("progressbar", {
        name: "#2 synchronization progress",
      }),
    ).toHaveAttribute("aria-valuenow", "35");
    expect(screen.getByText("Analyzing the dependency path")).toBeVisible();
  });

  it("offers an open-review action once the pull request is in the queue", () => {
    queryState.openPullRequests = [
      {
        externalId: "pr-2",
        number: 2,
        title: "Implement FlakeGraph knowledge graph processor",
        sourceBranch: "cripdk/flake_graph_initial",
        targetBranch: "main",
      },
    ];
    queryState.dashboard = [
      {
        id: "review-2",
        number: 2,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        queueState: "active",
      },
    ];

    render(
      <RepositoryDetail
        intakeUpdatePending={false}
        onReconcile={vi.fn()}
        onRemove={vi.fn()}
        onRequestIntakeChange={vi.fn()}
        reconcilePending={false}
        repository={repository}
      />,
    );

    expect(screen.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      "/review/review-2",
    );
    expect(
      screen.queryByRole("button", { name: "Prepare review" }),
    ).not.toBeInTheDocument();
  });

  it("shows a retry action when the last prepare failed", () => {
    queryState.openPullRequests = [
      {
        externalId: "pr-2",
        number: 2,
        title: "Implement FlakeGraph knowledge graph processor",
        sourceBranch: "cripdk/flake_graph_initial",
        targetBranch: "main",
      },
    ];
    queryState.failedSyncs = [
      {
        repositoryId: "repository-1",
        pullRequestNumber: 2,
        message: "GitHub denied access while loading this pull request.",
      },
    ];

    render(
      <RepositoryDetail
        intakeUpdatePending={false}
        onReconcile={vi.fn()}
        onRemove={vi.fn()}
        onRequestIntakeChange={vi.fn()}
        reconcilePending={false}
        repository={repository}
      />,
    );

    expect(
      screen.getByText("GitHub denied access while loading this pull request."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
