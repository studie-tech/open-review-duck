// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestImport } from "./pull-request-import";

const state = vi.hoisted(() => ({
  replace: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  target: undefined as
    | undefined
    | { repositoryId: string; repositoryName: string; number: number },
  targetError: undefined as
    | undefined
    | { message: string; data?: { code: string } },
  status: undefined as
    | undefined
    | {
        status: string;
        progress: number;
        pullRequestId: string | null;
        error?: string;
      },
  onSuccess: undefined as undefined | ((result: { syncId: string }) => void),
}));
const router = { replace: state.replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("~/trpc/react", () => ({
  api: {
    review: {
      resolveImportLink: {
        useQuery: () => ({
          data: state.target,
          error: state.targetError,
          refetch: state.refetch,
        }),
      },
      sync: {
        useMutation: (options: { onSuccess: typeof state.onSuccess }) => {
          state.onSuccess = options.onSuccess;
          return { mutate: state.mutate, isPending: false };
        },
      },
      syncStatus: {
        useQuery: () => ({ data: state.status, refetch: state.refetch }),
      },
    },
  },
}));
const url = "https://github.com/team/repo/pull/42";
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.target = {
    repositoryId: "repository-id",
    repositoryName: "team/repo",
    number: 42,
  };
  state.targetError = undefined;
  state.status = undefined;
});

describe("linked pull request import", () => {
  it("starts once under StrictMode and waits for completion before redirecting", () => {
    const { rerender } = render(
      <StrictMode>
        <PullRequestImport url={url} />
      </StrictMode>,
    );
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
      repositoryId: "repository-id",
      number: 42,
    });
    state.status = { status: "running", progress: 45, pullRequestId: null };
    rerender(
      <StrictMode>
        <PullRequestImport url={url} />
      </StrictMode>,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "45",
    );
    expect(state.replace).not.toHaveBeenCalled();
    state.status = {
      status: "completed",
      progress: 100,
      pullRequestId: "prepared-pr",
    };
    rerender(
      <StrictMode>
        <PullRequestImport url={url} />
      </StrictMode>,
    );
    expect(state.replace).toHaveBeenCalledWith("/review/prepared-pr");
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
  it("shows an inaccessible repository and does not start an import", () => {
    state.target = undefined;
    state.targetError = {
      message: "Repository is not connected",
      data: { code: "NOT_FOUND" },
    };
    render(<PullRequestImport url={url} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Repository is not connected",
    );
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText("Manage repositories").getAttribute("href")).toBe(
      "/settings/providers",
    );
  });
  it("allows a failed job to be retried without redirecting", () => {
    state.status = {
      status: "failed",
      progress: 20,
      error: "Provider unavailable",
      pullRequestId: null,
    };
    render(<PullRequestImport url={url} />);
    expect(screen.getByRole("alert").textContent).toBe("Provider unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(state.replace).not.toHaveBeenCalled();
  });
  it("explains malformed links", () => {
    state.target = undefined;
    render(<PullRequestImport url="invalid" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "valid GitHub pull request",
    );
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
