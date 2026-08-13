// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import {
  AI_QUICK_QUESTIONS,
  aiConversationVisibility,
  conceptMembersInReadingOrder,
  InlineAiQuestion,
  ProviderConversation,
  ProviderConversationHistory,
  ReviewConceptMemberPreview,
  rememberAiConversationVisibility,
  reviewShortcuts,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
} from "./review-workspace-support";

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

afterEach(cleanup);

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

  it("steps through review findings on the bracket keys", () => {
    expect(reviewShortcuts.nextFinding).toEqual([{ key: "]" }]);
    expect(reviewShortcuts.previousFinding).toEqual([{ key: "[" }]);
  });
});

describe("ReviewConceptMemberPreview", () => {
  it("shows highlighted source without an open-diff gate", async () => {
    const onSelect = vi.fn();
    render(
      <ReviewConceptMemberPreview
        unit={
          {
            id: "unit-1",
            path: "src/example.ts",
            name: "example",
            changedLineCount: 2,
            changeType: "added",
            previousSource: null,
            source: "const answer = 42;\nreturn answer;",
            startLine: 10,
            language: "typescript",
            kind: "function",
          } as never
        }
        index={1}
        count={3}
        sourceAvailable
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByText("Open diff")).not.toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveTextContent("const answer = 42;");
    expect(screen.getByRole("article")).toHaveTextContent("return answer;");
    await userEvent.click(
      screen.getByRole("button", { name: "Select example" }),
    );
    expect(onSelect).toHaveBeenCalledOnce();
  });

  /** Renders one member card at the given review status. */
  function renderMember(status: string) {
    return render(
      <ReviewConceptMemberPreview
        unit={
          {
            id: `unit-${status}`,
            path: "src/example.ts",
            name: "example",
            changedLineCount: 2,
            changeType: "added",
            previousSource: null,
            source: "const answer = 42;",
            startLine: 10,
            language: "typescript",
            kind: "function",
            status,
          } as never
        }
        index={1}
        count={3}
        sourceAvailable
        onSelect={vi.fn()}
      />,
    );
  }

  it("marks a member the reviewer has already signed off", () => {
    renderMember("signed_off");

    expect(screen.getByText("Reviewed")).toBeInTheDocument();
  });

  it("opens a signed-off member closed and an unreviewed one open", () => {
    renderMember("signed_off");
    expect(screen.getByRole("article")).not.toHaveTextContent(
      "const answer = 42;",
    );

    cleanup();
    renderMember("pending");
    expect(screen.getByRole("article")).toHaveTextContent("const answer = 42;");
  });

  it("spends no highlighting on a member nobody has opened", () => {
    // The highlighter is a hook, so keeping it out of a collapsed card means
    // the card's body must not mount at all — the bounded highlight cache is
    // shared with the members the reviewer is actually reading.
    const highlight = vi.mocked(useHighlightedSource);
    highlight.mockClear();
    renderMember("signed_off");
    expect(highlight).not.toHaveBeenCalled();

    cleanup();
    highlight.mockClear();
    renderMember("pending");
    expect(highlight).toHaveBeenCalled();
  });

  it("lets the reviewer open a member back up and close it again", async () => {
    renderMember("signed_off");

    await userEvent.click(
      screen.getByRole("button", { name: "Expand example" }),
    );
    expect(screen.getByRole("article")).toHaveTextContent("const answer = 42;");

    await userEvent.click(
      screen.getByRole("button", { name: "Collapse example" }),
    );
    expect(screen.getByRole("article")).not.toHaveTextContent(
      "const answer = 42;",
    );
  });

  it.each(["pending", "partial", "waiting", "changed"])(
    "leaves a %s member unmarked",
    (status) => {
      // A unit whose code changed after sign-off is back in the queue, so
      // calling it reviewed would send the reviewer past work still owed.
      renderMember(status);

      expect(screen.queryByText("Reviewed")).not.toBeInTheDocument();
    },
  );
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

describe("InlineAiQuestion", () => {
  it("can restore a saved conversation without stealing keyboard focus", () => {
    const priorControl = document.createElement("button");
    document.body.append(priorControl);
    priorControl.focus();
    render(
      <InlineAiQuestion
        autoFocus={false}
        canAsk
        draft=""
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
        onChange={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    expect(screen.getByText("It narrows the retry boundary.")).toBeVisible();
    expect(priorControl).toHaveFocus();
    priorControl.remove();
  });

  it("shows the focused conversation and submits with Enter", async () => {
    const ask = vi.fn();
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        draft="Why is this guard needed?"
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
        onChange={change}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onPreview={vi.fn()}
        onStep={vi.fn()}
      />,
    );

    expect(screen.getByText("Ask AI about line 17")).toBeInTheDocument();
    expect(
      screen.getByText("The PR adds a bounded retry guard."),
    ).toBeInTheDocument();
    const input = screen.getByRole("textbox", {
      name: "Ask AI about line 17",
    });
    await user.type(input, "x{Enter}");
    expect(ask).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalled();
  });

  it("moves the focus with the line controls", async () => {
    const step = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineAiQuestion
        canAsk
        draft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onChange={vi.fn()}
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
        draft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onChange={vi.fn()}
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
        draft="Compare version "
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={ask}
        onChange={vi.fn()}
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
        draft=""
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
        onChange={vi.fn()}
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
        draft=""
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
        onChange={vi.fn()}
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
        draft=""
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
        onChange={vi.fn()}
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
        draft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onChange={vi.fn()}
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

  it("tracks dragging outside the handle and commits the nearest line", () => {
    const move = vi.fn();
    const preview = vi.fn();
    const firstLine = document.createElement("span");
    firstLine.id = "review-line-17";
    firstLine.getBoundingClientRect = () =>
      ({ top: 100, height: 20 }) as DOMRect;
    const secondLine = document.createElement("span");
    secondLine.id = "review-line-22";
    secondLine.getBoundingClientRect = () =>
      ({ top: 220, height: 20 }) as DOMRect;
    document.body.append(firstLine, secondLine);

    render(
      <InlineAiQuestion
        canAsk
        draft=""
        entries={[]}
        line={17}
        minimumLine={10}
        maximumLine={30}
        onAsk={vi.fn()}
        onChange={vi.fn()}
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
    fireEvent.pointerUp(window, { pointerId: 7, clientY: 225 });

    expect(preview).toHaveBeenCalledWith(22);
    expect(move).toHaveBeenCalledWith(22);
    firstLine.remove();
    secondLine.remove();
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
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        onReply={reply}
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
            },
          ],
          unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        }}
        publishedByReviewDuck={false}
        replying={false}
        onReply={vi.fn()}
      />,
    );

    expect(screen.getByText("This still needs attention.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Collapse GitHub conversation",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ProviderConversationHistory", () => {
  it("starts closed when every conversation is resolved", () => {
    const { container } = render(
      <ProviderConversationHistory
        threads={[
          {
            externalId: "901",
            path: "src/retry.ts",
            line: 17,
            side: "right",
            status: "resolved",
            comments: [],
            unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
          },
        ]}
      >
        <p>Resolved history</p>
      </ProviderConversationHistory>,
    );

    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("starts open while any conversation is unresolved", () => {
    const { container } = render(
      <ProviderConversationHistory
        threads={[
          {
            externalId: "902",
            path: "src/retry.ts",
            line: 17,
            side: "right",
            status: "open",
            comments: [],
            unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
          },
        ]}
      >
        <p>Open history</p>
      </ProviderConversationHistory>,
    );

    expect(container.querySelector("details")).toHaveAttribute("open");
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

    // Both the wide and the narrow layout render the row, so every match has
    // to carry the highlight or the finding is invisible at one width.
    const findingRows = screen.getAllByRole("button", {
      name: "Comment on current line 12",
    });
    expect(findingRows.length).toBeGreaterThan(0);
    for (const row of findingRows) {
      expect(row).toHaveClass(
        "bg-amber-400/[.09]",
        "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
      );
    }
    for (const row of screen.getAllByRole("button", {
      name: "Comment on current line 13",
    })) {
      expect(row).not.toHaveClass("bg-amber-400/[.09]");
    }
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

    const deletedRows = screen.getAllByRole("button", {
      name: "Comment on deleted line 8",
    });
    expect(deletedRows.length).toBeGreaterThan(0);
    for (const row of deletedRows) {
      expect(row).toHaveClass(
        "bg-amber-400/[.09]",
        "shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
      );
    }
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
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Comment on current line 5" }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Comment on current line 3" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment on current line 4" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-review-scope="context"]'),
    ).toHaveLength(4);

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
