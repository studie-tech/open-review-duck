// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiFixPromptPullRequest } from "~/lib/ai-fix-prompt";
import type { ProviderPullRequestComment } from "~/server/providers/types";
import {
  type ProviderDiscussionThread,
  ReviewDiscussionsPanel,
} from "./review-discussions";

afterEach(cleanup);

const pr: AiFixPromptPullRequest = {
  provider: "github",
  repositoryOwner: "acme",
  repositoryName: "app",
  number: 1873,
  title: "Profile visibility",
  webUrl: "https://github.com/acme/app/pull/1873",
  sourceBranch: "profile",
  targetBranch: "main",
  headSha: "abc1234",
};
const screenshot: ProviderPullRequestComment = {
  externalId: "issue-comment:10",
  kind: "comment",
  author: "Mathias",
  body: "**Verified profile visibility.**\n\n![Profile screenshot](https://github.com/user-attachments/assets/profile.png)",
  createdAt: "2026-10-13T19:34:02Z",
  webUrl: `${pr.webUrl}#issuecomment-10`,
};
const summary: ProviderPullRequestComment = {
  ...screenshot,
  externalId: "review:10",
  kind: "review",
  author: "Maya",
  body: "Review summary: please cover the timeout",
  createdAt: "2026-10-13T19:30:00Z",
  webUrl: `${pr.webUrl}#pullrequestreview-10`,
};
const code: ProviderDiscussionThread = {
  externalId: "issue-comment:10",
  path: "src/profile.ts",
  line: 12,
  side: "right",
  status: "open",
  unitId: "unit-1",
  comments: [
    {
      externalId: "code-10",
      body: "Preserve the preference",
      author: "Maya",
      createdAt: "2026-10-13T18:00:00Z",
      publishedByAnotherReviewer: false,
    },
  ],
};

/** Mounts mixed conversation sources with the production discussion browser. */
function props(
  threads: ProviderDiscussionThread[] = [],
  pullRequestComments = [screenshot, summary],
) {
  return {
    loading: false,
    pullRequest: pr,
    threads,
    pullRequestComments,
    onClose: vi.fn(),
    onOpenThread: vi.fn(),
    onRefresh: vi.fn(),
  };
}

describe("PR comments in Discussions", () => {
  it("shows comments when there are no code threads and enlarges their screenshots inside ReviewDuck", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<ReviewDiscussionsPanel {...callbacks} />);
    expect(screen.getByRole("tab", { name: "All 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Open 0" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Resolved 0" })).toBeVisible();
    const detail = within(
      screen.getByRole("region", { name: "Selected discussion" }),
    );
    expect(
      detail.getByRole("heading", { name: "Pull request conversation" }),
    ).toBeVisible();
    expect(
      detail.getByText("Verified profile visibility.", { selector: "strong" }),
    ).toBeVisible();
    expect(detail.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      screenshot.webUrl,
    );
    expect(detail.queryByText("L0")).toBeNull();
    expect(detail.queryByRole("button", { name: "View in code" })).toBeNull();
    expect(detail.queryByRole("button", { name: /fix prompt/ })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Enlarge image: Profile screenshot" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Image preview: Profile screenshot" }),
    ).toBeVisible();
    expect(callbacks.onOpenThread).not.toHaveBeenCalled();
  });

  it("keeps PR comments out of resolution counts and code navigation, with collision-free selection", async () => {
    const user = userEvent.setup();
    const callbacks = props([
      code,
      { ...code, externalId: "resolved", status: "resolved" },
    ]);
    render(<ReviewDiscussionsPanel {...callbacks} />);
    expect(screen.getByRole("tab", { name: "All 4" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Open 1" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 thread");
    await user.click(screen.getByRole("button", { name: "View in code" }));
    expect(callbacks.onOpenThread).toHaveBeenCalledWith(code);
    await user.click(screen.getByRole("tab", { name: "Resolved 1" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 thread");
    await user.click(screen.getByRole("tab", { name: "PR comments 2" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 comments");
    expect(screen.queryByRole("button", { name: "View in code" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Read PR comment by Maya/ }),
    );
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("Review summary: please cover the timeout"),
    ).toBeVisible();
    const comments = screen.getByRole("tab", { name: "PR comments 2" });
    fireEvent.keyDown(comments, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "All 4" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "All 4" }), {
      key: "End",
    });
    expect(comments).toHaveFocus();
  });

  it("searches and filters commentary, participants, and attachments alongside code", async () => {
    const user = userEvent.setup();
    render(<ReviewDiscussionsPanel {...props([code])} />);
    await user.click(screen.getByRole("button", { name: "With images" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 conversation matching of 3",
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search discussions" }),
      "profile visibility",
    );
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter discussions by participant",
      }),
      "Mathias",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 conversation matching of 3",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter discussions by file" }),
      "src/profile.ts",
    );
    expect(screen.getByText("No matching discussions")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status")).toHaveTextContent("3 conversations");
    await user.type(
      screen.getByRole("searchbox", { name: "Search discussions" }),
      "timeout",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 conversation matching of 3",
    );
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      summary.webUrl,
    );
  });

  it("retains selection through edited comments and keeps loaded commentary visible on refresh failure", async () => {
    const user = userEvent.setup();
    const initial = props();
    const { rerender } = render(<ReviewDiscussionsPanel {...initial} />);
    await user.click(
      screen.getByRole("button", { name: /Read PR comment by Maya/ }),
    );
    rerender(
      <ReviewDiscussionsPanel
        {...initial}
        loading
        pullRequestComments={[
          { ...summary, body: "Updated review summary" },
          screenshot,
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 conversations");
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("Updated review summary"),
    ).toBeVisible();
    rerender(
      <ReviewDiscussionsPanel
        {...initial}
        error="Provider unavailable"
        pullRequestComments={[
          { ...summary, body: "Updated review summary" },
          screenshot,
        ]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last loaded conversations.",
    );
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("Updated review summary"),
    ).toBeVisible();
  });
});
