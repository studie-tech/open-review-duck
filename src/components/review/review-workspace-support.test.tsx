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
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import type { RouterOutputs } from "~/trpc/react";
import {
  AI_QUICK_QUESTIONS,
  aiConversationVisibility,
  conceptMembersInReadingOrder,
  InlineAiQuestion,
  nextAnchorableLine,
  ProviderConversation,
  type ProviderConversationActions,
  ProviderConversationHistory,
  PullRequestDetailsDialog,
  ReviewConceptMemberPreview,
  rememberAiConversationVisibility,
  reviewShortcuts,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
  SplitActionButton,
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

type WorkspacePullRequest = RouterOutputs["review"]["workspace"]["pullRequest"];

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

  it("puts the concept variant of an action behind shift", () => {
    // Not the command key: the browser keeps it for closing the tab and never
    // hands the chord to the page, so a concept chord built on it would shut
    // the review down instead of recording it.
    expect(reviewShortcuts.signOffConcept).toEqual([{ key: "s", shift: true }]);
    expect(reviewShortcuts.awaitConcept).toEqual([{ key: "w", shift: true }]);
    expect(JSON.stringify(reviewShortcuts)).not.toMatch(/"[sw]","mod"/);
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

  it("uses a quiet loading state while private source is still pending", () => {
    render(
      <ReviewConceptMemberPreview
        unit={
          {
            id: "unit-pending-source",
            path: "src/example.ts",
            name: "example",
            changedLineCount: 2,
            changeType: "added",
            previousSource: null,
            source: "",
            startLine: 10,
            language: "typescript",
            kind: "function",
          } as never
        }
        index={1}
        count={3}
        sourceAvailable={false}
        sourcePending
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading source for example" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Source unavailable. Concept sign-off is blocked."),
    ).not.toBeInTheDocument();
  });

  it("reports unavailable source only after loading settles", () => {
    render(
      <ReviewConceptMemberPreview
        unit={
          {
            id: "unit-unavailable-source",
            path: "src/example.ts",
            name: "example",
            changedLineCount: 2,
            changeType: "added",
            previousSource: null,
            source: "",
            startLine: 10,
            language: "typescript",
            kind: "function",
          } as never
        }
        index={1}
        count={3}
        sourceAvailable={false}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Source unavailable. Concept sign-off is blocked."),
    ).toBeInTheDocument();
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

  it("lets a reviewer comment on a member card they have not opened", async () => {
    // Reading a concept means reading every card in it, so a line worth
    // commenting on is just as likely to sit in a card the reviewer has not
    // selected as in the open one.
    const onCommentLine = vi.fn();
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
            endLine: 11,
            language: "typescript",
            kind: "function",
          } as never
        }
        index={1}
        count={3}
        sourceAvailable
        onSelect={vi.fn()}
        onCommentLine={onCommentLine}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Comment on line 11 of example" }),
    );
    expect(onCommentLine).toHaveBeenCalledWith(11);
  });

  it("offers no composer on the lines between disjoint review ranges", () => {
    // The card prints the stored source from its first line, so it runs past
    // the gaps a disjoint unit leaves; the provider refuses a comment there.
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
            source: "const answer = 42;\nconst gap = 0;\nreturn answer;",
            startLine: 10,
            endLine: 12,
            relatedRanges: [
              { startLine: 10, endLine: 10 },
              { startLine: 12, endLine: 12 },
            ],
            language: "typescript",
            kind: "function",
          } as never
        }
        index={1}
        count={3}
        sourceAvailable
        onSelect={vi.fn()}
        onCommentLine={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Comment on line 10 of example" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Comment on line 12 of example" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment on line 11 of example" }),
    ).not.toBeInTheDocument();
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
