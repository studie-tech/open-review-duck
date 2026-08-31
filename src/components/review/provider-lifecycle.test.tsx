// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderLifecycle } from "./provider-lifecycle";

type LifecycleState = RouterOutputs["review"]["providerLifecycle"];

afterEach(cleanup);

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
  provider: "github",
  pullRequestState: "open",
  revisionCurrent: true,
  summary: "failing",
  syncedAt: new Date("2026-08-30T08:00:00Z"),
};

describe("ProviderLifecycle", () => {
  it("lists check status and confirms a merge of the reviewed revision", async () => {
    const onMerge = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderLifecycle
        state={githubLifecycle}
        loading={false}
        mutationPending={false}
        provider="github"
        pullRequestUrl="https://github.com/acme/review/pull/12"
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
        provider="github"
        pullRequestUrl="https://github.com/acme/review/pull/12"
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
        provider="github"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    expect(screen.getByText("Checks running")).toBeVisible();
    expect(
      screen.getByText("Required checks or reviews are not satisfied"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
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
        provider="azure_devops"
        pullRequestUrl="https://dev.azure.com/acme/review/_git/review/pullrequest/12"
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
        provider="github"
        pullRequestUrl="https://github.com/acme/review/pull/12"
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
        provider="github"
        pullRequestUrl="https://github.com/acme/review/pull/12"
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
});
