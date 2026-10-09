// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import {
  MergedReviewFooter,
  MergedReviewNotice,
  reviewIsMerged,
} from "./merged-review-notice";
import { useStagedReviewWorkspace } from "./use-staged-review-workspace";

afterEach(cleanup);

describe("merged review state", () => {
  it.each(["open", "draft", "closed"])(
    "does not treat %s as merged",
    (state) => {
      expect(reviewIsMerged(state)).toBe(false);
      expect(reviewIsMerged(state, state)).toBe(false);
    },
  );

  it("recognizes a saved merge before a personal review is complete", () => {
    expect(reviewIsMerged("merged")).toBe(true);
    expect(reviewIsMerged("merged", "open")).toBe(true);
  });

  it("recognizes a live merge before workspace metadata refreshes", () => {
    expect(reviewIsMerged("open", "merged")).toBe(true);
  });

  it("shows incoming merge metadata without accepting staged source", () => {
    type Workspace = RouterOutputs["review"]["workspace"];
    const first = {
      snapshot: { id: "one" },
      pullRequest: { state: "open" },
    } as Workspace;
    const { result, rerender } = renderHook(
      ({ incoming }) => {
        const staged = useStagedReviewWorkspace(incoming);
        return {
          ...staged,
          merged: reviewIsMerged(incoming.pullRequest.state),
        };
      },
      { initialProps: { incoming: first } },
    );
    rerender({
      incoming: {
        snapshot: { id: "two" },
        pullRequest: { state: "merged" },
      } as Workspace,
    });
    expect(result.current.displayed).toBe(first);
    expect(result.current.available).toBe(true);
    expect(result.current.merged).toBe(true);
  });

  it("announces the target branch and distinguishes the saved snapshot from personal review", () => {
    render(<MergedReviewNotice targetBranch="release/customer-long-branch" />);
    expect(
      screen.getByRole("status", { name: "Merged pull request" }),
    ).toHaveTextContent("release/customer-long-branch");
    expect(screen.getByRole("heading")).toHaveTextContent(
      "This pull request has been merged",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Personal review progress is kept separately.",
    );
  });

  it("exits merged PRs without implying an unfinished review was completed", () => {
    const onBack = vi.fn();
    render(
      <MergedReviewFooter
        signedCount={0}
        totalCount={3}
        navigationPending={false}
        onBack={onBack}
      />,
    );
    expect(
      screen.getByText("Personal review: 0/3 units signed off"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /sign off/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to pull requests" }),
    );
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("prevents repeated exits during navigation", () => {
    const onBack = vi.fn();
    render(
      <MergedReviewFooter
        signedCount={3}
        totalCount={3}
        navigationPending
        onBack={onBack}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Back to pull requests",
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onBack).not.toHaveBeenCalled();
  });
});
