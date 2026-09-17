// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultMarkdownPreviewVersion,
  ReviewMarkdownPreview,
  ReviewMarkdownViewSwitch,
} from "./review-markdown-preview";

afterEach(cleanup);

describe("defaultMarkdownPreviewVersion", () => {
  it("compares when both revisions have prose", () => {
    expect(
      defaultMarkdownPreviewVersion({
        currentSource: "# Now",
        previousSource: "# Then",
      }),
    ).toBe("compare");
  });

  it("opens a deleted document on the previous revision", () => {
    expect(
      defaultMarkdownPreviewVersion({
        currentSource: "",
        previousSource: "# Then",
      }),
    ).toBe("previous");
  });

  it("opens an added document on the current revision", () => {
    expect(
      defaultMarkdownPreviewVersion({
        currentSource: "# Now",
        previousSource: "",
      }),
    ).toBe("current");
  });
});

describe("ReviewMarkdownViewSwitch", () => {
  it("names both presentations and reports the selected one", async () => {
    const onChange = vi.fn();
    render(<ReviewMarkdownViewSwitch view="preview" onChange={onChange} />);

    expect(
      screen.getByRole("button", { name: "Preview view" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Raw view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Raw view" }));
    expect(onChange).toHaveBeenCalledWith("raw");
  });
});

describe("ReviewMarkdownPreview", () => {
  it("renders a compare of both Markdown revisions", async () => {
    render(
      <ReviewMarkdownPreview
        path="docs/guide.md"
        previousSource={["# Setup", "", "Install the old CLI."].join("\n")}
        currentSource={["# Setup", "", "Install **ReviewDuck**."].join("\n")}
      />,
    );

    expect(screen.getByText("guide.md")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Compare Markdown" }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Setup" })).toHaveLength(2);
    });
    expect(screen.getByText("ReviewDuck")).toBeVisible();
    expect(screen.getByText("Install the old CLI.")).toBeVisible();
  });

  it("lets the reviewer read only the current document", async () => {
    render(
      <ReviewMarkdownPreview
        path="README.md"
        previousSource="# Old title"
        currentSource={["# New title", "", "Welcome."].join("\n")}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Current Markdown" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New title" })).toBeVisible();
    });
    expect(
      screen.queryByRole("heading", { name: "Old title" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Welcome.")).toBeVisible();
  });

  it("resets the revision choice when the file path changes", async () => {
    const { rerender } = render(
      <ReviewMarkdownPreview
        path="README.md"
        previousSource="# Old"
        currentSource="# New"
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Current Markdown" }),
    );
    expect(
      screen.getByRole("button", { name: "Current Markdown" }),
    ).toHaveAttribute("aria-pressed", "true");

    rerender(
      <ReviewMarkdownPreview
        path="docs/guide.md"
        previousSource="# Then"
        currentSource="# Now"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Compare Markdown" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("explains an empty current document", () => {
    render(
      <ReviewMarkdownPreview
        path="NOTES.md"
        currentSource=""
        previousSource=""
      />,
    );

    expect(
      screen.getByText("This Markdown file is empty in the pull request."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Compare Markdown" }),
    ).not.toBeInTheDocument();
  });
});
