// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiFixPromptPullRequest } from "~/lib/ai-fix-prompt";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderLifecycle } from "./provider-lifecycle";

type LifecycleState = RouterOutputs["review"]["providerLifecycle"];

afterEach(cleanup);

const githubPullRequest: AiFixPromptPullRequest = {
  provider: "github",
  repositoryOwner: "acme",
  repositoryName: "review",
  number: 12,
  title: "Retry provider calls",
  webUrl: "https://github.com/acme/review/pull/12",
  sourceBranch: "feature/retries",
  targetBranch: "main",
  headSha: "abc1234",
};

const azurePullRequest: AiFixPromptPullRequest = {
  ...githubPullRequest,
  provider: "azure_devops",
  webUrl: "https://dev.azure.com/acme/review/_git/review/pullrequest/12",
};

const githubConnection = {
  canReconnect: false,
  canReplaceToken: true,
  connectionId: "conn-github",
  credentialKind: "pat",
};

const githubLifecycle: LifecycleState = {
  canMerge: true,
  connection: githubConnection,
  hasMergePermission: true,
  checks: [
    {
      id: "check-1",
      name: "ci / test",
      state: "success",
      description: "12 passed",
      webUrl: "https://github.com/acme/review/actions/1",
    },
    {
      id: "check-2",
      name: "lint",
      state: "failure",
      description: "Process completed with exit code 1",
    },
  ],
  headSha: "abc1234",
  mergeActionLabel: "Merge",
  mergeable: true,
  mergeBlockedReason: undefined,
  mergeBlockedFix: undefined,
  provider: "github",
  pullRequestState: "open",
  revisionCurrent: true,
  summary: "failing",
  syncedAt: new Date("2026-08-30T08:00:00Z"),
};

describe("ProviderLifecycle", () => {
  it("offers to publish a reviewed draft even when it cannot be merged", async () => {
    const onMarkReady = vi.fn();
    const props = {
      loading: false,
      mutationPending: false,
      pullRequest: githubPullRequest,
      onRefresh: vi.fn(),
      onMerge: vi.fn(),
      onMarkReady,
    };
    const state = {
      ...githubLifecycle,
      pullRequestState: "draft" as const,
      canMerge: false,
      hasMergePermission: false,
      mergeBlockedReason: "Draft pull requests cannot be merged",
    };
    const { rerender } = render(<ProviderLifecycle {...props} state={state} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Mark ready for review" }),
    );
    expect(onMarkReady).toHaveBeenCalledOnce();
    expect(props.onMerge).not.toHaveBeenCalled();
    rerender(
      <ProviderLifecycle
        {...props}
        state={{ ...state, revisionCurrent: false }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Mark ready for review" }),
    ).toBeDisabled();
    rerender(
      <ProviderLifecycle
        {...props}
        state={state}
        mutationPending
        readyError="Provider denied this action"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Mark ready for review" }),
    ).toBeDisabled();
    expect(screen.getByText("Provider denied this action")).toHaveAttribute(
      "role",
      "alert",
    );
    rerender(<ProviderLifecycle {...props} state={githubLifecycle} />);
    expect(
      screen.queryByRole("button", { name: "Mark ready for review" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("offers draft permission recovery even when merge permission is present", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          pullRequestState: "draft",
          canMerge: false,
        }}
        readyError="Write access denied"
        permissionDenied
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
        onMarkReady={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Update token permissions" }),
    ).toHaveAttribute(
      "href",
      "/settings/providers?connection=conn-github&repair=token",
    );
    expect(screen.getByText("Pull requests: Read and write")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Mark ready on GitHub" }),
    ).toBeVisible();
  });

  it("lists check status and confirms a merge of the reviewed revision", async () => {
    const onMerge = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderLifecycle
        state={githubLifecycle}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={onMerge}
      />,
    );

    expect(screen.getByText("Checks failed")).toBeVisible();
    expect(screen.getByText("ci / test")).toBeVisible();
    expect(
      screen.getByText("Process completed with exit code 1"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /ci \/ test/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/review/actions/1",
    );
    expect(
      screen.getByText(/still allows merging this revision/i),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(
      screen.getByRole("heading", { name: "Merge on GitHub?" }),
    ).toBeVisible();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /Merge/,
      }),
    );
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it("keeps merge enabled while only optional checks are still queued", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          canMerge: true,
          summary: "passing",
          checks: [
            {
              id: "check-1",
              name: "ci / test",
              state: "success",
              required: true,
            },
            {
              id: "check-2",
              name: "deploy preview",
              state: "queued",
              required: false,
            },
          ],
        }}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText("Checked & ready")).toBeVisible();
    expect(
      screen.getByText(/still allows merging this revision/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("disables merge when the provider is blocked and explains why", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          canMerge: false,
          summary: "pending",
          mergeBlockedReason: "Required checks or reviews are not satisfied",
          checks: [
            {
              id: "check-1",
              name: "ci / test",
              state: "in_progress",
            },
          ],
        }}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText("Checks running")).toBeVisible();
    expect(
      screen.getByText("Required checks or reviews are not satisfied"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(
      screen.getByRole("link", { name: /Open on GitHub/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");
  });

  it("keeps merge failure feedback visible in the open dialog", async () => {
    const user = userEvent.setup();
    const view = render(
      <ProviderLifecycle
        state={githubLifecycle}
        error={undefined}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Merge" }));
    view.rerender(
      <ProviderLifecycle
        state={githubLifecycle}
        error="GitHub could not merge this pull request"
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("alert"),
    ).toHaveTextContent("GitHub could not merge this pull request");
  });

  it("updates an open merge dialog with the refreshed conflict blocker", async () => {
    const user = userEvent.setup();
    const view = render(
      <ProviderLifecycle
        state={githubLifecycle}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Merge" }));
    view.rerender(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          canMerge: false,
          mergeable: false,
          mergeBlockedReason:
            "The repository requires rebase merges, but this pull request cannot be rebased because its commits conflict with the target branch. Resolve the conflicts on GitHub, then refresh.",
        }}
        error="GitHub could not merge this pull request"
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Merge is blocked on GitHub",
      }),
    ).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "cannot be rebased",
    );
    expect(
      within(dialog).getByRole("button", { name: /Merge/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("link", { name: /Open on GitHub/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");
  });

  it("shows a completed Azure pull request without a complete button", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          provider: "azure_devops",
          pullRequestState: "merged",
          canMerge: false,
          mergeActionLabel: "Complete",
          mergeBlockedReason: "Already completed",
          summary: "passing",
          checks: [
            {
              id: "status-1",
              name: "Build",
              state: "success",
            },
          ],
        }}
        loading={false}
        mutationPending={false}
        pullRequest={azurePullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText("Merged")).toBeVisible();
    expect(
      screen.getByText("This pull request is merged on Azure DevOps."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Complete" }),
    ).not.toBeInTheDocument();
  });

  it("explains a missing merge permission and links to update it", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          canMerge: false,
          hasMergePermission: false,
        }}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText(/cannot merge on GitHub/i)).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Update token permissions/i }),
    ).toHaveAttribute(
      "href",
      "/settings/providers?connection=conn-github&repair=token",
    );
    expect(
      screen.getByRole("link", { name: /Merge on GitHub/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("reconnects a GitHub App when merge permission is missing", () => {
    render(
      <ProviderLifecycle
        state={{
          ...githubLifecycle,
          canMerge: false,
          hasMergePermission: false,
          connection: {
            canReconnect: true,
            canReplaceToken: false,
            connectionId: "conn-app",
            credentialKind: "github_app",
          },
        }}
        loading={false}
        mutationPending={false}
        pullRequest={githubPullRequest}
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText("This GitHub App cannot merge")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Reconnect GitHub/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  describe("AI fix prompts", () => {
    /** Installs a clipboard the jsdom navigator does not expose. */
    function mockClipboard() {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      return writeText;
    }
    const props = {
      loading: false,
      mutationPending: false,
      pullRequest: githubPullRequest,
      onRefresh: vi.fn(),
      onMerge: vi.fn(),
    };

    it("offers a fix prompt for a block a commit can lift", async () => {
      const writeText = mockClipboard();
      render(
        <ProviderLifecycle
          {...props}
          state={{
            ...githubLifecycle,
            canMerge: false,
            mergeable: false,
            mergeBlockedReason: "Has merge conflicts",
            mergeBlockedFix: "resolve_conflicts",
          }}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "Copy AI fix prompt for the merge block",
        }),
      );

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledOnce();
      });
      const prompt = writeText.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("# Unblock merging pull request #12");
      expect(prompt).toContain("Has merge conflicts");
      expect(prompt).toContain(
        "Bring `feature/retries` up to date with `main`",
      );
    });

    it("quotes failing checks and open conversations in the block prompt", async () => {
      const writeText = mockClipboard();
      const { rerender } = render(
        <ProviderLifecycle
          {...props}
          state={{
            ...githubLifecycle,
            canMerge: false,
            mergeBlockedReason: "Required checks or reviews are not satisfied",
            mergeBlockedFix: "fix_checks",
          }}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Copy AI fix prompt for the merge block",
        }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledOnce();
      });
      expect(writeText.mock.calls[0]?.[0]).toContain(
        "- lint — Process completed with exit code 1",
      );
      expect(writeText.mock.calls[0]?.[0]).not.toContain("ci / test");

      rerender(
        <ProviderLifecycle
          {...props}
          discussions={[
            {
              path: "src/retry.ts",
              line: 17,
              comments: [
                {
                  author: "Maya",
                  createdAt: "2026-07-20T10:00:00Z",
                  body: "Cap the delay.",
                },
              ],
            },
          ]}
          state={{
            ...githubLifecycle,
            canMerge: false,
            mergeBlockedReason: "Requested changes must be addressed",
            mergeBlockedFix: "address_review",
          }}
        />,
      );
      // The copied state from the first click is still showing.
      fireEvent.click(
        screen.getByRole("button", {
          name: "AI fix prompt for the merge block copied",
        }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(2);
      });
      expect(writeText.mock.calls[1]?.[0]).toContain(
        "### src/retry.ts line 17",
      );
      expect(writeText.mock.calls[1]?.[0]).toContain("Cap the delay.");
    });

    it("offers nothing for a block only a person or time can lift", () => {
      render(
        <ProviderLifecycle
          {...props}
          state={{
            ...githubLifecycle,
            checks: [],
            summary: "empty",
            canMerge: false,
            mergeBlockedReason: "Required approvals are missing",
            mergeBlockedFix: undefined,
          }}
        />,
      );
      expect(screen.getByText("Required approvals are missing")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Copy AI fix prompt/ }),
      ).not.toBeInTheDocument();
    });

    it("offers a fix prompt on each failed check but no other row", async () => {
      const writeText = mockClipboard();
      render(<ProviderLifecycle {...props} state={githubLifecycle} />);

      const buttons = screen.getAllByRole("button", {
        name: /Copy AI fix prompt for the failing check/,
      });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(
        "Copy AI fix prompt for the failing check lint",
      );
      expect(screen.getByRole("link", { name: /ci \/ test/ })).toHaveAttribute(
        "href",
        "https://github.com/acme/review/actions/1",
      );

      fireEvent.click(buttons[0] as HTMLElement);
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledOnce();
      });
      const prompt = writeText.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("# Fix the failing check on pull request #12");
      expect(prompt).toContain("- lint — Process completed with exit code 1");
    });

    it("repeats the fix prompt inside the blocked-merge dialog", async () => {
      mockClipboard();
      const user = userEvent.setup();
      const view = render(
        <ProviderLifecycle {...props} state={githubLifecycle} />,
      );
      await user.click(screen.getByRole("button", { name: "Merge" }));
      view.rerender(
        <ProviderLifecycle
          {...props}
          state={{
            ...githubLifecycle,
            canMerge: false,
            mergeable: false,
            mergeBlockedReason: "Has merge conflicts",
            mergeBlockedFix: "resolve_conflicts",
          }}
        />,
      );

      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("button", {
          name: "Copy AI fix prompt for the merge block",
        }),
      ).toBeVisible();
    });
  });
});
