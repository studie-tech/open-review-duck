// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SideBySideUnitDiff } from "./review-workspace-diff";
import { useInlineAiQuestionController } from "./use-inline-ai-question-controller";
import {
  defaultMarkdownPreviewVersion,
  ReviewMarkdownPreview,
  ReviewMarkdownViewSwitch,
} from "./review-markdown-preview";
import {
  InlineAiQuestion,
  InlineLineActionSurface,
} from "./review-workspace-ai-conversation";

const previewDomApis = [
  { target: HTMLElement.prototype, key: "scrollIntoView" },
  { target: HTMLDialogElement.prototype, key: "showModal" },
  { target: window, key: "matchMedia" },
].map((api) => ({
  ...api,
  descriptor: Object.getOwnPropertyDescriptor(api.target, api.key),
}));

afterEach(() => {
  cleanup();
  for (const { target, key, descriptor } of previewDomApis) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

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
  it("opens a movable AI composer in Raw from the Markdown line chooser", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    /** Exercises the real chooser, diff anchors and AI movement controller. */
    function PreviewWithComposers() {
      const [selectedLine, setSelectedLine] = useState<number>();
      const [preview, setPreview] = useState(true);
      const codeScrollRef = useRef<HTMLDivElement>(null);
      const ai = useInlineAiQuestionController({
        activeUnit: { id: "markdown-unit", startLine: 1, endLine: 3 } as never,
        codeScrollRef,
        isReviewLine: (line) => line >= 1 && line <= 3,
        liveQuestions: [],
        primaryStart: 1,
        primaryEnd: 3,
        pullRequestId: "markdown-pr",
      });
      const source = "# Guide\n\nReview this paragraph.";
      /** Renders the same shared composers in both document presentations. */
      function renderLineDetails(line: number) {
        return selectedLine === line ? (
          <InlineLineActionSurface
            canAsk
            initialDraft=""
            line={line}
            path="guide.md"
            pending={false}
            posting={false}
            provider="github"
            onAskAi={() => {
              setPreview(false);
              setSelectedLine(undefined);
              ai.openAt(line);
            }}
            onCancel={() => setSelectedLine(undefined)}
            onDraftChange={vi.fn()}
            onPost={vi.fn()}
          />
        ) : ai.line === line ? (
          <InlineAiQuestion
            canAsk
            entries={[]}
            initialDraft=""
            line={line}
            minimumLine={1}
            maximumLine={3}
            onAsk={() => true}
            onClose={() => ai.setLine(undefined)}
            onDraftChange={vi.fn()}
            onMove={ai.move}
            onPreview={ai.setPreviewLine}
            onStep={ai.step}
          />
        ) : null;
      }
      return (
        <div ref={codeScrollRef}>
          {preview ? (
            <ReviewMarkdownPreview
              path="guide.md"
              currentSource={source}
              lineActions={{
                canCommentLine: () => true,
                onCommentLine: setSelectedLine,
                selectedLine,
                renderLineDetails,
              }}
            />
          ) : (
            <SideBySideUnitDiff
              previousSource=""
              currentSource={source}
              language="markdown"
              previousStartLine={1}
              currentStartLine={1}
              onSelectReviewLine={setSelectedLine}
              renderLineDetails={renderLineDetails}
            />
          )}
        </div>
      );
    }
    render(<PreviewWithComposers />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown lines 3–3",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown line 3",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Ask AI/ }));
    expect(
      screen.getByRole("textbox", { name: "Ask AI about line 3" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Added code diff" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Move AI question one line up" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Ask AI about line 2" }),
    ).toBeVisible();
  });

  it.each([
    "#### Heading",
    "##### Heading",
    "###### Heading",
    "---",
    "<details><summary>Summary</summary>Body</details>",
  ])("offers a source-line comment for %s", async (currentSource) => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    });
    const onCommentLine = vi.fn();
    render(
      <ReviewMarkdownPreview
        path="guide.md"
        currentSource={currentSource}
        lineActions={{ canCommentLine: () => true, onCommentLine }}
      />,
    );
    const action = screen.getAllByRole("button", {
      name: "Comment on current Markdown lines 1–1",
    })[0];
    if (!action) throw new Error("Expected a Markdown source action");
    await userEvent.click(action);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown line 1",
      }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(1, "current");
  });

  it("comments on an exact line in a rendered multiline paragraph", async () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModal,
    });
    const onCommentLine = vi.fn();
    const { rerender } = render(
      <ReviewMarkdownPreview
        path="README.md"
        currentSource={"# Guide\n\nFirst source line\nsecond source line."}
        lineActions={{
          currentStartLine: 20,
          canCommentLine: (line, side) => side === "current" && line >= 22,
          onCommentLine,
        }}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Comment on current Markdown lines 20–20",
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown lines 22–23",
      }),
    );
    expect(showModal).toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "Comment on current Markdown source",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown line 23",
      }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(23, "current");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(
      <ReviewMarkdownPreview
        path="README.md"
        currentSource="# Guide"
        lineActions={{
          canCommentLine: () => true,
          onCommentLine,
          selectedLine: 23,
          renderLineDetails: (line) => <div>Composer on line {line}</div>,
        }}
      />,
    );
    expect(screen.getByText("Composer on line 23")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Guide" })).toBeVisible();
  });

  it("keeps previous and current comment anchors separate in compares", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    });
    const onCommentLine = vi.fn();
    render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource={"# Before\n\nRemoved text."}
        currentSource={"# After\n\nAdded text."}
        lineActions={{ canCommentLine: (line) => line === 3, onCommentLine }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on previous Markdown lines 3–3",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on previous Markdown line 3",
      }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(3, "previous");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown lines 3–3",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown line 3",
      }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(3, "current");
  });

  it("offers exact code fence lines without trusting author-supplied line attributes", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    });
    const onCommentLine = vi.fn();
    render(
      <ReviewMarkdownPreview
        path="guide.md"
        currentSource={
          '<p data-markdown-start-line="999">Text</p>\n\n```sh\nrun first\nrun second\n```'
        }
        lineActions={{ canCommentLine: () => true, onCommentLine }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /999/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown lines 3–6",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Comment on current Markdown line 5",
      }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(5, "current");
  });

  it("renders a compare of both Markdown revisions", async () => {
    render(
      <ReviewMarkdownPreview
        path="docs/guide.md"
        previousSource={["# Setup", "", "Install the old CLI."].join("\n")}
        currentSource={["# Setup", "", "Install **ReviewDuck**."].join("\n")}
      />,
    );

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

describe("rendered Markdown changes", () => {
  it("marks changed list items without tinting unchanged siblings or headings", () => {
    const { container } = render(
      <ReviewMarkdownPreview
        path="AGENTS.md"
        previousSource={
          "# Instructions\n\n- Keep this rule.\n- Run `make test`.\n- Keep this too."
        }
        currentSource={
          "# Instructions\n\n- Keep this rule.\n- Run `make check`.\n- Keep this too."
        }
      />,
    );
    const blocks = container.querySelectorAll("[data-markdown-change]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveAttribute("data-markdown-change", "previous");
    expect(blocks[0]).toHaveTextContent("make test");
    expect(blocks[1]).toHaveAttribute("data-markdown-change", "current");
    expect(blocks[1]).toHaveTextContent("make check");
    expect(blocks[1]).not.toHaveTextContent("Keep this");
  });

  it("marks multiline paragraphs, code fences, table rows and nested lists", () => {
    const previousSource =
      "# Guide\n\nFirst line\nold ending.\n\n- Parent\n  - Old child\n  - Stable child\n\n```sh\nold command\n```\n\n| Name | Value |\n| --- | --- |\n| stable | old |";
    const currentSource = previousSource
      .replace("old ending", "new ending")
      .replace("Old child", "New child")
      .replace("old command", "new command")
      .replace("stable | old", "stable | new");
    const { container } = render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource={previousSource}
        currentSource={currentSource}
      />,
    );
    expect(
      container.querySelectorAll('[data-markdown-change="current"]'),
    ).toHaveLength(4);
    expect(
      container.querySelector('p[data-markdown-change="current"]'),
    ).toHaveTextContent("new ending");
    expect(
      container.querySelector('li[data-markdown-change="current"]'),
    ).toHaveTextContent("New child");
    expect(
      container.querySelector('li[data-markdown-change="current"]'),
    ).not.toHaveTextContent("Stable child");
    expect(
      container.querySelector('pre[data-markdown-change="current"]'),
    ).toHaveTextContent("new command");
    expect(
      container.querySelector('tr[data-markdown-change="current"]'),
    ).toHaveTextContent("new");
  });

  it("jumps to the first marked block in the selected revision", async () => {
    const { container } = render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource="# Before"
        currentSource="# After"
      />,
    );
    const scroll = vi.fn();
    const first = container.querySelector("[data-markdown-change]");
    Object.defineProperty(first, "scrollIntoView", { value: scroll });
    await userEvent.click(
      screen.getByRole("button", { name: "Jump to changes" }),
    );
    expect(scroll).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Current Markdown" }),
    );
    expect(
      container.querySelector('[data-markdown-change="previous"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-markdown-change="current"]'),
    ).toHaveTextContent("After");
  });

  it("does not accept diff attributes or unsafe HTML from document authors", () => {
    const source =
      '<p data-markdown-change="current" onclick="alert(1)">Unchanged</p>\n\n<script>alert(1)</script>';
    const { container } = render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource={source}
        currentSource={source}
      />,
    );
    expect(container.querySelector("[data-markdown-change]")).toBeNull();
    expect(container.querySelector("[onclick], script")).toBeNull();
  });

  it("highlights an added or deleted document on its available revision", () => {
    const { container, rerender } = render(
      <ReviewMarkdownPreview path="added.md" currentSource="# Added" />,
    );
    expect(
      container.querySelector('[data-markdown-change="current"]'),
    ).toHaveTextContent("Added");
    rerender(
      <ReviewMarkdownPreview
        path="deleted.md"
        currentSource=""
        previousSource="# Deleted"
      />,
    );
    expect(
      container.querySelector('[data-markdown-change="previous"]'),
    ).toHaveTextContent("Deleted");
  });
});

describe("Markdown jump target availability", () => {
  it.each([
    ["HTML comments", "# Guide\n\n<!-- old -->", "# Guide\n\n<!-- new -->"],
    [
      "link definitions",
      "# Guide\n\n[site]: https://old.example",
      "# Guide\n\n[site]: https://new.example",
    ],
  ])(
    "hides the change toolbar for edits confined to %s",
    (_label, previousSource, currentSource) => {
      const { container } = render(
        <ReviewMarkdownPreview
          path="guide.md"
          previousSource={previousSource}
          currentSource={currentSource}
        />,
      );
      expect(container.querySelector("[data-markdown-change]")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Jump to changes" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/removed lines?/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/Use Raw for exact source changes/),
      ).toBeVisible();
    },
  );

  it("removes the toolbar when switching to a revision without visible changes", async () => {
    render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource={"# Guide\n\nRemoved paragraph."}
        currentSource="# Guide"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Jump to changes" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Current Markdown" }),
    );
    expect(
      screen.queryByRole("button", { name: "Jump to changes" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Previous Markdown" }),
    );
    expect(
      screen.getByRole("button", { name: "Jump to changes" }),
    ).toBeVisible();
  });

  it("clears a stale target when source updates without a path change", () => {
    const { rerender } = render(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource="# Before"
        currentSource="# After"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Jump to changes" }),
    ).toBeVisible();
    rerender(
      <ReviewMarkdownPreview
        path="guide.md"
        previousSource={"# Same\n\n<!-- old -->"}
        currentSource={"# Same\n\n<!-- new -->"}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Jump to changes" }),
    ).not.toBeInTheDocument();
  });
});
