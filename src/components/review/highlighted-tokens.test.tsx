// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyntaxToken } from "~/lib/highlight-tokens";
import { HighlightedSourceLines } from "./highlighted-source-lines";
import { HighlightedTokens } from "./highlighted-tokens";
import { UnitImportContext } from "./review-workspace-dialogs";
import { SymbolPeekCard } from "./symbol-peek";

vi.mock("~/lib/syntax-highlighting", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/syntax-highlighting")>();
  return {
    ...actual,
    useHighlightedSource: (source: string) =>
      source.split("\n").map((text) => ({
        text,
        tokens: text
          ? [{ className: "tok-test", from: 0, text, to: text.length }]
          : [],
      })),
  };
});

vi.mock("~/lib/tree-sitter-import-navigation", () => ({
  useImportStatements: (source: string) => {
    if (!source.startsWith("import")) return [];
    const local = "helper";
    const from = source.indexOf(local);
    return [
      {
        endLine: 1,
        from: 0,
        references: [
          {
            from,
            imported: local,
            kind: "named",
            local,
            specifier: "./helper",
            to: from + local.length,
          },
        ],
        source,
        startLine: 1,
        to: source.length,
      },
    ];
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Creates a classified token with offsets that remain stable on re-render. */
function token(
  text: string,
  from: number,
  className = "tok-keyword",
): SyntaxToken {
  return { className, from, text, to: from + text.length };
}

describe("HighlightedTokens", () => {
  it("preserves token classes and all source whitespace", () => {
    render(
      <code data-testid="code">
        <HighlightedTokens
          tokens={[
            token("const", 0),
            token("  name\t", 5, ""),
            token("= 1", 12, "tok-number"),
          ]}
        />
      </code>,
    );

    expect(screen.getByTestId("code")).toHaveTextContent("const  name\t= 1", {
      normalizeWhitespace: false,
    });
    expect(screen.getByText("const")).toHaveClass("tok-keyword");
    expect(screen.getByText("= 1")).toHaveClass("tok-number");
  });

  it("keeps an empty source line visible as one space", () => {
    render(
      <code data-testid="empty">
        <HighlightedTokens tokens={[]} />
      </code>,
    );

    expect(screen.getByTestId("empty").textContent).toBe(" ");
    expect(screen.getByTestId("empty").children).toHaveLength(0);
  });

  it("lets a surface decorate a token without taking over keys or text", async () => {
    const onOpen = vi.fn();
    render(
      <HighlightedTokens
        tokens={[token("helper", 7, "tok-variable")]}
        renderToken={({ children, className, token: rendered }) => (
          <button
            type="button"
            data-from={rendered.from}
            className={className}
            onClick={onOpen}
          >
            {children}
          </button>
        )}
      />,
    );

    const button = screen.getByRole("button", { name: "helper" });
    expect(button).toHaveAttribute("data-from", "7");
    expect(button).toHaveClass("tok-variable");
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps the same token node when only its syntax class changes", () => {
    const { rerender } = render(
      <HighlightedTokens tokens={[token("name", 0, "tok-variable")]} />,
    );
    const rendered = screen.getByText("name");

    rerender(<HighlightedTokens tokens={[token("name", 0, "tok-function")]} />);

    expect(screen.getByText("name")).toBe(rendered);
    expect(rendered).toHaveClass("tok-function");
  });
});

describe("highlighted source surfaces", () => {
  it("keeps source-row selection on the gutter while sharing token output", () => {
    const onSelectLine = vi.fn();
    render(
      <HighlightedSourceLines
        lines={[
          {
            text: "const value = 1;",
            tokens: [token("const value = 1;", 0)],
          },
        ]}
        onSelectLine={onSelectLine}
        selectedRange={{ endLine: 12, startLine: 12 }}
        startLine={12}
      />,
    );

    const gutter = screen.getByRole("button", {
      name: "Create compliance rule from line 12",
    });
    expect(gutter).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(gutter, { shiftKey: true });
    expect(onSelectLine).toHaveBeenCalledWith(12, true);
    expect(screen.getByText("const value = 1;")).toHaveClass("tok-keyword");
  });

  it("keeps symbol-peek line numbering and focus styling", () => {
    render(
      <SymbolPeekCard
        definition={{
          endLine: 21,
          focusLine: 21,
          language: "typescript",
          name: "helper",
          path: "src/helper.ts",
          source: "const first = 1;\nreturn first;",
          startLine: 20,
          unitKind: "function",
        }}
        onClose={vi.fn()}
        onHold={vi.fn()}
        peeked={{
          anchor: { bottom: 80, left: 100, top: 60 },
          symbol: "helper",
        }}
      />,
    );

    const focusedToken = screen.getByText("return first;");
    expect(focusedToken).toHaveClass("tok-test");
    expect(focusedToken.closest("div")).toHaveClass("bg-cyan/[.07]");
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
  });

  it("keeps import tokens interactive inside their original row", async () => {
    const onFollow = vi.fn();
    render(
      <UnitImportContext
        fileSource={'import { helper } from "./helper";\nhelper();'}
        language="typescript"
        onFollow={onFollow}
        unitId="unit-1"
        unitSource="helper();"
        visibleEndLine={2}
        visibleStartLine={2}
      />,
    );

    const importButton = screen.getByRole("button", {
      name: "Open helper from ./helper",
    });
    expect(importButton).toHaveClass("tok-test", "text-cyan");
    await userEvent.click(importButton);
    expect(onFollow).toHaveBeenCalledWith(
      expect.objectContaining({ local: "helper", specifier: "./helper" }),
    );
    expect(screen.getByLabelText("Imports for this unit")).toHaveTextContent(
      'import { helper } from "./helper";',
    );
  });
});
