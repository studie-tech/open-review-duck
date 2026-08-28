// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewFileEntries } from "~/lib/review-files";
import { ReviewFilesPanel } from "./review-files-panel";

afterEach(cleanup);

const files = reviewFileEntries(
  [
    {
      id: "changed-file",
      path: "src/review/workspace.ts",
      previousPath: null,
      changeType: "modified",
      additions: 9,
      deletions: 2,
      isBinary: false,
      skipReason: null,
    },
    {
      id: "binary-file",
      path: "public/duck.png",
      previousPath: null,
      changeType: "modified",
      additions: 0,
      deletions: 0,
      isBinary: true,
      skipReason: null,
    },
  ],
  [
    {
      id: "reviewed",
      path: "src/review/workspace.ts",
      status: "signed_off",
      revisionState: "unchanged",
    },
    {
      id: "updated",
      path: "src/review/workspace.ts",
      status: "changed",
      revisionState: "updated",
    },
  ],
);

describe("ReviewFilesPanel", () => {
  it("shows folder progress, revision attention, and zero-unit files", () => {
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("tree", { name: "Changed files" })).toBeVisible();
    expect(screen.getByText("1/2 reviewed")).toBeVisible();
    expect(screen.getByText("1 updated")).toBeVisible();
    expect(screen.getByText("No review units")).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: /Sign off 2 review units in src\/review\/workspace.ts/i,
      }),
    ).toBePartiallyChecked();
  });

  it("keeps opening a file separate from signing it off", async () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    await user.click(screen.getByRole("button", { name: /workspace\.ts/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "changed-file" }),
    );
    expect(onToggle).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("checkbox", {
        name: /Sign off 2 review units in src\/review\/workspace.ts/i,
      }),
    );
    expect(onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "changed-file" }),
    );
  });

  it("filters the tree from a single All / Needs review row", async () => {
    const user = userEvent.setup();
    const signedOff = reviewFileEntries(
      [
        ...files.map((file) => ({
          id: file.id,
          path: file.path,
          previousPath: file.previousPath,
          changeType: file.changeType,
          additions: file.additions,
          deletions: file.deletions,
          isBinary: file.isBinary,
          skipReason: file.skipReason,
        })),
        {
          id: "done-file",
          path: "src/done.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
      ],
      [
        {
          id: "reviewed",
          path: "src/review/workspace.ts",
          status: "signed_off",
          revisionState: "unchanged",
        },
        {
          id: "updated",
          path: "src/review/workspace.ts",
          status: "changed",
          revisionState: "updated",
        },
        {
          id: "done",
          path: "src/done.ts",
          status: "signed_off",
          revisionState: "unchanged",
        },
      ],
    );
    render(
      <ReviewFilesPanel
        files={signedOff}
        search=""
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: "Filter files" });
    expect(group).toHaveClass("flex", "w-full");
    expect(group).not.toHaveClass("flex-col");
    expect(group.querySelectorAll("button.flex-1")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "New & updated" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reviewed" }),
    ).not.toBeInTheDocument();

    const all = screen.getByRole("button", { name: "All" });
    const needsReview = screen.getByRole("button", { name: "Needs review" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("done.ts")).toBeVisible();

    await user.click(needsReview);
    expect(needsReview).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("workspace.ts")).toBeVisible();
    expect(screen.queryByText("done.ts")).not.toBeInTheDocument();
  });
});
