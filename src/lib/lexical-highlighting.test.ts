import { describe, expect, it } from "vitest";
import { treeSitterLanguageFixtures } from "~/test/tree-sitter-language-fixtures";
import { lexicalLines } from "./lexical-highlighting";
import { highlightSource } from "./syntax-highlighting";

/** Flattens highlighted lines into their tokens for assertions. */
function tokensOf(lines: Awaited<ReturnType<typeof highlightSource>>) {
  return lines.flatMap(({ tokens }) => tokens);
}

/** Maps every source offset to the class the highlighter assigned it. */
function classesByOffset(
  lines: Awaited<ReturnType<typeof highlightSource>>,
  length: number,
) {
  const classes = new Array<string>(length).fill("");
  for (const token of tokensOf(lines)) {
    for (let offset = token.from; offset < token.to; offset += 1) {
      classes[offset] = token.className;
    }
  }
  return classes;
}

describe("lexicalLines", () => {
  it.each(Object.keys(treeSitterLanguageFixtures))(
    "preserves %s source text exactly",
    (language) => {
      const fixture =
        treeSitterLanguageFixtures[
          language as keyof typeof treeSitterLanguageFixtures
        ];
      const lines = lexicalLines(fixture.source, language);

      expect(lines.map(({ text }) => text).join("\n")).toBe(fixture.source);
    },
  );

  it.each([
    ["0xFF", "c"],
    ["0xdeadbeef", "rust"],
    ["0b1010", "go"],
    ["0o755", "rust"],
    ["0755", "java"],
    ["42", "typescript"],
  ])("classifies the literal %s as a number", (literal, language) => {
    // A radix prefix used to be followed by decimal digits only, so a hex
    // literal matched nothing and fell through to the operator class.
    const tokens = tokensOf(lexicalLines(`x = ${literal};`, language));

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: literal, className: "tok-number" }),
      ]),
    );
  });

  it("classifies comments, strings and numbers without a grammar", () => {
    const tokens = tokensOf(
      lexicalLines("const answer: number = 42; // meaning", "typescript"),
    );

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "const", className: "tok-keyword" }),
        expect.objectContaining({ text: "number", className: "tok-typeName" }),
        expect.objectContaining({ text: "42", className: "tok-number" }),
        expect.objectContaining({
          text: "// meaning",
          className: "tok-comment",
        }),
      ]),
    );
  });

  it("uses the comment syntax declared for each language", () => {
    const sql = tokensOf(lexicalLines("select 1; -- note", "sql"));
    const lua = tokensOf(lexicalLines("--[[ note ]] local x = 1", "lua"));
    const haskell = tokensOf(lexicalLines("{- note -}\nmain = 1", "haskell"));

    expect(sql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "-- note", className: "tok-comment" }),
      ]),
    );
    expect(lua).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "--[[ note ]]",
          className: "tok-comment",
        }),
      ]),
    );
    expect(haskell).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "{- note -}",
          className: "tok-comment",
        }),
      ]),
    );
  });

  it("distinguishes preprocessor directives and decrement from comments", () => {
    const tokens = tokensOf(lexicalLines("#include <vector>\n--count;", "cpp"));

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "#include", className: "tok-meta" }),
        expect.objectContaining({ text: "--", className: "tok-operator" }),
      ]),
    );
    expect(tokens.some(({ className }) => className === "tok-comment")).toBe(
      false,
    );
  });

  it("keeps a multi-line template literal inside one string", () => {
    const tokens = tokensOf(
      lexicalLines("const a = `one\ntwo`;\nb;", "typescript"),
    );

    expect(
      tokens.filter(({ className }) => className === "tok-string"),
    ).toHaveLength(2);
    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "b", className: "tok-variableName" }),
      ]),
    );
  });

  it("stops an unterminated quote at its own line", () => {
    const tokens = tokensOf(lexicalLines("echo don't\nls\n", "shell"));

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "ls", className: "tok-variableName" }),
      ]),
    );
  });

  it("falls back to unstyled lines when a language declares no syntax", () => {
    const lines = lexicalLines("# Title\n\nBody text", "markdown");

    expect(lines.flatMap(({ tokens }) => tokens)).toEqual([
      { className: "", text: "# Title", from: 0, to: 7 },
      { className: "", text: "Body text", from: 9, to: 18 },
    ]);
  });

  it("marks the same regions as comments as every grammar does", async () => {
    const disagreements: Record<string, number> = {};
    for (const [language, fixture] of Object.entries(
      treeSitterLanguageFixtures,
    )) {
      const lexical = classesByOffset(
        lexicalLines(fixture.source, language),
        fixture.source.length,
      );
      const grammar = classesByOffset(
        await highlightSource(fixture.source, language),
        fixture.source.length,
      );
      const mismatched = lexical.filter(
        (className, offset) =>
          (className === "tok-comment") !== (grammar[offset] === "tok-comment"),
      ).length;
      if (mismatched) disagreements[language] = mismatched;
    }

    expect(disagreements).toEqual({});
    // Loading one Tree-sitter grammar per language dominates this test, so it
    // is bounded well above the default rather than left to flake on a busy
    // machine — the comparison itself is what has to stay honest.
  }, 120_000);
});
