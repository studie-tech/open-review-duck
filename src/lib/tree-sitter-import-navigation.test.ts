// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { ImportStatement } from "./import-navigation";
import {
  useImportReferences,
  useImportStatements,
} from "./tree-sitter-import-navigation";

const parsed: { source: string; language: string }[] = [];

vi.mock("./syntax-highlighting", () => ({
  withClientSyntaxTree: <T>(
    source: string,
    language: string,
    callback: (root: SyntaxNode) => T,
  ) => {
    parsed.push({ source, language });
    return Promise.resolve(callback({} as SyntaxNode));
  },
}));

vi.mock("./tree-sitter-imports", () => ({
  importStatementsFromTree: (source: string): ImportStatement[] => [
    {
      from: 0,
      to: source.length,
      startLine: 1,
      endLine: 1,
      source,
      references: [
        {
          from: 0,
          to: source.length,
          kind: "named",
          imported: "alpha",
          local: "alpha",
          specifier: "./helpers",
        },
      ],
    },
  ],
}));

describe("client import parsing", () => {
  it("parses one source once however many hooks read it", async () => {
    const source = 'import { alpha } from "./helpers";';
    const statements = renderHook(() =>
      useImportStatements(source, "typescript"),
    );
    const references = renderHook(() =>
      useImportReferences(source, "typescript"),
    );

    await waitFor(() => {
      expect(statements.result.current).toHaveLength(1);
      expect(references.result.current).toHaveLength(1);
    });
    expect(parsed).toEqual([{ source, language: "typescript" }]);

    const revisit = renderHook(() => useImportStatements(source, "typescript"));

    await waitFor(() => expect(revisit.result.current).toHaveLength(1));
    expect(parsed).toHaveLength(1);
  });

  it("parses each distinct source and grammar separately", async () => {
    const source = 'import { beta } from "./helpers";';
    const typescript = renderHook(() =>
      useImportStatements(source, "typescript"),
    );
    const javascript = renderHook(() =>
      useImportStatements(source, "javascript"),
    );

    await waitFor(() => {
      expect(typescript.result.current).toHaveLength(1);
      expect(javascript.result.current).toHaveLength(1);
    });
    expect(parsed).toHaveLength(3);
  });

  it("skips parsing sources without a grammar", async () => {
    const plain = renderHook(() => useImportStatements("plain notes", "text"));

    await waitFor(() => expect(plain.result.current).toEqual([]));
    expect(parsed).toHaveLength(3);
  });
});
