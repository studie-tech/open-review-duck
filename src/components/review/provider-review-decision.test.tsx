// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderReviewDecision } from "./provider-review-decision";

vi.mock("~/lib/hosted-provider-authorization", () => ({
  startHostedProviderAuthorization: vi.fn().mockResolvedValue(undefined),
}));

type ReviewState = RouterOutputs["review"]["providerReviewState"];

afterEach(cleanup);

const githubState: ReviewState = {
  personalAccountRequired: false,
  connection: {
    canReconnect: false,
    canReplaceToken: true,
    connectionId: "conn-github",
    credentialKind: "pat",
  },
  actorName: "Duck Reviewer",
  approvedCount: 1,
  approvalsRemaining: undefined,
  canApprove: true,
  canClear: false,
  canRequestChanges: true,
  changesRequestedCount: 0,
  decision: "none",
  provider: "github",
  requestChangesRequiresBody: true,
  requiredApprovals: undefined,
  revisionCurrent: true,
  syncedAt: new Date("2026-07-30T08:00:00Z"),
  unavailableReason: undefined,
};

describe("ProviderReviewDecision", () => {
  it("links to the repository and confirms an approval", async () => {
    const onDecision = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderReviewDecision
        state={githubState}
        loading={false}
        mutationPending={false}
        provider="github"
        repositoryUrl="https://github.com/acme/review"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByRole("link", { name: /Repository/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/review",
    );
    expect(
      screen.getByRole("link", { name: /Open pull request/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      screen.getByRole("heading", { name: "Approve on GitHub?" }),
    ).toBeVisible();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /Approve/,
      }),
    );
    expect(onDecision).toHaveBeenCalledWith("approve", undefined);
  });

  it("requires a reason for GitHub change requests", async () => {
    const onDecision = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderReviewDecision
        state={githubState}
        loading={false}
        mutationPending={false}
        provider="github"
        repositoryUrl="https://github.com/acme/review"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onDecision={onDecision}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const submit = within(screen.getByRole("dialog")).getByRole("button", {
      name: /Request changes/,
    });
    expect(submit).toBeDisabled();
    await user.type(
      screen.getByLabelText("Reason (required)"),
      "Please cover the failure path.",
    );
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onDecision).toHaveBeenCalledWith(
      "request_changes",
      "Please cover the failure path.",
    );
  });

  it("offers personal authorization for a GitHub App connection", async () => {
    render(
      <ProviderReviewDecision
        state={{
          ...githubState,
          personalAccountRequired: true,
          canApprove: false,
          canRequestChanges: false,
          connection: {
            canReconnect: true,
            canReplaceToken: false,
            connectionId: "app",
            credentialKind: "github_app",
          },
          unavailableReason:
            "GitHub App installations can synchronize approval state, but a personal approval must be submitted with your GitHub user identity.",
        }}
        loading={false}
        mutationPending={false}
        provider="github"
        repositoryUrl="https://github.com/acme/review"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Connect my GitHub account" }),
    );
    expect(startHostedProviderAuthorization).toHaveBeenCalledWith(
      "github",
      "/settings/providers",
      undefined,
      {
        purpose: "user_identity",
        connectionId: "app",
      },
    );
    expect(screen.getByText("Approve from ReviewDuck")).toBeVisible();
    expect(
      screen.getByText(/comment posting preference stays unchanged/i),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Review on GitHub/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Open provider settings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open pull request/i }),
    ).toBeVisible();
  });

  it("helps update permissions when review state cannot be synchronized", () => {
    render(
      <ProviderReviewDecision
        error="GitHub review state could not be synchronized"
        loading={false}
        mutationPending={false}
        provider="github"
        repositoryUrl="https://github.com/acme/review"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText(/could not be synchronized/i)).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Open provider settings/i }),
    ).toHaveAttribute("href", "/settings/providers");
    expect(
      screen.getByRole("link", { name: /Finish on GitHub/i }),
    ).toHaveAttribute("href", "https://github.com/acme/review/pull/12");
  });

  it("keeps an ordinary review error visible when approval state is already loaded", () => {
    render(
      <ProviderReviewDecision
        state={githubState}
        error="GitHub review state could not be synchronized"
        loading={false}
        mutationPending={false}
        provider="github"
        repositoryUrl="https://github.com/acme/review"
        pullRequestUrl="https://github.com/acme/review/pull/12"
        onRefresh={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    expect(
      screen.getByText("GitHub review state could not be synchronized"),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Open provider settings/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
  });
  it.each(["gitlab", "azure_devops"] as const)(
    "keeps %s review actions provider-specific",
    async (provider) => {
      render(
        <ProviderReviewDecision
          state={{
            ...githubState,
            provider,
            decision: "approved",
            canApprove: false,
            canClear: true,
            canRequestChanges: provider === "azure_devops",
            requestChangesRequiresBody: false,
          }}
          loading={false}
          mutationPending={false}
          provider={provider}
          repositoryUrl="https://example.com/repo"
          pullRequestUrl="https://example.com/pull/1"
          onRefresh={vi.fn()}
          onDecision={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: provider === "gitlab" ? "Unapprove" : "Clear decision",
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Request changes" }),
      ).not.toBeInTheDocument();
      if (provider === "azure_devops")
        expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
    },
  );

  it("routes Azure DevOps personal connection to settings without replacing the workspace token", () => {
    render(
      <ProviderReviewDecision
        state={{
          ...githubState,
          provider: "azure_devops",
          personalAccountRequired: true,
          canApprove: false,
        }}
        loading={false}
        mutationPending={false}
        provider="azure_devops"
        repositoryUrl="https://example.com/repo"
        pullRequestUrl="https://example.com/pull/1"
        onRefresh={vi.fn()}
        onDecision={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Connect my Azure DevOps account" }),
    ).toHaveAttribute("href", "/settings/providers?connection=conn-github");
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
  });

  it("disables confirmation when refresh discovers a newer revision", async () => {
    const props = {
      loading: false,
      mutationPending: false,
      provider: "github" as const,
      repositoryUrl: "https://example.com/repo",
      pullRequestUrl: "https://example.com/pull/1",
      onRefresh: vi.fn(),
      onDecision: vi.fn(),
    };
    const view = render(
      <ProviderReviewDecision {...props} state={githubState} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    view.rerender(
      <ProviderReviewDecision
        {...props}
        state={{
          ...githubState,
          revisionCurrent: false,
          canApprove: false,
          unavailableReason: "Synchronize the newer revision.",
        }}
      />,
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /Approve/,
      }),
    ).toBeDisabled();
  });
  it("submits an Azure rejection vote without collecting a discarded reason", async () => {
    const onDecision = vi.fn();
    render(
      <ProviderReviewDecision
        state={{
          ...githubState,
          provider: "azure_devops",
          requestChangesRequiresBody: false,
        }}
        loading={false}
        mutationPending={false}
        provider="azure_devops"
        repositoryUrl="https://example.com/repo"
        pullRequestUrl="https://example.com/pull/1"
        onRefresh={vi.fn()}
        onDecision={onDecision}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /Reject/,
      }),
    );
    expect(onDecision).toHaveBeenCalledWith("request_changes", undefined);
  });
});
