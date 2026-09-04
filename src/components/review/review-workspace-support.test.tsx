// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { sortByReviewFileTreeOrder } from "~/lib/review-files";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { HEAVY_DATA_SOURCE_BYTES } from "~/lib/review-source-display";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import type { RouterOutputs } from "~/trpc/react";
import {
  AI_QUICK_QUESTIONS,
  aiConversationVisibility,
  InlineAiQuestion,
  InlineCommentComposer,
  rememberAiConversationVisibility,
  withoutDeletedAiQuestions,
  withoutDeletedLiveAiQuestions,
} from "./review-workspace-ai-conversation";
import {
  ConceptMoveDialog,
  PullRequestDetailsDialog,
} from "./review-workspace-dialogs";
import {
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
} from "./review-workspace-diff";
import {
  CopyRepositoryUrlButton,
  ProviderConversation,
  type ProviderConversationActions,
  reviewProviderWebUrl,
} from "./review-workspace-provider-conversation";
import {
  conceptFileCardsInReadingOrder,
  conceptMembersInReadingOrder,
  nextAnchorableLine,
  REVISION_NOTICE_DISMISS_MS,
  ReviewCodeViewSwitch,
  ReviewConceptFileCardPreview,
  ReviewFileCardSourcePlaceholder,
  ReviewRevisionLoadedNotice,
  ReviewUnitViewOptions,
  reviewCardMemberForLine,
  SplitActionButton,
} from "./review-workspace-source";

vi.mock("~/lib/syntax-highlighting", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/syntax-highlighting")>();
  return {
    ...actual,
    // Counting the calls is the only way to see that a collapsed card never
    // asks for highlighting; the lines it returns still carry the real text so
    // every other assertion in this file reads the same source it did before.
    useHighlightedSource: vi.fn((source: string) =>
      source
        .split("\n")
        .map((text) => ({ text, tokens: [{ text, className: "" }] })),
    ),
  };
});

type WorkspacePullRequest = RouterOutputs["review"]["workspace"]["pullRequest"];
type WorkspaceConcept =
  RouterOutputs["review"]["workspace"]["concepts"][number];

let viewportIsWide = true;
const viewportListeners = new Set<() => void>();

// jsdom answers no media queries, so the diff's breakpoint store reads this
// stub and a case can move the viewport across Tailwind's `sm` edge.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    get matches() {
      return viewportIsWide;
    },
    media,
    onchange: null,
    addEventListener: (_event: string, listener: () => void) =>
      viewportListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) =>
      viewportListeners.delete(listener),
    dispatchEvent: () => true,
  }),
});

/** Moves the emulated viewport across the side-by-side breakpoint. */
function setViewportWide(wide: boolean) {
  viewportIsWide = wide;
  for (const listener of viewportListeners) listener();
}

afterEach(() => {
  cleanup();
  viewportIsWide = true;
});

describe("review shortcuts", () => {
  it("provides editor-style sidebar shortcuts", () => {
    expect(reviewShortcuts.togglePathPanel).toEqual([{ key: "b", mod: true }]);
    expect(reviewShortcuts.toggleInsightsPanel).toEqual([
      { key: "g", mod: true },
    ]);
    expect(reviewShortcuts.search).toEqual([{ key: "f" }]);
    expect(reviewShortcuts.nextReview).toEqual([{ key: "n", shift: true }]);
    expect(reviewShortcuts.signOffDeletions).toEqual([
      { key: "d", shift: true },
    ]);
    expect(reviewShortcuts.undoReview).toEqual([{ key: "u" }]);
    expect(reviewShortcuts.nextUnit).toEqual([{ key: "ArrowDown", mod: true }]);
    expect(reviewShortcuts.previousUnit).toEqual([
      { key: "ArrowUp", mod: true },
    ]);
    expect(reviewShortcuts.nextConcept).toEqual([{ key: "ArrowRight" }]);
    expect(reviewShortcuts.previousConcept).toEqual([{ key: "ArrowLeft" }]);
    expect(JSON.stringify(reviewShortcuts)).not.toMatch(/"[jk]"/);
  });

  it("puts the concept variant of an action behind shift", () => {
    // Not the command key: the browser keeps it for closing the tab and never
    // hands the chord to the page, so a concept chord built on it would shut
    // the review down instead of recording it.
    expect(reviewShortcuts.signOffConcept).toEqual([{ key: "s", shift: true }]);
    expect(JSON.stringify(reviewShortcuts)).not.toMatch(/"[sw]","mod"/);
  });

  it("steps through review findings on the bracket keys", () => {
    expect(reviewShortcuts.nextFinding).toEqual([{ key: "]" }]);
    expect(reviewShortcuts.previousFinding).toEqual([{ key: "[" }]);
  });
});

describe("ReviewCodeViewSwitch", () => {
  it("names both representations and reports the selected one", async () => {
    const onChange = vi.fn();
    render(<ReviewCodeViewSwitch diffVisible onChange={onChange} />);

    expect(screen.getByRole("button", { name: "Focus view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Diff view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "Focus view" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("ReviewRevisionLoadedNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down on the button and dismisses after ten seconds", () => {
    vi.useFakeTimers();
    const onAcknowledge = vi.fn();
    render(
      <ReviewRevisionLoadedNotice onAcknowledge={onAcknowledge}>
        GitHub moved from 5591601 to 83e2e65.
      </ReviewRevisionLoadedNotice>,
    );

    expect(
      screen.getByRole("button", { name: "Got it, dismissing in 10 seconds" }),
    ).toHaveTextContent("Got it · 10s");

    act(() => {
      vi.advanceTimersByTime(REVISION_NOTICE_DISMISS_MS - 1);
    });
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Got it, dismissing in 1 second" }),
    ).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onAcknowledge).toHaveBeenCalledOnce();
  });

  it("dismisses immediately when the reviewer acknowledges", async () => {
    const onAcknowledge = vi.fn();
    render(
      <ReviewRevisionLoadedNotice onAcknowledge={onAcknowledge}>
        No reviewed units were reopened.
      </ReviewRevisionLoadedNotice>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Got it, dismissing in/ }),
    );
    expect(onAcknowledge).toHaveBeenCalledOnce();
  });
});

describe("ReviewUnitViewOptions", () => {
  it("keeps both unit context options off until explicitly enabled", async () => {
    const onToggleImports = vi.fn();
    const onToggleFullFile = vi.fn();
    render(
      <ReviewUnitViewOptions
        importsVisible={false}
        fullFileVisible={false}
        onToggleImports={onToggleImports}
        onToggleFullFile={onToggleFullFile}
      />,
    );

    const imports = screen.getByRole("button", {
      name: "Show imports for this unit",
    });
    const fullFile = screen.getByRole("button", {
      name: "Show the full file for this unit",
    });
    expect(imports).toHaveAttribute("aria-pressed", "false");
    expect(fullFile).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(imports);
    await userEvent.click(fullFile);
    expect(onToggleImports).toHaveBeenCalledOnce();
    expect(onToggleFullFile).toHaveBeenCalledOnce();
  });
});

describe("same-file concept cards", () => {
  const units = [
    {
      id: "configuration",
      path: "src/preview.ts",
      name: "configuration",
      changedLineCount: 1,
      changeType: "added",
      previousSource: null,
      source: "const configuration = true;",
      startLine: 2,
      endLine: 2,
      language: "typescript",
      kind: "constant",
      status: "pending",
    },
    {
      id: "other-file",
      path: "src/other.ts",
      name: "other",
      changedLineCount: 1,
      changeType: "added",
      previousSource: null,
      source: "export const other = true;",
      startLine: 1,
      endLine: 1,
      language: "typescript",
      kind: "constant",
      status: "pending",
    },
    {
      id: "main",
      path: "src/preview.ts",
      name: "main",
      changedLineCount: 1,
      changeType: "added",
      previousSource: null,
      source: "const main = true;",
      startLine: 5,
      endLine: 5,
      language: "typescript",
      kind: "constant",
      status: "pending",
    },
  ] as const;

  it("keeps one card per file without disturbing first-seen reading order", () => {
    const cards = conceptFileCardsInReadingOrder(units);

    expect(cards.map(({ path }) => path)).toEqual([
      "src/preview.ts",
      "src/other.ts",
    ]);
    expect(cards[0]?.members.map(({ id }) => id)).toEqual([
      "configuration",
      "main",
    ]);
  });

  it("can reorder concept cards to match the Files sidebar", () => {
    const cards = conceptFileCardsInReadingOrder([
      {
        path: "app/src/server/api/validators/user.ts",
        id: "schema",
      },
      {
        path: "app/src/server/api/routers/profile.ts",
        id: "router",
      },
    ]);

    expect(cards.map(({ path }) => path)).toEqual([
      "app/src/server/api/validators/user.ts",
      "app/src/server/api/routers/profile.ts",
    ]);
    expect(sortByReviewFileTreeOrder(cards).map(({ path }) => path)).toEqual([
      "app/src/server/api/routers/profile.ts",
      "app/src/server/api/validators/user.ts",
    ]);
  });

  it("leaves the gap between two atomic members unowned", () => {
    const sameFile = [units[0], units[2]] as never;

    expect(reviewCardMemberForLine(sameFile, 3)).toBeUndefined();
    expect(reviewCardMemberForLine(sameFile, 5)?.id).toBe("main");
  });

  it("renders one card, dims intervening context, and routes comments to its owner", async () => {
    const onCommentLine = vi.fn();
    render(
      <ReviewConceptFileCardPreview
        members={[units[0], units[2]] as never}
        index={0}
        count={2}
        fileSource={[
          "// setup",
          "const configuration = true;",
          "const contextA = true;",
          "const contextB = true;",
          "const main = true;",
        ].join("\n")}
        onSelect={vi.fn()}
        onCommentLine={onCommentLine}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent(
      "Reviewing 2 individual units in this card",
    );
    expect(screen.getByRole("article")).toHaveTextContent(
      "const contextA = true;",
    );
    expect(
      screen.getByText("const contextA = true;").closest("div"),
    ).toHaveClass("opacity-45");
    expect(
      screen.queryByRole("button", {
        name: "Comment on line 3 of configuration",
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Comment on line 5 of main" }),
    );
    expect(onCommentLine).toHaveBeenCalledWith("main", 5);
  });

  it("mounts only the leading rows of a file card longer than a window", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        /** Ignores the block: this case only reads the first paint. */
        observe() {}

        /** Ignores teardown: nothing was ever reported. */
        disconnect() {}
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const member = {
      ...units[0],
      id: "long",
      name: "long",
      startLine: 1,
      endLine: 600,
    };
    render(
      <ReviewConceptFileCardPreview
        members={[member] as never}
        index={0}
        count={1}
        fileSource={Array.from(
          { length: 600 },
          (_, index) => `const line${index + 1} = true;`,
        ).join("\n")}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("const line1 = true;")).toBeInTheDocument();
    expect(screen.getByText("const line200 = true;")).toBeInTheDocument();
    expect(screen.queryByText("const line201 = true;")).not.toBeInTheDocument();
  });

  it("keeps member line numbers accurate without hydrated file context", async () => {
    const onCommentLine = vi.fn();
    render(
      <ReviewConceptFileCardPreview
        members={[units[0], units[2]] as never}
        index={0}
        count={1}
        fileSource=""
        onSelect={vi.fn()}
        onCommentLine={onCommentLine}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Comment on line 2 of configuration",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Comment on line 5 of main" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Comment on line 3 of configuration",
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Comment on line 5 of main" }),
    );
    expect(onCommentLine).toHaveBeenCalledWith("main", 5);
  });

  it("opens a signed-off file card closed and leaves an unreviewed one open", () => {
    const highlight = vi.mocked(useHighlightedSource);
    highlight.mockClear();
    render(
      <ReviewConceptFileCardPreview
        members={[{ ...units[0], status: "signed_off" }] as never}
        index={0}
        count={1}
        fileSource={["// setup", "const configuration = true;"].join("\n")}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Reviewed")).toBeInTheDocument();
    expect(screen.getByRole("article")).not.toHaveTextContent(
      "const configuration = true;",
    );
    expect(screen.getByText(/Folded after review/)).toBeInTheDocument();
    expect(highlight).not.toHaveBeenCalled();

    cleanup();
    highlight.mockClear();
    render(
      <ReviewConceptFileCardPreview
        members={[units[0]] as never}
        index={0}
        count={1}
        fileSource={["// setup", "const configuration = true;"].join("\n")}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent(
      "const configuration = true;",
    );
    expect(highlight).toHaveBeenCalled();
  });

  it("keeps the selected card frame around a hidden source notice", () => {
    render(
      <ReviewFileCardSourcePlaceholder
        framed
        language="json"
        lineCount={812}
        onShow={vi.fn()}
        path="values.schema.json"
        reviewed={false}
      />,
    );

    const frame = screen
      .getByRole("button", { name: "Show file" })
      .closest("div");
    expect(frame).toHaveClass(
      "rounded-b-xl",
      "border-x",
      "border-b",
      "border-line",
    );
    expect(frame).toHaveTextContent("812 lines of json hidden");
  });

  it("keeps a card open when a new unit arrives after older units were signed off", () => {
    render(
      <ReviewConceptFileCardPreview
        members={
          [
            { ...units[0], status: "signed_off", revisionState: "unchanged" },
            { ...units[2], status: "pending", revisionState: "new" },
          ] as never
        }
        index={0}
        count={1}
        fileSource={[
          "// setup",
          "const configuration = true;",
          "const contextA = true;",
          "const contextB = true;",
          "const main = true;",
        ].join("\n")}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByText("Reviewed")).not.toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveTextContent("const main = true;");
    expect(screen.queryByText(/Folded after review/)).not.toBeInTheDocument();
  });

  it("shows a small JSON change even when its review unit spans a large file", () => {
    const fileSource = [
      "{",
      ...Array.from(
        { length: 78 },
        (_, index) => `  "row_${index}": ${index},`,
      ),
      '  "changed": true',
      "}",
    ].join("\n");
    render(
      <ReviewConceptFileCardPreview
        members={
          [
            {
              id: "config",
              path: "package.json",
              name: "package.json",
              changedLineCount: 1,
              changeType: "modified",
              previousSource: fileSource.replace("true", "false"),
              source: fileSource,
              startLine: 1,
              endLine: 81,
              language: "json",
              kind: "module",
              status: "pending",
            },
          ] as never
        }
        index={0}
        count={1}
        fileSource={fileSource}
        itemLabel="File"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent('"changed": true');
    expect(screen.queryByText(/lines of json hidden/)).not.toBeInTheDocument();
  });

  it("hides a large JSON card until the reviewer asks to see it", async () => {
    const highlight = vi.mocked(useHighlightedSource);
    highlight.mockClear();
    const jsonLines = Array.from(
      { length: 80 },
      (_, index) => `  "row_${index}": ${index},`,
    );
    const fileSource = ["{", ...jsonLines, "}"].join("\n");
    render(
      <ReviewConceptFileCardPreview
        members={
          [
            {
              id: "snapshot",
              path: "app/drizzle/migrations/meta/0039_snapshot.json",
              name: "0039_snapshot.json",
              changedLineCount: 82,
              changeType: "added",
              previousSource: null,
              source: fileSource,
              startLine: 1,
              endLine: 82,
              language: "json",
              kind: "module",
              status: "pending",
            },
          ] as never
        }
        index={0}
        count={1}
        fileSource={fileSource}
        itemLabel="File"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("82 lines of json hidden")).toBeInTheDocument();
    expect(
      screen.getByText(/Hidden so the review stays responsive/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Reviewing 1 individual unit in this file · 82 changed lines · \d+ KB/,
      ),
    ).toBeInTheDocument();
    expect(highlight).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Show file" }));
    expect(screen.getByRole("article")).toHaveTextContent('"row_0": 0');
    expect(highlight).toHaveBeenCalled();
  });

  it("hides a large one-line JSON file until the reviewer asks to see it", () => {
    const highlight = vi.mocked(useHighlightedSource);
    highlight.mockClear();
    const fileSource = `{"blob":"${"x".repeat(HEAVY_DATA_SOURCE_BYTES)}"}`;
    render(
      <ReviewConceptFileCardPreview
        members={
          [
            {
              id: "blob",
              path: "generated/blob.json",
              name: "blob.json",
              changedLineCount: 1,
              changeType: "added",
              previousSource: null,
              source: fileSource,
              startLine: 1,
              endLine: 1,
              language: "json",
              kind: "module",
              status: "pending",
            },
          ] as never
        }
        index={0}
        count={1}
        fileSource={fileSource}
        itemLabel="File"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("1 line of json hidden")).toBeInTheDocument();
    expect(
      screen.getByText(/Hidden so the review stays responsive/),
    ).toBeInTheDocument();
    expect(highlight).not.toHaveBeenCalled();
  });

  it("lets the reviewer fold a file card back up after opening it", async () => {
    render(
      <ReviewConceptFileCardPreview
        members={[{ ...units[0], status: "signed_off" }] as never}
        index={0}
        count={1}
        fileSource={["// setup", "const configuration = true;"].join("\n")}
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Expand preview.ts" }),
    );
    expect(screen.getByRole("article")).toHaveTextContent(
      "const configuration = true;",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Collapse preview.ts" }),
    );
    expect(screen.getByRole("article")).not.toHaveTextContent(
      "const configuration = true;",
    );
  });
});

describe("conceptMembersInReadingOrder", () => {
  it("sinks the signed-off members below the work that remains", () => {
    const members = [
      { id: "a", status: "signed_off" },
      { id: "b", status: "pending" },
      { id: "c", status: "signed_off" },
      { id: "d", status: "changed" },
    ];

    expect(conceptMembersInReadingOrder(members).map(({ id }) => id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("keeps dependency order inside each group", () => {
    // Members arrive in the order they must be read, and a reviewer follows a
    // dependency before its caller, so reordering within a group would break
    // the reading the concept was built to give.
    const members = [
      { id: "a", status: "pending" },
      { id: "b", status: "waiting" },
      { id: "c", status: "partial" },
    ];

    expect(conceptMembersInReadingOrder(members).map(({ id }) => id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("leaves the caller's array untouched", () => {
    const members = [
      { id: "a", status: "signed_off" },
      { id: "b", status: "pending" },
    ];

    conceptMembersInReadingOrder(members);

    expect(members.map(({ id }) => id)).toEqual(["a", "b"]);
  });
});

/** Places measurable review line anchors for the drag gesture tests. */
function renderDraggableReviewLines(
  placements: readonly { line: number; top: number }[],
) {
  let measureCount = 0;
  const elements = placements.map(({ line, top }) => {
    const element = document.createElement("span");
    element.id = `review-line-${line}`;
    element.getBoundingClientRect = () => {
      measureCount += 1;
      return { top, height: 20 } as DOMRect;
    };
    document.body.append(element);
    return element;
  });
  return {
    cleanup: () => {
      for (const element of elements) element.remove();
    },
    measureCount: () => measureCount,
  };
}

/** Runs the animation frame the drag preview coalesces its updates into. */
async function flushAnimationFrame() {
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

describe("InlineCommentComposer", () => {
  it("keeps typing inside the composer and reports the draft upward", async () => {
    const change = vi.fn();
    const post = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineCommentComposer
        initialDraft=""
        line={42}
        path="src/server/queue.ts"
        pending={false}
        posting={false}
        provider="github"
        onCancel={vi.fn()}
        onDraftChange={change}
        onPost={post}
      />,
    );

    const input = screen.getByPlaceholderText(
      "Write an inline GitHub comment\u2026",
    );
    expect(input).toHaveFocus();
    await user.type(input, "Guard");

    expect(input).toHaveValue("Guard");
    expect(change).toHaveBeenLastCalledWith("Guard");
    await user.click(screen.getByRole("button", { name: /Post to GitHub/ }));
    expect(post).toHaveBeenCalledWith("Guard");
  });

  it("starts from the draft it was handed and posts it with the shortcut", async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineCommentComposer
        initialDraft="**Unbounded retry**"
        line={42}
        path="src/server/queue.ts"
        pending={false}
        posting={false}
        provider="gitlab"
        onCancel={vi.fn()}
        onDraftChange={vi.fn()}
        onPost={post}
      />,
    );

    const input = screen.getByPlaceholderText(
      "Write an inline GitLab comment\u2026",
    );
    expect(input).toHaveValue("**Unbounded retry**");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(post).toHaveBeenCalledWith("**Unbounded retry**");
  });

  it("cancels on Escape and blocks posting while a comment is in flight", async () => {
    const cancel = vi.fn();
    const post = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineCommentComposer
        initialDraft="Guard"
        line={42}
        path="src/server/queue.ts"
        pending
        posting
        provider="azure_devops"
        onCancel={cancel}
        onDraftChange={vi.fn()}
        onPost={post}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Posting\u2026/ }),
    ).toBeDisabled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(post).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("InlineAiQuestion", () => {
  it("can restore a saved conversation without stealing keyboard focus", async () => {
    const priorControl = document.createElement("button");
    document.body.append(priorControl);
    priorControl.focus();
    render(
      <InlineAiQuestion
        autoFocus={false}
        canAsk
        initialDraft=""
        entries={[
          {
            id: "question-1",
            question: "Why did this change?",
            status: "completed",
            error: null,
            result: { summary: "It narrows the retry boundary." },
          },
        ]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("It narrows the retry boundary.", undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
    expect(priorControl).toHaveFocus();
    priorControl.remove();
  });

  it("shows the focused conversation and submits with Enter", async () => {
    const ask = vi.fn(() => true);
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft="Why is this guard needed?"
        entries={[
          {
            id: "question-1",
            question: "What changed here?",
            status: "completed",
            error: null,
            result: { summary: "The PR adds a bounded retry guard." },
          },
        ]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onDraftChange={change}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    expect(screen.getByText("Ask AI about line 17")).toBeInTheDocument();
    expect(
      await screen.findByText("The PR adds a bounded retry guard."),
    ).toBeInTheDocument();
    const input = screen.getByRole("textbox", {
      name: "Ask AI about line 17",
    });
    await user.type(input, "x{Enter}");
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith("Why is this guard needed?x");
    expect(change).toHaveBeenCalledWith("Why is this guard needed?x");
  });

  it("keeps the typed question local and clears it once submitted", async () => {
    const ask = vi.fn(() => true);
    const draftChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onClose={vi.fn()}
        onDraftChange={draftChange}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Ask AI about line 17",
    });
    await user.type(input, "Why retry twice");
    expect(input).toHaveValue("Why retry twice");
    expect(draftChange).toHaveBeenLastCalledWith("Why retry twice");

    await user.type(input, "{Enter}");
    expect(ask).toHaveBeenCalledExactlyOnceWith("Why retry twice");
    expect(input).toHaveValue("");
    expect(draftChange).toHaveBeenLastCalledWith("");
  });

  it("preserves a draft when the question is rejected upstream", async () => {
    const ask = vi.fn(() => false);
    const draftChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft="Another question"
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onClose={vi.fn()}
        onDraftChange={draftChange}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Ask AI about line 17",
    });
    await user.type(input, "{Enter}");

    expect(ask).toHaveBeenCalledExactlyOnceWith("Another question");
    expect(input).toHaveValue("Another question");
    expect(draftChange).not.toHaveBeenCalledWith("");
  });

  it("moves the focus with the line controls", async () => {
    const step = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={step}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Move AI question one line down",
      }),
    );
    expect(step).toHaveBeenCalledWith(1);
  });

  it("submits quick questions with modified number shortcuts", () => {
    const ask = vi.fn();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), {
      code: "Digit2",
      key: "@",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      code: "Digit3",
      ctrlKey: true,
      key: "#",
      shiftKey: true,
    });

    expect(ask).toHaveBeenNthCalledWith(1, AI_QUICK_QUESTIONS[1].question);
    expect(ask).toHaveBeenNthCalledWith(2, AI_QUICK_QUESTIONS[2].question);
    expect(
      screen.getByRole("button", { name: /Quick question 1: What does/ }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Quick question 3: What should/ }),
    ).toBeEnabled();
  });

  it("leaves unmodified number keys available for normal typing", () => {
    const ask = vi.fn();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft="Compare version "
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), {
      code: "Digit2",
      key: "2",
    });

    expect(ask).not.toHaveBeenCalled();
  });

  it("replaces initial quick questions with editable PR comment proposals", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[
          {
            id: "question-1",
            jobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
            question: "Is this import used?",
            status: "completed",
            error: null,
            result: {
              summary: "No. The import is unused.",
              commentProposals: [
                {
                  body: "Please remove this unused import.",
                  path: "src/page.tsx",
                  line: 7,
                },
              ],
            },
          },
        ]}
        line={7}
        minimumLine={1}
        maximumLine={20}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onPublishProposal={publish}
        onStep={vi.fn()}
        providerName="GitHub"
      />,
    );

    expect(screen.queryByText("Quick questions")).not.toBeInTheDocument();
    const proposal = screen.getByRole("textbox", {
      name: "Edit suggested PR comment 1",
    });
    fireEvent.change(proposal, {
      target: { value: "Please remove the unused route import." },
    });
    fireEvent.keyDown(proposal, {
      code: "Digit1",
      key: "!",
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({
        aiCommentIndex: 0,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        body: "Please remove the unused route import.",
        line: 7,
      }),
    );
  });

  it("confirms before permanently deleting a completed conversation", async () => {
    const deleteThread = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[
          {
            id: "question-1",
            jobId: "11111111-1111-4111-8111-111111111111",
            question: "Is this import used?",
            status: "completed",
            error: null,
            result: { summary: "No. The import is unused." },
          },
        ]}
        line={7}
        minimumLine={1}
        maximumLine={20}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onDeleteThread={deleteThread}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
        providerName="GitHub"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete AI conversation" }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "Delete this AI conversation?",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/Comments already published to GitHub will remain/),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: /Delete conversation/ }),
    );
    await waitFor(() =>
      expect(deleteThread).toHaveBeenCalledWith([
        "11111111-1111-4111-8111-111111111111",
      ]),
    );
  });

  it("formats a partial Markdown answer and announces live progress", () => {
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[
          {
            id: "question-streaming",
            question: "Is this import used?",
            status: "streaming",
            error: null,
            progress: "Writing the answer…",
            result: {
              summary:
                "**No.** The import is unused.\n\n- Remove it from this file.\n- Keep the route convention.",
            },
          },
        ]}
        line={7}
        minimumLine={1}
        maximumLine={20}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    expect(screen.getByText("No.").tagName).toBe("STRONG");
    expect(screen.getByText("Remove it from this file.")).toBeInTheDocument();
    expect(screen.getByText("Writing the answer…")).toBeInTheDocument();
    expect(screen.getByText("AI is writing")).toHaveClass("sr-only");
  });

  it("uses the global arrow keys to move focus while the composer is open", () => {
    const step = vi.fn();
    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={step}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });

    expect(step).toHaveBeenNthCalledWith(1, -1);
    expect(step).toHaveBeenNthCalledWith(2, 1);
  });

  it("tracks dragging outside the handle and commits the nearest line", async () => {
    const move = vi.fn();
    const preview = vi.fn();
    const lines = renderDraggableReviewLines([
      { line: 17, top: 100 },
      { line: 22, top: 220 },
    ]);

    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={move}
        onPreview={preview}
        onStep={vi.fn()}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Drag AI question to another line",
      }),
      { pointerId: 7, clientY: 110 },
    );
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 225 });
    await flushAnimationFrame();
    fireEvent.pointerUp(window, { pointerId: 7, clientY: 225 });

    expect(preview).toHaveBeenCalledWith(22);
    expect(move).toHaveBeenCalledWith(22);
    lines.cleanup();
  });

  it("commits the release position when it is newer than the last move", () => {
    const move = vi.fn();
    const lines = renderDraggableReviewLines([
      { line: 17, top: 100 },
      { line: 22, top: 220 },
      { line: 27, top: 340 },
    ]);

    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={move}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Drag AI question to another line",
      }),
      { pointerId: 8, clientY: 110 },
    );
    fireEvent.pointerMove(window, { pointerId: 8, clientY: 225 });
    fireEvent.pointerUp(window, { pointerId: 8, clientY: 345 });

    expect(move).toHaveBeenCalledWith(27);
    lines.cleanup();
  });

  it("measures the review lines once per drag and previews once per frame", async () => {
    const move = vi.fn();
    const preview = vi.fn();
    const lines = renderDraggableReviewLines([
      { line: 17, top: 100 },
      { line: 22, top: 220 },
      { line: 27, top: 340 },
    ]);

    render(
      <InlineAiQuestion
        canAsk
        initialDraft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onDraftChange={vi.fn()}
        onClose={vi.fn()}
        onMove={move}
        onPreview={preview}
        onStep={vi.fn()}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Drag AI question to another line",
      }),
      { pointerId: 3, clientY: 110 },
    );
    const measurements = lines.measureCount();

    fireEvent.pointerMove(window, { pointerId: 3, clientY: 225 });
    fireEvent.pointerMove(window, { pointerId: 3, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 3, clientY: 345 });
    await flushAnimationFrame();

    expect(lines.measureCount()).toBe(measurements);
    expect(preview.mock.calls).toEqual([[17], [27]]);

    fireEvent.pointerUp(window, { pointerId: 3, clientY: 345 });

    expect(move).toHaveBeenCalledWith(27);
    lines.cleanup();
  });
});

describe("AI conversation visibility", () => {
  it("remembers open lines and explicit closure independently per unit", () => {
    localStorage.clear();
    rememberAiConversationVisibility(
      localStorage,
      "pr-1",
      "unit-1",
      17,
      "thread-1",
    );
    rememberAiConversationVisibility(localStorage, "pr-1", "unit-2", null);

    expect(aiConversationVisibility(localStorage, "pr-1", "unit-1")).toEqual({
      line: 17,
      threadId: "thread-1",
    });
    expect(aiConversationVisibility(localStorage, "pr-1", "unit-2")).toBeNull();
    expect(
      aiConversationVisibility(localStorage, "pr-1", "unknown-unit"),
    ).toBeUndefined();
  });

  it("ignores malformed persisted visibility", () => {
    localStorage.setItem(
      "reviewduck:ai-conversation-visibility:pr-invalid",
      JSON.stringify({ "unit-1": 9 }),
    );

    expect(
      aiConversationVisibility(localStorage, "pr-invalid", "unit-1"),
    ).toBeUndefined();
  });
});

describe("deleted AI conversation cache", () => {
  it("removes the discarded jobs from the persisted question list", () => {
    expect(
      withoutDeletedAiQuestions(
        [
          { id: "keep", question: "Still here" },
          { id: "gone", question: "Delete me" },
          { id: "row-3", jobId: "job-3", question: "Also gone" },
        ],
        ["gone", "job-3"],
      ),
    ).toEqual([{ id: "keep", question: "Still here" }]);
  });

  it("leaves an unloaded question query untouched", () => {
    expect(withoutDeletedAiQuestions(undefined, ["gone"])).toBeUndefined();
  });

  it("drops live entries keyed by either the row id or the job id", () => {
    expect(
      withoutDeletedLiveAiQuestions(
        [
          { id: "live-1", jobId: "job-1" },
          { id: "job-2" },
          { id: "live-3", jobId: "job-3" },
        ],
        ["job-1", "job-2"],
      ),
    ).toEqual([{ id: "live-3", jobId: "job-3" }]);
  });
});

/** Supplies the conversation actions a test does not care about. */
function conversationActions(
  overrides: Partial<ProviderConversationActions> = {},
): ProviderConversationActions {
  return {
    onDeleteComment: vi.fn().mockResolvedValue(undefined),
    onDeleteThread: vi.fn().mockResolvedValue(undefined),
    onEditComment: vi.fn().mockResolvedValue(undefined),
    onReply: vi.fn().mockResolvedValue(undefined),
    onResolve: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ProviderConversation", () => {
  it("publishes a reply inside the existing provider thread", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "901",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "resolved",
          comments: [
            {
              externalId: "901",
              author: "reviewer",
              body: "Could this retain the previous behavior?",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onReply: reply })}
      />,
    );

    expect(
      screen.queryByText("Could this retain the previous behavior?"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Expand GitHub conversation",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Reply on GitHub" }));
    await user.type(
      screen.getByPlaceholderText("Continue this conversation…"),
      "I restored the previous behavior.",
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(reply).toHaveBeenCalledWith("I restored the previous behavior.");
  });

  it("keeps unresolved conversations open when the page loads", () => {
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "902",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "902",
              author: "reviewer",
              body: "This still needs attention.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions()}
      />,
    );

    expect(screen.getByText("This still needs attention.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Collapse GitHub conversation",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("resolves an open conversation and reopens a resolved one", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const thread = {
      externalId: "903",
      path: "src/retry.ts",
      line: 17,
      side: "right" as const,
      status: "open" as const,
      comments: [
        {
          externalId: "903",
          author: "reviewer",
          body: "Please rename this.",
          createdAt: "2026-07-20T10:00:00Z",
          publishedByAnotherReviewer: false,
        },
      ],
      unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
    };
    const { rerender } = render(
      <ProviderConversation
        provider="github"
        thread={thread}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onResolve: resolve })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Resolve this conversation" }),
    );
    expect(resolve).toHaveBeenCalledWith(true);

    rerender(
      <ProviderConversation
        provider="github"
        thread={{ ...thread, status: "resolved" }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onResolve: resolve })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Reopen this conversation" }),
    );

    expect(resolve).toHaveBeenLastCalledWith(false);
  });

  it("confirms before deleting a whole conversation", async () => {
    const deleteThread = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "904",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "904",
              author: "reviewer",
              body: "Never mind, this was wrong.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
            {
              externalId: "905",
              author: "author",
              body: "Agreed.",
              createdAt: "2026-07-20T11:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onDeleteThread: deleteThread })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete this conversation" }),
    );
    expect(deleteThread).not.toHaveBeenCalled();
    expect(
      screen.getByText(/removes all 2 comments from GitHub/),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^Delete/,
      }),
    );

    expect(deleteThread).toHaveBeenCalledTimes(1);
  });

  it("edits one comment of a conversation in place", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "906",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "906",
              author: "reviewer",
              body: "Tpyo here.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onEditComment: edit })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit the comment by reviewer" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "Edit the comment by reviewer on GitHub",
    });
    await user.clear(editor);
    await user.type(editor, "Typo here.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(edit).toHaveBeenCalledWith("906", "Typo here.");
  });

  it("offers no edit or delete on another reviewer's comment", async () => {
    // The provider would allow it: one workspace connection speaks for every
    // member, so only ReviewDuck knows whose words these are.
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "920",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "920",
              author: "reviewer",
              body: "Mine.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
            {
              externalId: "921",
              author: "colleague",
              body: "Theirs.",
              createdAt: "2026-07-20T11:00:00Z",
              publishedByAnotherReviewer: true,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck
        replying={false}
        {...conversationActions()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Edit the comment by reviewer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit the comment by colleague" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete the comment by colleague" }),
    ).not.toBeInTheDocument();
  });

  it("withholds the conversation delete while it holds another reviewer's comment", () => {
    // Deleting a conversation takes every comment in it.
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "922",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "922",
              author: "reviewer",
              body: "Mine.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
            {
              externalId: "923",
              author: "colleague",
              body: "Theirs.",
              createdAt: "2026-07-20T11:00:00Z",
              publishedByAnotherReviewer: true,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck
        replying={false}
        {...conversationActions()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Delete this conversation" }),
    ).toBeDisabled();
    // Resolving belongs to whoever is reading the conversation, not to the
    // reviewer who happened to open it.
    expect(
      screen.getByRole("button", { name: "Resolve this conversation" }),
    ).toBeEnabled();
  });

  it("keeps the delete dialog open when the provider refuses", async () => {
    const deleteThread = vi.fn().mockRejectedValue(new Error("403"));
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "909",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "909",
              author: "reviewer",
              body: "Someone else's comment.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onDeleteThread: deleteThread })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete this conversation" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^Delete/,
      }),
    );

    expect(deleteThread).toHaveBeenCalledTimes(1);
    // The mutation owns the message; the dialog stays so the reviewer can retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps an edit draft when the provider refuses it", async () => {
    const edit = vi.fn().mockRejectedValue(new Error("403"));
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "910",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "910",
              author: "reviewer",
              body: "Original.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onEditComment: edit })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit the comment by reviewer" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "Edit the comment by reviewer on GitHub",
    });
    await user.clear(editor);
    await user.type(editor, "Second attempt.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(edit).toHaveBeenCalledWith("910", "Second attempt.");
    expect(editor).toHaveValue("Second attempt.");
  });

  it("survives a refused resolution without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    onTestFinished(() =>
      window.removeEventListener("unhandledrejection", unhandled),
    );
    const resolve = vi.fn().mockRejectedValue(new Error("403"));
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "911",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "911",
              author: "reviewer",
              body: "Still open.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onResolve: resolve })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Resolve this conversation" }),
    );

    expect(resolve).toHaveBeenCalledWith(true);
    // The header keeps showing the resolution the provider still reports.
    expect(
      screen.getByRole("button", { name: "Resolve this conversation" }),
    ).toBeInTheDocument();
    // A negative assertion passes on `waitFor`'s first call, which proves
    // nothing about an event that would arrive a turn later.
    await new Promise((done) => window.setTimeout(done, 0));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("deletes a single comment without touching the conversation", async () => {
    const deleteComment = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ProviderConversation
        provider="github"
        thread={{
          externalId: "907",
          path: "src/retry.ts",
          line: 17,
          side: "right",
          status: "open",
          comments: [
            {
              externalId: "907",
              author: "reviewer",
              body: "Root comment.",
              createdAt: "2026-07-20T10:00:00Z",
              publishedByAnotherReviewer: false,
            },
            {
              externalId: "908",
              author: "author",
              body: "Stray reply.",
              createdAt: "2026-07-20T11:00:00Z",
              publishedByAnotherReviewer: false,
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        {...conversationActions({ onDeleteComment: deleteComment })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete the comment by author" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^Delete/,
      }),
    );

    expect(deleteComment).toHaveBeenCalledWith("908");
  });
});

describe("SideBySideUnitDiff", () => {
  it("shows aligned base and pull-request lines and opens current comments", async () => {
    const selectLine = vi.fn();
    const user = userEvent.setup();
    render(
      <SideBySideUnitDiff
        previousSource={"const value = 1;\nreturn value;"}
        currentSource={"const value = 2;\nreturn value;"}
        language="typescript"
        previousStartLine={10}
        currentStartLine={12}
        selectedLine={12}
        onSelectReviewLine={selectLine}
        renderLineDetails={(line) =>
          line === 12 ? <div>Inline details for line 12</div> : null
        }
      />,
    );

    expect(
      screen.getByRole("region", { name: "Side-by-side code diff" }),
    ).toHaveTextContent("const value = 1;");
    expect(
      screen.getByRole("region", { name: "Side-by-side code diff" }),
    ).toHaveTextContent("const value = 2;");
    expect(screen.getByText("Inline details for line 12")).toBeInTheDocument();

    const [commentButton] = screen.getAllByRole("button", {
      name: "Comment on current line 12",
    });
    if (!commentButton) throw new Error("Expected a current-line action");
    expect(commentButton).toHaveTextContent("const value = 2;");
    await user.click(commentButton);
    expect(selectLine).toHaveBeenCalledWith(12);

    const [unchangedLine] = screen.getAllByRole("button", {
      name: "Comment on current line 13",
    });
    if (!unchangedLine) throw new Error("Expected an unchanged-line action");
    expect(unchangedLine).toHaveTextContent("return value;");
    unchangedLine.focus();
    await user.keyboard("{Enter}");
    expect(selectLine).toHaveBeenLastCalledWith(13);
  });

  it("routes row actions to the latest handlers after a re-render", async () => {
    const staleSelect = vi.fn();
    const staleAsk = vi.fn();
    const freshSelect = vi.fn();
    const freshAsk = vi.fn();
    const user = userEvent.setup();
    /** Renders the diff with one generation of the two line handlers. */
    function diff(onSelect: () => void, onAsk: () => void) {
      return (
        <SideBySideUnitDiff
          previousSource={"const value = 1;\nreturn value;"}
          currentSource={"const value = 2;\nreturn value;"}
          language="typescript"
          previousStartLine={10}
          currentStartLine={12}
          onSelectReviewLine={onSelect}
          onAskReviewLine={onAsk}
        />
      );
    }
    const { rerender } = render(diff(staleSelect, staleAsk));

    rerender(diff(freshSelect, freshAsk));

    const [commentButton] = screen.getAllByRole("button", {
      name: "Comment on current line 12",
    });
    if (!commentButton) throw new Error("Expected a current-line action");
    await user.click(commentButton);
    expect(staleSelect).not.toHaveBeenCalled();
    expect(freshSelect).toHaveBeenCalledWith(12);

    const [askButton] = screen.getAllByRole("button", {
      name: "Ask AI about line 12",
    });
    if (!askButton) throw new Error("Expected an ask action");
    await user.click(askButton);
    expect(staleAsk).not.toHaveBeenCalled();
    expect(freshAsk).toHaveBeenCalledWith(12);
  });

  it("renders a file-mode unit label before the line it opens", () => {
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={'export const TypePlot = pgTable(\n  "type_plot",\n);'}
        language="typescript"
        previousStartLine={1}
        currentStartLine={9908}
        currentFocusStartLine={9908}
        currentFocusEndLine={9910}
        onSelectReviewLine={vi.fn()}
        renderBeforeLine={(line) =>
          line === 9908 ? <div>TypePlot section</div> : null
        }
      />,
    );

    const diff = screen.getByRole("region", { name: "Added code diff" });
    expect(diff.textContent?.indexOf("TypePlot section")).toBeLessThan(
      diff.textContent?.indexOf("export const TypePlot") ?? -1,
    );
  });

  it("keeps a folded unit label visible while omitting its code rows", () => {
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={"const reviewed = true;\nconst pending = true;"}
        language="typescript"
        previousStartLine={1}
        currentStartLine={20}
        currentFocusStartLine={20}
        currentFocusEndLine={21}
        isReviewLineCollapsed={(line) => line === 20}
        onSelectReviewLine={vi.fn()}
        renderBeforeLine={(line) =>
          line === 20 ? <div>Reviewed unit folded</div> : null
        }
      />,
    );

    const diff = screen.getByRole("region", { name: "Added code diff" });
    expect(diff).toHaveTextContent("Reviewed unit folded");
    expect(diff).not.toHaveTextContent("const reviewed = true;");
    expect(diff).toHaveTextContent("const pending = true;");
  });

  it("uses one full-width pull-request pane for pure additions", async () => {
    const selectLine = vi.fn();
    const user = userEvent.setup();
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={"const added = true;\nreturn added;"}
        language="typescript"
        previousStartLine={1}
        currentStartLine={18}
        onSelectReviewLine={selectLine}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Added code diff" }),
    ).toHaveTextContent("const added = true;");
    expect(screen.queryByText("Base")).not.toBeInTheDocument();

    const addedLine = screen.getByRole("button", {
      name: "Comment on current line 18",
    });
    expect(addedLine).toHaveTextContent("const added = true;");
    expect(addedLine).toHaveClass("select-text");
    expect(
      screen.getByText("const added = true;").closest(".syntax-code"),
    ).toHaveClass("cursor-text", "select-text");

    const selection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent.click(addedLine, { detail: 1 });
    expect(selectLine).not.toHaveBeenCalled();
    selection.mockRestore();

    await user.click(addedLine);
    expect(selectLine).toHaveBeenCalledWith(18);
  });

  it("paints the finding line amber in the added-only pane", () => {
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={"const added = true;\nreturn added;"}
        language="typescript"
        previousStartLine={1}
        currentStartLine={18}
        findingLine={18}
        onSelectReviewLine={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Comment on current line 18" }),
    ).toHaveClass(
      "bg-amber-400/[.09]",
      "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
    );
    expect(
      screen.getByRole("button", { name: "Comment on current line 19" }),
    ).not.toHaveClass("bg-amber-400/[.09]");
  });

  it("paints the finding line amber on the current side of the split", () => {
    render(
      <SideBySideUnitDiff
        previousSource={"const value = 1;\nreturn value;"}
        currentSource={"const value = 2;\nreturn value;"}
        language="typescript"
        previousStartLine={10}
        currentStartLine={12}
        findingLine={12}
        onSelectReviewLine={vi.fn()}
      />,
    );

    // The row is laid out for one width at a time, so the highlight has to
    // survive the swap or the finding is invisible on a narrow viewport.
    expect(
      screen.getByRole("button", { name: "Comment on current line 12" }),
    ).toHaveClass(
      "bg-amber-400/[.09]",
      "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
    );
    expect(
      screen.getByRole("button", { name: "Comment on current line 13" }),
    ).not.toHaveClass("bg-amber-400/[.09]");

    act(() => setViewportWide(false));

    expect(
      screen.getByRole("button", { name: "Comment on current line 12" }),
    ).toHaveClass(
      "bg-amber-400/[.09]",
      "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
    );
    expect(
      screen.getByRole("button", { name: "Comment on current line 13" }),
    ).not.toHaveClass("bg-amber-400/[.09]");
  });

  it("renders one row layout instead of a copy for each breakpoint", () => {
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={"const value = 1;\nreturn value;"}
        currentSource={"const value = 2;\nreturn value;"}
        language="typescript"
        previousStartLine={10}
        currentStartLine={12}
        onSelectReviewLine={vi.fn()}
      />,
    );

    const splitColumns =
      '[class*="grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)]"]';
    expect(container.querySelectorAll("[data-review-scope]")).toHaveLength(2);
    expect(container.querySelectorAll(splitColumns)).toHaveLength(2);

    act(() => setViewportWide(false));

    expect(container.querySelectorAll("[data-review-scope]")).toHaveLength(2);
    expect(container.querySelectorAll(splitColumns)).toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: "Comment on current line 12" }),
    ).toHaveLength(1);
  });

  it("paints the finding line amber on the deleted side of the split", () => {
    render(
      <SideBySideUnitDiff
        previousSource={"const removed = true;\nconst retained = true;"}
        currentSource={
          "const inserted = true;\nconst removed = true;\nconst retained = true;"
        }
        language="typescript"
        previousStartLine={8}
        currentStartLine={8}
        previousFocusStartLine={8}
        previousFocusEndLine={8}
        currentFocusStartLine={null}
        currentFocusEndLine={null}
        findingLine={8}
        onSelectReviewLine={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Comment on deleted line 8" }),
    ).toHaveClass(
      "bg-amber-400/[.09]",
      "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
    );
  });

  it("leaves context rows unpainted while no finding is open", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={"const before = true;\nconst after = true;"}
        currentSource={
          "const before = true;\nconst added = true;\nreturn added;\nconst after = true;"
        }
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusStartLine={null}
        previousFocusEndLine={null}
        currentFocusStartLine={2}
        currentFocusEndLine={3}
        selectedLine={2}
        keyboardLine={2}
        onSelectReviewLine={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Show 1 lines above" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Show 1 lines below" }),
    );

    expect(
      container.querySelectorAll('[data-review-scope="context"]'),
    ).toHaveLength(2);
    // A context row carries no review line, so it must not claim the amber bar
    // that only an open finding earns.
    expect(
      container.querySelectorAll('[class*="rgb(245_158_11"]'),
    ).toHaveLength(0);
  });

  it("leaves unchanged context rows unpainted in the narrow layout", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={
          "const before = true;\nconst removed = true;\nconst after = true;"
        }
        currentSource={
          "const before = true;\nconst changed = true;\nconst after = true;"
        }
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusRanges={[{ startLine: 2, endLine: 2 }]}
        currentFocusRanges={[{ startLine: 2, endLine: 2 }]}
        selectedLine={2}
        keyboardLine={2}
        onSelectReviewLine={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Show 1 lines above" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Show 1 lines below" }),
    );

    expect(container).toHaveTextContent("const before = true;");
    expect(
      container.querySelectorAll('[class*="rgb(245_158_11"]'),
    ).toHaveLength(0);
  });

  it("marks pure-addition review scope and dims revealed context", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={"const before = true;\nconst after = true;"}
        currentSource={
          "const before = true;\nconst added = true;\nreturn added;\nconst after = true;"
        }
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusStartLine={null}
        previousFocusEndLine={null}
        currentFocusStartLine={2}
        currentFocusEndLine={3}
        onSelectReviewLine={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Show 1 lines above" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Show 1 lines below" }),
    );

    expect(
      container.querySelector('[data-review-scope-edge="start"]'),
    ).toHaveTextContent("Unit starts · line 2");
    expect(
      container.querySelector('[data-review-scope-edge="end"]'),
    ).toHaveTextContent("Unit ends · line 3");
    expect(
      container.querySelectorAll('[data-review-scope="context"]'),
    ).toHaveLength(2);
    for (const row of container.querySelectorAll(
      '[data-review-scope="context"]',
    )) {
      expect(row).toHaveClass("opacity-55");
    }
    for (const row of container.querySelectorAll(
      '[data-review-scope="unit"]',
    )) {
      expect(row).not.toHaveClass("opacity-55");
    }
  });

  it("offers provider comments on base-only deleted lines", async () => {
    const selectLine = vi.fn();
    const user = userEvent.setup();
    render(
      <SideBySideUnitDiff
        previousSource={"const removed = true;\nconst retained = true;"}
        currentSource={
          "const inserted = true;\nconst removed = true;\nconst retained = true;"
        }
        language="typescript"
        previousStartLine={8}
        currentStartLine={8}
        previousFocusStartLine={8}
        previousFocusEndLine={8}
        currentFocusStartLine={null}
        currentFocusEndLine={null}
        onSelectReviewLine={selectLine}
      />,
    );

    const diff = screen.getByRole("region", {
      name: "Side-by-side code diff",
    });
    expect(diff).toHaveTextContent("const removed = true;");
    const deletedLineActions = screen.getAllByRole("button", {
      name: "Comment on deleted line 8",
    });
    const deletedLine = deletedLineActions[0];
    if (!deletedLine) throw new Error("Expected a deleted-line action");
    expect(deletedLine).toHaveTextContent("const removed = true;");
    await user.click(deletedLine);
    expect(selectLine).toHaveBeenCalledWith(8);
  });

  it("keeps gaps between related ranges visible but non-commentable", async () => {
    const selectLine = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={
          "const retained = 1;\nconst removed = true;\nconst gapA = 1;\nconst gapB = 2;\nreturn removed;"
        }
        currentSource={
          "const retained = 1;\nconst enabled = true;\nconst gapA = 1;\nconst gapB = 2;\nreturn enabled;"
        }
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusRanges={[
          { startLine: 2, endLine: 2 },
          { startLine: 5, endLine: 5 },
        ]}
        currentFocusRanges={[
          { startLine: 2, endLine: 2 },
          { startLine: 5, endLine: 5 },
        ]}
        onSelectReviewLine={selectLine}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Comment on current line 2" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Comment on current line 5" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Comment on current line 3" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment on current line 4" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-review-scope="context"]'),
    ).toHaveLength(2);

    const currentLine = screen.getAllByRole("button", {
      name: "Comment on current line 5",
    })[0];
    if (!currentLine) throw new Error("Expected a current-line action");
    await user.click(currentLine);
    expect(selectLine).toHaveBeenCalledWith(5);
  });

  it("focuses a large unit on its changed hunk and reveals context on demand", async () => {
    const user = userEvent.setup();
    const contextRef = createRef<SideBySideUnitDiffHandle>();
    const before = Array.from(
      { length: 30 },
      (_, index) => `distant before ${index}`,
    );
    const after = Array.from(
      { length: 30 },
      (_, index) => `distant after ${index}`,
    );
    render(
      <SideBySideUnitDiff
        ref={contextRef}
        previousSource={[...before, "old behavior", ...after].join("\n")}
        currentSource={[...before, "new behavior", ...after].join("\n")}
        language="typescript"
        previousStartLine={100}
        currentStartLine={100}
        previousFocusStartLine={100}
        previousFocusEndLine={160}
        currentFocusStartLine={100}
        currentFocusEndLine={160}
        onSelectReviewLine={vi.fn()}
      />,
    );

    const diff = screen.getByRole("region", {
      name: "Side-by-side code diff",
    });
    expect(diff).toHaveTextContent("old behavior");
    expect(diff).toHaveTextContent("new behavior");
    // Unit edges stay pinned; deep unchanged interior stays collapsed.
    expect(diff).toHaveTextContent("distant before 0");
    expect(diff).not.toHaveTextContent("distant before 15");
    expect(diff).toHaveTextContent("distant after 29");
    expect(diff).not.toHaveTextContent("distant after 15");

    act(() => {
      expect(contextRef.current?.revealContext(-1)).toBe(true);
      expect(contextRef.current?.revealContext(1)).toBe(true);
    });
    // Interior collapses page; finish any remainder with the in-flow control.
    const remaining = screen.queryAllByRole("button", {
      name: /Show \d+ more unchanged lines/,
    });
    for (const button of remaining) {
      await user.click(button);
    }

    expect(diff).toHaveTextContent("distant before 15");
    expect(diff).toHaveTextContent("distant after 15");
  });

  it("reveals an addition-only collapsed gap in capped pages", async () => {
    const user = userEvent.setup();
    const additions = Array.from(
      { length: 50 },
      (_, index) => `const addition${index + 1} = true;`,
    );
    render(
      <SideBySideUnitDiff
        previousSource=""
        currentSource={additions.join("\n")}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusRanges={[]}
        currentFocusRanges={[
          { startLine: 1, endLine: 1 },
          { startLine: 50, endLine: 50 },
        ]}
        onSelectReviewLine={vi.fn()}
      />,
    );

    const diff = screen.getByRole("region", { name: "Added code diff" });
    expect(diff).not.toHaveTextContent("const addition25 = true;");
    for (const pageSize of [20, 20, 2]) {
      await user.click(
        screen.getByRole("button", {
          name: `Show ${pageSize} more unchanged lines`,
        }),
      );
    }

    expect(diff).toHaveTextContent("const addition25 = true;");
    expect(
      screen.queryByRole("button", { name: /more unchanged lines/ }),
    ).not.toBeInTheDocument();
  });

  it("reveals a split collapsed gap in capped pages", async () => {
    const user = userEvent.setup();
    const unchanged = Array.from(
      { length: 60 },
      (_, index) => `const retained${index + 1} = true;`,
    );
    render(
      <SideBySideUnitDiff
        previousSource={["const behavior = 'before';", ...unchanged].join("\n")}
        currentSource={["const behavior = 'after';", ...unchanged].join("\n")}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusStartLine={1}
        previousFocusEndLine={61}
        currentFocusStartLine={1}
        currentFocusEndLine={61}
        onSelectReviewLine={vi.fn()}
      />,
    );

    const diff = screen.getByRole("region", {
      name: "Side-by-side code diff",
    });
    expect(diff).not.toHaveTextContent("const retained30 = true;");
    for (const pageSize of [20, 20, 15]) {
      await user.click(
        screen.getByRole("button", {
          name: `Show ${pageSize} more unchanged lines`,
        }),
      );
    }

    expect(diff).toHaveTextContent("const retained30 = true;");
    expect(
      screen.queryByRole("button", { name: /more unchanged lines/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the entire file without collapsed gaps when expanded", () => {
    const before = Array.from(
      { length: 30 },
      (_, index) => `distant before ${index}`,
    );
    const after = Array.from(
      { length: 30 },
      (_, index) => `distant after ${index}`,
    );
    render(
      <SideBySideUnitDiff
        previousSource={[...before, "old behavior", ...after].join("\n")}
        currentSource={[...before, "new behavior", ...after].join("\n")}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusStartLine={31}
        previousFocusEndLine={31}
        currentFocusStartLine={31}
        currentFocusEndLine={31}
        expanded
        onSelectReviewLine={vi.fn()}
      />,
    );

    const diff = screen.getByRole("region", {
      name: "Side-by-side code diff",
    });
    expect(diff).toHaveTextContent("distant before 0");
    expect(diff).toHaveTextContent("distant before 15");
    expect(diff).toHaveTextContent("distant after 15");
    expect(diff).toHaveTextContent("distant after 29");
    expect(
      screen.queryByRole("button", { name: /Show .* lines/ }),
    ).not.toBeInTheDocument();
  });

  it("reveals surrounding file context in pages without making it commentable", async () => {
    const user = userEvent.setup();
    const selectLine = vi.fn();
    const before = Array.from(
      { length: 30 },
      (_, index) => `before unit ${index + 1}`,
    );
    const after = Array.from(
      { length: 30 },
      (_, index) => `after unit ${index + 1}`,
    );
    const { container } = render(
      <SideBySideUnitDiff
        previousSource={[...before, "const removed = true;", ...after].join(
          "\n",
        )}
        currentSource={[...before, ...after].join("\n")}
        language="typescript"
        previousStartLine={1}
        currentStartLine={1}
        previousFocusStartLine={31}
        previousFocusEndLine={31}
        currentFocusStartLine={null}
        currentFocusEndLine={null}
        onSelectReviewLine={selectLine}
      />,
    );

    const diff = screen.getByRole("region", {
      name: "Side-by-side code diff",
    });
    expect(diff).toHaveTextContent("const removed = true;");
    expect(diff).not.toHaveTextContent("before unit 30");

    await user.click(
      screen.getByRole("button", { name: "Show 20 lines above" }),
    );
    expect(diff).toHaveTextContent("before unit 30");
    expect(
      container.querySelector('[data-review-scope-edge="start"]'),
    ).toHaveTextContent("Unit starts · line 31");
    expect(
      container.querySelector('[data-review-scope="context"]'),
    ).toHaveClass("opacity-55");
    expect(
      container.querySelector('[data-review-scope="unit"]'),
    ).not.toHaveClass("opacity-55");
    expect(
      screen.queryByRole("button", { name: /Comment.*before unit/i }),
    ).not.toBeInTheDocument();

    const deletedLine = screen.getAllByRole("button", {
      name: "Comment on deleted line 31",
    })[0];
    if (!deletedLine) throw new Error("Expected a deleted-line action");
    await user.click(deletedLine);
    expect(selectLine).toHaveBeenCalledWith(31);
  });
});

describe("nextAnchorableLine", () => {
  const disjoint = [
    { startLine: 10, endLine: 11 },
    { startLine: 20, endLine: 21 },
  ];

  it("skips the lines between a unit's disjoint ranges", () => {
    // The picker prints every line in the span, so stepping by one would park
    // it on a line the provider refuses to anchor a comment to.
    expect(nextAnchorableLine(11, 1, disjoint, 10, 21)).toBe(20);
    expect(nextAnchorableLine(20, -1, disjoint, 10, 21)).toBe(11);
  });

  it("holds the current line at either end of the scope", () => {
    expect(nextAnchorableLine(21, 1, disjoint, 10, 21)).toBe(21);
    expect(nextAnchorableLine(10, -1, disjoint, 10, 21)).toBe(10);
  });

  it("steps one line at a time through a contiguous unit", () => {
    expect(nextAnchorableLine(10, 1, undefined, 10, 12)).toBe(11);
    expect(nextAnchorableLine(12, -1, undefined, 10, 12)).toBe(11);
  });
});

describe("SplitActionButton", () => {
  /** Renders one split button with both scopes of an action. */
  function renderSplit(overrides: {
    unitDisabled?: boolean;
    onUnit?: () => void;
    onConcept?: () => void;
  }) {
    return render(
      <SplitActionButton
        icon={<span />}
        label="Sign off unit"
        mobileLabel="Sign off"
        menuLabel="Choose what to sign off"
        primary={{
          label: "Sign off unit",
          onSelect: overrides.onUnit ?? vi.fn(),
          shortcut: [{ key: "s" }],
        }}
        options={[
          {
            disabled: overrides.unitDisabled,
            label: "Sign off unit",
            onSelect: overrides.onUnit ?? vi.fn(),
            shortcut: [{ key: "s" }],
          },
          {
            label: "Sign off concept",
            onSelect: overrides.onConcept ?? vi.fn(),
            shortcut: [{ key: "s", shift: true }],
          },
        ]}
      />,
    );
  }

  it("keeps the wider scope one click away without opening it first", () => {
    const onUnit = vi.fn();
    renderSplit({ onUnit });

    expect(
      screen.queryByRole("menu", { name: "Choose what to sign off" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sign off unit/ }));
    expect(onUnit).toHaveBeenCalledOnce();
  });

  it("runs the scope chosen from the menu and closes it", async () => {
    const onConcept = vi.fn();
    renderSplit({ onConcept });

    await userEvent.click(
      screen.getByRole("button", { name: "Choose what to sign off" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Sign off concept/ }),
    );

    expect(onConcept).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menu", { name: "Choose what to sign off" }),
    ).not.toBeInTheDocument();
  });

  it("offers a scope the reviewer cannot use as unavailable rather than absent", () => {
    // Seeing why an action is out of reach beats it vanishing: a unit with no
    // conversation of its own still belongs to a concept that has one.
    renderSplit({ unitDisabled: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose what to sign off" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Sign off unit/ }),
    ).toBeDisabled();
  });

  it("moves focus into the menu and cycles it with the arrow keys", async () => {
    // The menu is drawn above the buttons and so precedes them in the DOM;
    // without taking focus, opening it would send a keyboard backwards.
    renderSplit({});

    await userEvent.click(
      screen.getByRole("button", { name: "Choose what to sign off" }),
    );
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(items[1]).toHaveFocus();
  });

  it("skips an unusable scope when walking the menu", async () => {
    renderSplit({ unitDisabled: true });

    await userEvent.click(
      screen.getByRole("button", { name: "Choose what to sign off" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Sign off concept/ }),
    ).toHaveFocus();
  });

  it("closes on Escape without letting the workspace see it", async () => {
    // Escape means something to the workspace behind this menu, so closing the
    // menu must not also cancel whatever sits under it. The key is dispatched
    // from the focused item rather than the document, because that is the only
    // path where stopping propagation can be observed at all.
    const onWorkspaceEscape = vi.fn();
    document.addEventListener("keydown", onWorkspaceEscape);
    try {
      renderSplit({});

      await userEvent.click(
        screen.getByRole("button", { name: "Choose what to sign off" }),
      );
      fireEvent.keyDown(screen.getAllByRole("menuitem")[0] as HTMLElement, {
        key: "Escape",
      });

      expect(
        screen.queryByRole("menu", { name: "Choose what to sign off" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Choose what to sign off" }),
      ).toHaveFocus();
      expect(onWorkspaceEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onWorkspaceEscape);
    }
  });
});

describe("reviewProviderWebUrl", () => {
  it("prefers the stored GitHub, GitLab, and Azure pull-request pages", () => {
    expect(
      reviewProviderWebUrl({
        repositoryWebUrl: "https://github.com/studie-tech/TheNinjaRPG",
        webUrl: "https://github.com/studie-tech/TheNinjaRPG/pull/79",
      }),
    ).toBe("https://github.com/studie-tech/TheNinjaRPG/pull/79");
    expect(
      reviewProviderWebUrl({
        repositoryWebUrl: "https://gitlab.com/acme/app",
        webUrl: "https://gitlab.com/acme/app/-/merge_requests/123",
      }),
    ).toBe("https://gitlab.com/acme/app/-/merge_requests/123");
    expect(
      reviewProviderWebUrl({
        repositoryWebUrl: "https://dev.azure.com/acme/project/_git/app",
        webUrl: "https://dev.azure.com/acme/project/_git/app/pullrequest/456",
      }),
    ).toBe("https://dev.azure.com/acme/project/_git/app/pullrequest/456");
  });

  it("falls back to the repository URL when the pull request has no page", () => {
    expect(
      reviewProviderWebUrl({
        repositoryWebUrl: "https://github.com/studie-tech/TheNinjaRPG",
        webUrl: "  ",
      }),
    ).toBe("https://github.com/studie-tech/TheNinjaRPG");
  });
});

describe("CopyRepositoryUrlButton", () => {
  /** Installs a clipboard the jsdom navigator does not expose. */
  function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  }

  it("puts the repository URL on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(
      <CopyRepositoryUrlButton url="https://github.com/studie-tech/TheNinjaRPG" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy repository URL" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://github.com/studie-tech/TheNinjaRPG",
      );
    });
    expect(
      screen.getByRole("button", { name: "Repository URL copied" }),
    ).toBeInTheDocument();
  });

  it("puts the pull request URL on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(
      <CopyRepositoryUrlButton
        kind="pull-request"
        url="https://github.com/studie-tech/TheNinjaRPG/pull/79"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy pull request URL" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://github.com/studie-tech/TheNinjaRPG/pull/79",
      );
    });
    expect(
      screen.getByRole("button", { name: "Pull request URL copied" }),
    ).toBeInTheDocument();
  });

  it("says so when the clipboard refuses the URL", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    mockClipboard(writeText);
    render(
      <CopyRepositoryUrlButton url="https://github.com/studie-tech/TheNinjaRPG" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy repository URL" }),
    );

    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Could not copy the repository URL");
    });
    expect(
      screen.getByRole("button", { name: "Copy repository URL" }),
    ).toBeInTheDocument();
  });
});

describe("PullRequestDetailsDialog", () => {
  /** Builds the workspace pull request with the fields a test overrides. */
  function pullRequest(
    overrides: Partial<WorkspacePullRequest> = {},
  ): WorkspacePullRequest {
    return {
      id: "pull-request-1",
      number: 42,
      title: "Keep the waiting concept out of the review path",
      description: "## Why\n\nA waiting concept was still offered as work.",
      authorLogin: "reviewer",
      sourceBranch: "fix/waiting-concept",
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      webUrl: "https://github.com/studie-tech/open-review-duck/pull/42",
      repositoryId: "repository-1",
      repositoryOwner: "studie-tech",
      repositoryName: "open-review-duck",
      repositoryWebUrl: "https://github.com/studie-tech/open-review-duck",
      provider: "github",
      ...overrides,
    };
  }

  it("formats the provider description the author wrote", () => {
    render(
      <PullRequestDetailsDialog
        pullRequest={pullRequest()}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Keep the waiting concept out of the review path",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Why" })).toBeInTheDocument();
    expect(
      screen.getByText("A waiting concept was still offered as work."),
    ).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "fix/waiting-concept into main" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open on GitHub/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/studie-tech/open-review-duck/pull/42",
    );
  });

  it("names the provider when the author left no description", () => {
    render(
      <PullRequestDetailsDialog
        pullRequest={pullRequest({ description: "   ", provider: "gitlab" })}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText("This pull request has no description on GitLab."),
    ).toBeInTheDocument();
  });

  it("closes on Escape and on the backdrop, but not on the panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <PullRequestDetailsDialog
        pullRequest={pullRequest()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("heading", {
        name: "Keep the waiting concept out of the review path",
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ConceptMoveDialog", () => {
  /** Builds one workspace concept with the fields a test overrides. */
  function concept(
    overrides: Partial<WorkspaceConcept> = {},
  ): WorkspaceConcept {
    return {
      id: "concept-1",
      stableKey: "concept:1",
      title: "Waiting concepts leave the review path",
      rationale: "Groups the wait rules with the code that reads them.",
      reviewOrder: 0,
      changedLineCount: 40,
      fileCount: 2,
      oversized: false,
      dependencies: [],
      memberIds: ["unit-1", "unit-2"],
      status: "pending",
      signedMemberCount: 0,
      ...overrides,
    };
  }

  const others = [
    concept({
      id: "concept-2",
      title: "Sign-off refuses a paused concept",
      memberIds: ["unit-3"],
      changedLineCount: 12,
      fileCount: 1,
    }),
    concept({
      id: "concept-3",
      title: "Tests for the wait rules",
      memberIds: ["unit-4", "unit-5", "unit-6"],
      changedLineCount: 90,
      fileCount: 3,
    }),
  ];

  it("offers every concept except the one the unit is already in", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConceptMoveDialog
        concepts={[concept(), ...others]}
        currentConceptId="concept-1"
        pending={false}
        unitName="releaseReviewWaitsSchema"
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("releaseReviewWaitsSchema")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Now reviewed in Waiting concepts leave the review path",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Waiting concepts leave the review path/,
      }),
    ).not.toBeInTheDocument();

    const destination = screen.getByRole("button", {
      name: /Tests for the wait rules/,
    });
    expect(destination).toHaveTextContent(
      "3 units · 90 changed lines in 3 files",
    );
    expect(
      screen.getByRole("button", { name: /Sign-off refuses a paused concept/ }),
    ).toHaveTextContent("1 unit · 12 changed lines in 1 file");

    await user.click(destination);
    expect(onSelect).toHaveBeenCalledWith("concept-3");
  });

  it("warns when the move empties the concept the unit is leaving", () => {
    render(
      <ConceptMoveDialog
        concepts={[concept({ memberIds: ["unit-1"] }), ...others]}
        currentConceptId="concept-1"
        pending={false}
        unitName="releaseReviewWaitsSchema"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(
        "This is the last unit in its concept, so that concept is removed.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the review holds no other concept", () => {
    render(
      <ConceptMoveDialog
        concepts={[concept()]}
        currentConceptId="concept-1"
        pending={false}
        unitName="releaseReviewWaitsSchema"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(/no other concept to move the unit into/),
    ).toBeInTheDocument();
  });

  it("holds the dialog open while the move is being written", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConceptMoveDialog
        concepts={[concept(), ...others]}
        currentConceptId="concept-1"
        pending={true}
        unitName="releaseReviewWaitsSchema"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    expect(
      screen.getByRole("button", { name: /Tests for the wait rules/ }),
    ).toBeDisabled();
  });
});
