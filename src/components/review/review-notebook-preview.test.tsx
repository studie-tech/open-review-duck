// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewNotebook } from "~/lib/review-notebook";
import { isReviewPreviewFile } from "~/lib/review-source-display";
import { ReviewNotebookPreview } from "./review-notebook-preview";

afterEach(cleanup);

/** Builds a saved notebook containing prose and a code cell with outputs. */
function notebook(title = "Balance framework", outputs: unknown[] = []) {
  return JSON.stringify({
    nbformat: 4,
    cells: [
      {
        id: "intro",
        cell_type: "markdown",
        source: [`# ${title}\n`, "A **readable** notebook."],
        metadata: {},
      },
      {
        id: "code",
        cell_type: "code",
        source: "print(2 + 2)",
        execution_count: 3,
        outputs,
        metadata: {},
      },
    ],
  });
}

describe("notebook preview", () => {
  it("recognizes notebooks even when analysis calls them JSON", () => {
    expect(
      isReviewPreviewFile({ path: "analysis.IPYNB", language: "json" }),
    ).toBe(true);
    expect(
      isReviewPreviewFile({ path: "analysis.json", language: "json" }),
    ).toBe(false);
  });

  it("rejects malformed JSON, invalid cells, and unsupported notebook versions", () => {
    for (const source of [
      "{",
      "null",
      '{"nbformat":3,"cells":[]}',
      '{"nbformat":4,"cells":[{"cell_type":"code","source":42}]}',
    ]) {
      expect(parseReviewNotebook(source)).toBeNull();
    }
    render(<ReviewNotebookPreview path="invalid.ipynb" currentSource="{" />);
    expect(screen.getByRole("status")).toHaveTextContent("Use Raw");
  });

  it("renders prose, code, execution counts, streams, errors, and images", () => {
    render(
      <ReviewNotebookPreview
        path="balance.ipynb"
        currentSource={notebook(undefined, [
          { output_type: "stream", text: ["4\n", "done"] },
          {
            output_type: "error",
            traceback: ["\u001b[31mValueError: broken\u001b[0m"],
          },
          { output_type: "display_data", data: { "image/png": "aGVsbG8=" } },
        ])}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Balance framework" }),
    ).toBeVisible();
    expect(screen.getByText("readable").tagName).toBe("STRONG");
    expect(screen.getByText("print(2 + 2)")).toBeVisible();
    expect(screen.getByText(/In \[3\]/)).toBeVisible();
    expect(screen.getByText(/4\s+done/)).toBeVisible();
    expect(screen.getByText("ValueError: broken")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("sanitizes HTML outputs and falls back to text for active MIME formats", () => {
    const { container } = render(
      <ReviewNotebookPreview
        path="safe.ipynb"
        currentSource={notebook(undefined, [
          {
            output_type: "display_data",
            data: {
              "text/html":
                '<table><tr><td>Result</td></tr></table><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror="alert(1)"><a href="javascript:alert(1)">Bad link</a>',
            },
          },
          {
            output_type: "display_data",
            data: {
              "application/javascript": "alert(1)",
              "image/svg+xml": "<svg onload='alert(1)'/>",
              "text/plain": "Safe fallback",
            },
          },
        ])}
      />,
    );
    expect(screen.getByRole("cell", { name: "Result" })).toBeVisible();
    expect(screen.getByText("Safe fallback")).toBeVisible();
    expect(
      container.querySelector(
        "script, iframe, svg, [onerror], [onload], a[href^='javascript:']",
      ),
    ).toBeNull();
  });

  it("compares revisions and switches to a single revision", async () => {
    render(
      <ReviewNotebookPreview
        path="balance.ipynb"
        previousSource={notebook("Old balance")}
        currentSource={notebook("New balance")}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Compare notebook" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Changed cell")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: "Current notebook" }),
    );
    expect(screen.queryByRole("heading", { name: "Old balance" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New balance" })).toBeVisible();
  });

  it("ignores newly introduced cell IDs while still detecting output changes", () => {
    const previous = JSON.parse(notebook());
    for (const cell of previous.cells) delete cell.id;
    const { rerender } = render(
      <ReviewNotebookPreview
        path="upgraded.ipynb"
        previousSource={JSON.stringify(previous)}
        currentSource={notebook()}
      />,
    );
    expect(screen.queryByText("Changed cell")).toBeNull();
    const current = JSON.parse(notebook());
    current.cells[1].outputs = [{ output_type: "stream", text: "New output" }];
    rerender(
      <ReviewNotebookPreview
        path="upgraded.ipynb"
        previousSource={JSON.stringify(previous)}
        currentSource={JSON.stringify(current)}
      />,
    );
    expect(screen.getAllByText("Changed cell")).toHaveLength(2);
  });

  it("does not pair a new cell with a different cell ID at the same index", () => {
    const current = JSON.parse(notebook());
    current.cells.unshift({ ...current.cells[0], id: "inserted" });
    render(
      <ReviewNotebookPreview
        path="inserted.ipynb"
        previousSource={notebook()}
        currentSource={JSON.stringify(current)}
      />,
    );
    expect(screen.getAllByText("Changed cell")).toHaveLength(1);
  });

  it("opens deleted notebooks on the previous revision and handles empty cells", () => {
    const { rerender } = render(
      <ReviewNotebookPreview
        path="deleted.ipynb"
        currentSource=""
        previousSource={notebook()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Previous notebook" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "Current notebook" }),
    ).toBeNull();
    rerender(
      <ReviewNotebookPreview
        path="empty.ipynb"
        currentSource='{"nbformat":4,"cells":[]}'
      />,
    );
    expect(screen.getByText("This notebook has no cells.")).toBeVisible();
  });
});
