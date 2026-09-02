// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOpenProviderDiscussion,
  orderProviderDiscussions,
  type ProviderDiscussionThread,
  ReviewDiscussionSummary,
  ReviewDiscussionsPanel,
} from "./review-discussions";

afterEach(cleanup);

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
        provider="github"
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
      screen.getByText("Should this retry delay be capped?"),
    ).toBeVisible();
    expect(
      screen.queryByText("The abort signal now covers this path."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Resolved 1" }));
    expect(
      screen.getByText("The abort signal now covers this path."),
    ).toBeVisible();
    expect(
      screen.queryByText("Should this retry delay be capped?"),
    ).not.toBeInTheDocument();
  });

  it("opens a selected conversation in its review unit", async () => {
    const onOpenThread = vi.fn();
    const thread = discussion();
    const user = userEvent.setup();
    render(
      <ReviewDiscussionsPanel
        loading={false}
        provider="github"
        threads={[thread]}
        onClose={vi.fn()}
        onOpenThread={onOpenThread}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(screen.getByText("Should this retry delay be capped?"));
    expect(onOpenThread).toHaveBeenCalledWith(thread);
  });
});

describe("ReviewDiscussionSummary", () => {
  it("separates code completion from discussion resolution", () => {
    const { container } = render(
      <ReviewDiscussionSummary
        provider="github"
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
