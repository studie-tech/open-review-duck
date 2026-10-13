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
import {
  isOpenProviderDiscussion,
  orderProviderDiscussions,
  type ProviderDiscussionThread,
  ReviewDiscussionSummary,
  ReviewDiscussionsPanel,
} from "./review-discussions";

afterEach(cleanup);

const pullRequest: AiFixPromptPullRequest = {
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

/** Builds one provider discussion fixture with focused overrides. */
function discussion(
  overrides: Partial<ProviderDiscussionThread> = {},
): ProviderDiscussionThread {
  return {
    externalId: "thread-1",
    path: "src/retry.ts",
    line: 17,
    side: "right",
    status: "open",
    comments: [
      {
        externalId: "comment-1",
        author: "Maya",
        body: "Should this retry delay be capped?",
        createdAt: "2026-07-20T10:00:00Z",
        publishedByAnotherReviewer: false,
      },
    ],
    unitId: "unit-1",
    ...overrides,
  };
}

const baseComment: ProviderDiscussionThread["comments"][number] = {
  externalId: "base-comment",
  author: "Maya",
  body: "Root comment",
  createdAt: "2026-07-20T10:00:00Z",
  publishedByAnotherReviewer: false,
};

describe("provider discussion state", () => {
  it("keeps provider-unknown resolution visible as open", () => {
    expect(isOpenProviderDiscussion(discussion({ status: "unknown" }))).toBe(
      true,
    );
    expect(isOpenProviderDiscussion(discussion({ status: "resolved" }))).toBe(
      false,
    );
  });

  it("orders discussions by path and line", () => {
    expect(
      orderProviderDiscussions([
        discussion({ externalId: "c", path: "z.ts", line: 1 }),
        discussion({ externalId: "b", path: "a.ts", line: 20 }),
        discussion({ externalId: "a", path: "a.ts", line: 10 }),
      ]).map(({ externalId }) => externalId),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("ReviewDiscussionsPanel", () => {
  it("shows open discussions first and keeps resolved discussions behind a tab", async () => {
    const user = userEvent.setup();
    render(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[
          discussion(),
          discussion({
            externalId: "thread-2",
            status: "resolved",
            comments: [
              {
                externalId: "comment-2",
                author: "Noah",
                body: "The abort signal now covers this path.",
                createdAt: "2026-07-20T11:00:00Z",
                publishedByAnotherReviewer: true,
              },
            ],
          }),
        ]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("Should this retry delay be capped?"),
    ).toBeVisible();
    expect(
      screen.queryByText("The abort signal now covers this path."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Resolved 1" }));
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("The abort signal now covers this path."),
    ).toBeVisible();
    expect(
      screen.queryByText("Should this retry delay be capped?"),
    ).not.toBeInTheDocument();
  });

  it("offers a fix prompt on open conversations only", async () => {
    // user-event installs its own clipboard on setup, so ours goes in after.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[
          discussion(),
          discussion({ externalId: "thread-2", status: "resolved" }),
        ]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy AI fix prompt for the conversation in src/retry.ts at line 17",
      }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce();
    });
    const prompt = writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(
      "# Address a review conversation on pull request #12",
    );
    expect(prompt).toContain("### src/retry.ts line 17");
    expect(prompt).toContain("Should this retry delay be capped?");

    await user.click(screen.getByRole("tab", { name: "Resolved 1" }));
    expect(
      screen.queryByRole("button", { name: /fix prompt/ }),
    ).not.toBeInTheDocument();
  });

  it("opens a selected conversation in its review unit", async () => {
    const onOpenThread = vi.fn();
    const thread = discussion();
    const user = userEvent.setup();
    render(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[thread]}
        onClose={vi.fn()}
        onOpenThread={onOpenThread}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View in code" }));
    expect(onOpenThread).toHaveBeenCalledWith(thread);
  });

  it("shows full comments without navigating away from discussions", async () => {
    const onOpenThread = vi.fn();
    const body =
      "This is a deliberately long review comment explaining why the current branch can return stale data, how the retry path reaches it, and which invariant should be preserved before this conversation is considered resolved by the reviewer.";
    render(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[
          discussion({
            comments: [
              {
                externalId: "comment-long",
                author: "Maya",
                body,
                createdAt: "2026-07-20T10:00:00Z",
                publishedByAnotherReviewer: false,
              },
            ],
          }),
        ]}
        onClose={vi.fn()}
        onOpenThread={onOpenThread}
        onRefresh={vi.fn()}
      />,
    );

    const detail = screen.getByRole("region", { name: "Selected discussion" });
    expect(within(detail).getByText(body)).not.toHaveClass("line-clamp-2");
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("uses a focus-trapping modal dialog and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[discussion()]}
        onClose={onClose}
        onOpenThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    const panel = screen.getByRole("dialog", { name: "Discussions" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("button", { name: "Close pull request discussions" }),
    ).toHaveFocus();

    fireEvent(panel, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("defaults to All when every discussion is resolved", () => {
    renderPanel([discussion({ status: "resolved" })]);
    expect(screen.getByRole("tab", { name: "All 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByText("Should this retry delay be capped?"),
    ).toBeVisible();
  });

  it("searches every reply and includes resolved threads from the default scope", async () => {
    const user = userEvent.setup();
    renderPanel([
      discussion(),
      discussion({
        externalId: "resolved",
        status: "resolved",
        path: "src/cache.ts",
        comments: [
          {
            ...baseComment,
            externalId: "root",
            body: "Cache behavior",
          },
          {
            ...baseComment,
            externalId: "reply",
            author: "Noah",
            body: "The invalidation race is now fixed.",
          },
        ],
      }),
    ]);
    await user.type(
      screen.getByRole("searchbox", { name: "Search discussions" }),
      "invalidation",
    );
    expect(screen.getByRole("tab", { name: "All 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const detail = screen.getByRole("region", { name: "Selected discussion" });
    expect(within(detail).getByText("Cache behavior")).toBeVisible();
    expect(
      within(detail).getByText("The invalidation race is now fixed."),
    ).toBeVisible();
    expect(within(detail).getByText("Search match")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 thread matching of 2",
    );
    await user.click(screen.getByRole("tab", { name: "Open 1" }));
    expect(screen.getByText("No matching discussions")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Clear filters and show all" }),
    );
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("2 threads");
  });

  it("combines file, participant, and image filters across complete threads", async () => {
    const user = userEvent.setup();
    renderPanel([
      discussion(),
      discussion({
        externalId: "images",
        path: "src/cache.ts",
        comments: [
          { ...baseComment, body: "See the result." },
          {
            ...baseComment,
            externalId: "reply",
            author: "Noah",
            body: "![Cache diagram](https://user-images.githubusercontent.com/cache.png)",
          },
        ],
      }),
      discussion({
        externalId: "badge",
        path: "src/cache.ts",
        comments: [
          {
            ...baseComment,
            author: "Noah",
            body: '<img src="https://example.com/badge.svg" alt="P2">',
          },
        ],
      }),
    ]);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter discussions by file" }),
      "src/cache.ts",
    );
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Filter discussions by participant",
      }),
      "Noah",
    );
    await user.click(screen.getByRole("button", { name: "With images" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 thread matching of 3",
    );
    expect(screen.getByRole("button", { name: "With images" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Enlarge image: Cache diagram" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status")).toHaveTextContent("3 threads");
    expect(
      screen.getByRole("combobox", {
        name: "Filter discussions by participant",
      }),
    ).toHaveValue("");
  });

  it("opens an image preview and closes only the preview on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel(
      [
        discussion({
          comments: [
            {
              ...baseComment,
              body: "![Screenshot](https://user-images.githubusercontent.com/screenshot.png)",
            },
          ],
        }),
      ],
      { onClose },
    );
    await user.click(
      screen.getByRole("button", { name: "Enlarge image: Screenshot" }),
    );
    const preview = screen.getByRole("dialog", {
      name: "Image preview: Screenshot",
    });
    expect(preview).toHaveAttribute("aria-modal", "true");
    fireEvent(preview, new Event("cancel", { cancelable: true }));
    expect(
      screen.queryByRole("dialog", { name: "Image preview: Screenshot" }),
    ).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Enlarge image: Screenshot" }),
    ).toHaveFocus();
  });

  it("keeps the selected conversation readable on refresh failures", () => {
    const onRefresh = vi.fn();
    const { rerender } = renderPanel([discussion()], { onRefresh });
    rerender(
      <ReviewDiscussionsPanel
        loading={false}
        error="Provider unavailable"
        pullRequest={pullRequest}
        threads={[discussion()]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last loaded conversations",
    );
    expect(
      screen.getByRole("region", { name: "Selected discussion" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("orders by recent activity and retains selection when sorting", async () => {
    const user = userEvent.setup();
    renderPanel([
      discussion({ externalId: "old", path: "a.ts" }),
      discussion({
        externalId: "new",
        path: "b.ts",
        comments: [
          {
            ...baseComment,
            createdAt: "2026-08-01T10:00:00Z",
            body: "Newest conversation",
          },
        ],
      }),
    ]);
    expect(
      screen.getByRole("region", { name: "Selected discussion" }),
    ).toHaveTextContent("Newest conversation");
    await user.click(
      screen.getByRole("button", {
        name: "Read discussion in b.ts at line 17",
      }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort discussions" }),
      "file",
    );
    expect(
      screen.getByRole("region", { name: "Selected discussion" }),
    ).toHaveTextContent("Newest conversation");
    const rows = within(
      screen.getByRole("list", { name: "Discussion threads" }),
    ).getAllByRole("button");
    expect(rows[0]).toHaveAccessibleName("Read discussion in a.ts at line 17");
  });

  it("supports keyboard status tabs and search shortcuts", () => {
    renderPanel([
      discussion(),
      discussion({ externalId: "resolved", status: "resolved" }),
    ]);
    const open = screen.getByRole("tab", { name: "Open 1" });
    fireEvent.keyDown(open, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Resolved 1" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Resolved 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Discussions" }), {
      key: "f",
      ctrlKey: true,
    });
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("keeps unassigned provider threads readable and offers their provider link", () => {
    renderPanel([
      discussion({
        unitId: null,
        webUrl: "https://github.com/acme/review/pull/12#thread",
      }),
    ]);
    expect(screen.getByRole("button", { name: "View in code" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/review/pull/12#thread",
    );
  });

  it("preserves the initially selected thread when another thread gets a newer reply", () => {
    const original = discussion();
    const { rerender } = renderPanel([original]);
    rerender(
      <ReviewDiscussionsPanel
        loading={false}
        pullRequest={pullRequest}
        threads={[
          original,
          discussion({
            externalId: "newer",
            path: "src/cache.ts",
            comments: [
              {
                ...baseComment,
                createdAt: "2026-08-01T10:00:00Z",
                body: "New activity",
              },
            ],
          }),
        ]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Selected discussion" }),
    ).toHaveTextContent("Should this retry delay be capped?");
    expect(
      screen.getByRole("button", {
        name: "Read discussion in src/retry.ts at line 17",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("moves focus into a selected conversation and back to its thread", async () => {
    const user = userEvent.setup();
    renderPanel([discussion()]);
    const row = screen.getByRole("button", {
      name: "Read discussion in src/retry.ts at line 17",
    });
    await user.click(row);
    expect(
      within(
        screen.getByRole("region", { name: "Selected discussion" }),
      ).getByRole("heading"),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "All threads" }));
    expect(row).toHaveFocus();
  });

  it("returns to the visible search controls when finding from a full conversation", async () => {
    const user = userEvent.setup();
    renderPanel([discussion()]);
    await user.click(
      screen.getByRole("button", {
        name: "Read discussion in src/retry.ts at line 17",
      }),
    );
    const search = screen.getByRole("searchbox");
    expect(search.closest(".border-b")).toHaveClass("hidden");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Discussions" }), {
      key: "f",
      ctrlKey: true,
    });
    expect(search.closest(".border-b")).not.toHaveClass("hidden");
    expect(search).toHaveFocus();
  });

  it("does not move focus away when searching after selecting a desktop thread", async () => {
    const user = userEvent.setup();
    renderPanel([discussion()]);
    await user.click(
      screen.getByRole("button", {
        name: "Read discussion in src/retry.ts at line 17",
      }),
    );
    await user.type(screen.getByRole("searchbox"), "retry");
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("keeps modal keyboard commands from reaching the review beneath it", () => {
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    try {
      renderPanel([
        discussion(),
        discussion({ externalId: "resolved", status: "resolved" }),
      ]);
      fireEvent.keyDown(screen.getByRole("tab", { name: "Open 1" }), {
        key: "ArrowRight",
      });
      expect(screen.getByRole("tab", { name: "Resolved 1" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outside);
    }
  });

  it("keeps the discussions toggle available while modal review commands are isolated", () => {
    const onClose = vi.fn();
    renderPanel([discussion()], { onClose });
    const event = new KeyboardEvent("keydown", {
      key: "d",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("dialog", { name: "Discussions" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("searchbox"), {
      key: "d",
      metaKey: true,
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("uses a matching excerpt from deep inside a long reply", async () => {
    const user = userEvent.setup();
    renderPanel([
      discussion({
        comments: [
          {
            ...baseComment,
            body: `${"Earlier context. ".repeat(40)}The regression was in the invalidation path.`,
          },
        ],
      }),
    ]);
    await user.type(screen.getByRole("searchbox"), "invalidation");
    const list = screen.getByRole("list", { name: "Discussion threads" });
    expect(
      within(list).getByText("invalidation", { selector: "mark" }),
    ).toBeVisible();
    expect(within(list).getByRole("button")).toHaveTextContent("…");
  });
});

describe("ReviewDiscussionSummary", () => {
  it("separates code completion from discussion resolution", () => {
    const { container } = render(
      <ReviewDiscussionSummary
        pullRequest={pullRequest}
        threads={[
          discussion(),
          discussion({ externalId: "thread-2", status: "resolved" }),
        ]}
        onOpenThread={vi.fn()}
      />,
    );

    expect(screen.getByText("1 discussion remains open")).toBeVisible();
    expect(screen.getByText(/Code coverage is complete/)).toBeVisible();
    expect(screen.getByText("1 resolved discussion")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });
});

/** Mounts the browser with reusable provider callbacks for interaction tests. */
function renderPanel(
  threads: ProviderDiscussionThread[],
  overrides: { onClose?: () => void; onRefresh?: () => void } = {},
) {
  return render(
    <ReviewDiscussionsPanel
      loading={false}
      pullRequest={pullRequest}
      threads={threads}
      onClose={overrides.onClose ?? vi.fn()}
      onOpenThread={vi.fn()}
      onRefresh={overrides.onRefresh ?? vi.fn()}
    />,
  );
}
