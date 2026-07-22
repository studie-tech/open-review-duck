// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiActionMenu,
  ProviderConversation,
  ProviderConversationHistory,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
} from "./review-workspace-support";

afterEach(cleanup);

describe("AiActionMenu", () => {
  it("opens the explanation choices and runs the selected action", async () => {
    const review = vi.fn();
    const user = userEvent.setup();
    render(
      <AiActionMenu
        fullWidth
        items={[
          {
            label: "Explain this unit",
            description: "Explain the active code",
            shortcut: [{ key: "e" }],
            onSelect: vi.fn(),
          },
          {
            label: "Review the full pull request",
            description: "Review every changed file",
            shortcut: [{ key: "r" }],
            onSelect: review,
          },
        ]}
      />,
    );

    const menuButton = screen.getByRole("button", {
      name: /AI assistance/i,
    });
    expect(menuButton).toHaveClass("w-full");
    await user.click(menuButton);
    expect(
      screen.getByRole("menu", { name: "AI review actions" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", {
        name: /Review the full pull request/,
      }),
    );

    expect(review).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menu", { name: "AI review actions" }),
    ).not.toBeInTheDocument();
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
    expect(diff).not.toHaveTextContent("distant before 0");

    const revealButtons = screen.getAllByRole("button", {
      name: "Show 20 more unchanged lines",
    });
    const revealBefore = revealButtons[0];
    if (!revealBefore) throw new Error("Expected collapsed leading context");
    act(() => {
      expect(contextRef.current?.revealContext(-1)).toBe(true);
      expect(contextRef.current?.revealContext(1)).toBe(true);
    });

    expect(diff).toHaveTextContent("distant before 29");
    expect(diff).not.toHaveTextContent("distant before 0");
    expect(diff).toHaveTextContent("distant after 0");
    expect(diff).not.toHaveTextContent("distant after 29");
    const revealRemaining = screen.getAllByRole("button", {
      name: "Show 7 more unchanged lines",
    })[0];
    if (!revealRemaining) throw new Error("Expected paged leading context");
    await user.click(revealRemaining);

    expect(diff).toHaveTextContent("distant before 0");
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
