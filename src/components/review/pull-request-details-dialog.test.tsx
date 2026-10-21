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
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestDetailsDialog } from "./review-workspace-dialogs";

// Keep the real Markdown renderer while avoiding Next's async chunk loader.
vi.mock(
  "./review-workspace-markdown",
  async () => import("./provider-comment-body"),
);

afterEach(cleanup);

const pullRequest: ComponentProps<
  typeof PullRequestDetailsDialog
>["pullRequest"] = {
  id: "pr-12",
  number: 12,
  title: "Show the final combat log",
  description: "",
  state: "open",
  authorLogin: "Maya",
  sourceBranch: "fix/combat-log",
  targetBranch: "main",
  headSha: "abc1234",
  baseSha: "def5678",
  webUrl: "https://github.com/acme/review/pull/12",
  repositoryId: "repo-1",
  repositoryOwner: "acme",
  repositoryName: "review",
  repositoryWebUrl: "https://github.com/acme/review",
  provider: "github",
};

describe("PullRequestDetailsDialog", () => {
  it("previews Markdown and HTML table screenshots in the shared image viewer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PullRequestDetailsDialog
        pullRequest={{
          ...pullRequest,
          description: [
            "![Finished fight](https://github.com/user-attachments/assets/fight)",
            '<table><tr><td><img alt="History after reload" src="https://github.com/user-attachments/assets/history"></td></tr></table>',
          ].join("\n\n"),
        }}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("img", { name: "Finished fight" })).toHaveAttribute(
      "src",
      "https://github.com/user-attachments/assets/fight",
    );
    expect(
      within(screen.getByRole("table")).getByRole("img", {
        name: "History after reload",
      }),
    ).toHaveAttribute("referrerPolicy", "no-referrer");

    const preview = screen.getByRole("button", {
      name: "Enlarge image: History after reload",
    });
    await user.click(preview);
    const viewer = screen.getByRole("dialog", {
      name: "Image preview: History after reload",
    });
    expect(
      within(viewer).getByRole("button", { name: "Zoom in" }),
    ).toBeVisible();
    expect(
      within(viewer).getByRole("link", {
        name: "Open original image in a new tab",
      }),
    ).toHaveAttribute(
      "href",
      "https://github.com/user-attachments/assets/history",
    );

    // Escape must reach the native image modal without closing the description.
    fireEvent.keyDown(
      within(viewer).getByRole("button", {
        name: "Close image preview",
      }),
      { key: "Escape" },
    );
    fireEvent(
      viewer,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Image preview:/ })).toBeNull();
    expect(preview).toHaveFocus();

    await user.click(
      screen.getByRole("button", {
        name: "Enlarge image: Finished fight",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Close image preview" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires consent for external images and retains the failed-preview fallback", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PullRequestDetailsDialog
        pullRequest={{
          ...pullRequest,
          description: "![Screenshot](https://images.example/screenshot.png)",
        }}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load image" }));
    fireEvent.error(screen.getByRole("img", { name: "Screenshot" }));
    expect(screen.getByText("Screenshot · Preview unavailable")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open image" })).toHaveAttribute(
      "href",
      "https://images.example/screenshot.png",
    );
  });

  it("resolves provider-relative GitLab screenshots against the merge request", () => {
    render(
      <PullRequestDetailsDialog
        pullRequest={{
          ...pullRequest,
          provider: "gitlab",
          webUrl: "https://gitlab.example/team/review/-/merge_requests/12",
          description: "![Screenshot](/uploads/abc/screenshot.png)",
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute(
      "src",
      "https://gitlab.example/team/review/uploads/abc/screenshot.png",
    );
  });

  it("keeps the empty-description message and provider link", () => {
    render(
      <PullRequestDetailsDialog pullRequest={pullRequest} onClose={vi.fn()} />,
    );
    expect(
      screen.getByText(/This pull request has no description/),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", pullRequest.webUrl);
  });
});
