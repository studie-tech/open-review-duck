// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewFileEntries } from "~/lib/review-files";
import { ReviewFilesPanel } from "./review-files-panel";

afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollIntoView = undefined as never;
});

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

/** Stable no-op handler so a re-render hands the panel the same props. */
function noop() {}

describe("ReviewFilesPanel", () => {
  it("shows folder progress, revision attention, and zero-unit files", () => {
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("tree", { name: "Changed files" })).toBeVisible();
    expect(screen.getAllByText("1/2")).not.toHaveLength(0);
    expect(screen.queryByText("1/2 reviewed")).not.toBeInTheDocument();
    expect(screen.queryByText("No review units")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /Sign off 2 review units in src\/review\/workspace.ts/i,
      }),
    ).toBePartiallyChecked();
  });

  it("keeps added files on one line without an Added label", () => {
    render(
      <ReviewFilesPanel
        files={reviewFileEntries(
          [
            {
              id: "added-file",
              path: "src/review/constants.ts",
              previousPath: null,
              changeType: "added",
              additions: 4,
              deletions: 0,
              isBinary: false,
              skipReason: null,
            },
          ],
          [
            {
              id: "fresh",
              path: "src/review/constants.ts",
              status: "pending",
              revisionState: "new",
            },
          ],
        )}
        search=""
        selectedPath="src/review/constants.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("constants.ts")).toBeVisible();
    expect(screen.getAllByText("0/1").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^added$/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", {
        name: "src/review/constants.ts, 0 of 1 review units reviewed",
      }),
    ).toHaveClass("items-center", "py-1.5");
  });

  it("disables only the checkboxes of files whose save is in flight", () => {
    const saving = reviewFileEntries(
      [
        {
          id: "file-a",
          path: "src/a.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "file-b",
          path: "src/b.ts",
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
          id: "a-unit",
          path: "src/a.ts",
          status: "pending",
          revisionState: "unchanged",
        },
        {
          id: "b-unit",
          path: "src/b.ts",
          status: "pending",
          revisionState: "unchanged",
        },
      ],
    );
    render(
      <ReviewFilesPanel
        files={saving}
        search=""
        pendingFileIds={new Set(["file-a"])}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: /in src\/a\.ts/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /in src\/b\.ts/i }),
    ).toBeEnabled();
  });

  it("keeps opening a file separate from signing it off", async () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
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

  it("keeps the sign-off checkbox inside its control so focusing it cannot scroll the workspace", async () => {
    const user = userEvent.setup();
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /Sign off 2 review units in src\/review\/workspace.ts/i,
    });
    expect(checkbox.closest("label")).toHaveClass(
      "relative",
      "overflow-hidden",
    );

    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    checkbox.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    await user.click(checkbox);
    expect(checkbox).not.toHaveFocus();
  });

  it("filters the tree from a single All / New row", async () => {
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
        selectedPath="src/review/workspace.ts"
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
    const needsReview = screen.getByRole("button", { name: "New" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("done.ts")).toBeVisible();

    await user.click(needsReview);
    expect(needsReview).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("workspace.ts")).toBeVisible();
    expect(screen.queryByText("done.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("No review units")).not.toBeInTheDocument();
  });

  it("moves keyboard focus between visible tree rows with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const file = screen.getByRole("button", { name: /workspace\.ts/i });
    file.focus();
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByRole("button", { name: "Collapse review" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(file).toHaveFocus();
  });

  it("arrows from a file checkbox using the containing tree row", async () => {
    const user = userEvent.setup();
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    screen
      .getByRole("checkbox", {
        name: /Sign off 2 review units in src\/review\/workspace.ts/i,
      })
      .focus();
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByRole("button", { name: "Collapse review" }),
    ).toHaveFocus();
  });

  it("scrolls the selected file row into view when selectedPath changes", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="public/duck.png"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand review" }));
    const workspace = screen
      .getByRole("button", { name: /workspace\.ts/i })
      .closest("[data-review-file-path]");
    expect(workspace).toBeInstanceOf(HTMLElement);
    scrollIntoView.mockClear();

    rerender(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances).toContain(workspace);
  });

  it("expands collapsed ancestors so the selected file can scroll into view", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="public/duck.png"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /workspace\.ts/i }),
    ).not.toBeInTheDocument();
    scrollIntoView.mockClear();

    rerender(
      <ReviewFilesPanel
        files={files}
        search=""
        selectedPath="src/review/workspace.ts"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const workspace = screen
      .getByRole("button", { name: /workspace\.ts/i })
      .closest("[data-review-file-path]");
    expect(workspace).toBeVisible();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances).toContain(workspace);
  });

  it("opens only the top-level folders so a large tree stays cheap", () => {
    render(
      <ReviewFilesPanel
        files={files}
        search=""
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Collapse src" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse public" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand review" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /workspace\.ts/i }),
    ).not.toBeInTheDocument();
  });

  it("reveals a nested search match and re-collapses when the query clears", () => {
    const { rerender } = render(
      <ReviewFilesPanel
        files={files}
        search=""
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /workspace\.ts/i }),
    ).not.toBeInTheDocument();

    rerender(
      <ReviewFilesPanel
        files={files}
        search="workspace"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /workspace\.ts/i }),
    ).toBeVisible();

    rerender(
      <ReviewFilesPanel
        files={files}
        search=""
        onSelect={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /workspace\.ts/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps its rows mounted when the view around it renders", async () => {
    const user = userEvent.setup();
    let progressReads = 0;
    const countedFiles = files.map((file) => ({
      ...file,
      /** Counts each read a mounted file row makes of its progress. */
      get reviewedUnits() {
        progressReads += 1;
        return 1;
      },
    }));
    /** Stands in for the workspace state that changes above the panel. */
    function Workspace() {
      const [renders, setRenders] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setRenders(renders + 1)}>
            Render {renders}
          </button>
          <ReviewFilesPanel
            files={countedFiles}
            search=""
            selectedPath="src/review/workspace.ts"
            onSelect={noop}
            onToggle={noop}
          />
        </>
      );
    }
    render(<Workspace />);
    expect(progressReads).toBeGreaterThan(0);
    const mounted = progressReads;

    await user.click(screen.getByRole("button", { name: "Render 0" }));

    expect(screen.getByRole("button", { name: "Render 1" })).toBeVisible();
    expect(progressReads).toBe(mounted);
  });
});
