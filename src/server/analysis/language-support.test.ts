import { describe, expect, it } from "vitest";
import languageManifest from "../../../tree-sitter-languages.json";
import { treeSitterLanguageFixtures } from "~/test/tree-sitter-language-fixtures";
import { analyzeFiles } from "./engine";
import { languageAdapterForPath } from "./parsers";
import { semanticSymbolOccurrences } from "./parsers/tree-sitter-adapter";
import { withSyntaxTree } from "./tree-sitter";
import { grammarAssets, lexicalSyntaxes, supportedLanguages } from "./types";

const languageDefinitions = languageManifest.languages as Record<
  string,
  { lexical?: string }
>;

describe("complete Tree-sitter language support", () => {
  it("keeps every grammar, adapter, extension, and fixture in lockstep", () => {
    const grammarLanguages = supportedLanguages.filter(
      (language) => language !== "text",
    );

    expect(Object.keys(grammarAssets)).toEqual(grammarLanguages);
    expect(Object.keys(treeSitterLanguageFixtures)).toEqual(grammarLanguages);
    for (const [language, fixture] of Object.entries(
      treeSitterLanguageFixtures,
    )) {
      expect(languageAdapterForPath(fixture.path)?.language).toBe(language);
    }
  });

  it("resolves every declared lexical syntax family", () => {
    const declared = supportedLanguages.filter(
      (language) => languageDefinitions[language]?.lexical,
    );

    expect(declared.filter((language) => !lexicalSyntaxes[language])).toEqual(
      [],
    );
  });

  it.each(Object.entries(treeSitterLanguageFixtures))(
    "loads and parses %s without syntax errors",
    (language, fixture) => {
      withSyntaxTree(
        language as keyof typeof treeSitterLanguageFixtures,
        fixture.source,
        (tree) => {
          expect(tree.rootNode.type).not.toBe("ERROR");
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.endIndex).toBe(fixture.source.length);
        },
      );
    },
  );

  it.each(Object.entries(treeSitterLanguageFixtures))(
    "analyzes %s as a reviewable source file",
    (language, fixture) => {
      const result = analyzeFiles([
        {
          path: fixture.path,
          content: fixture.source,
          changeType: "added",
        },
      ]);

      expect(result.unsupportedFiles).toEqual([]);
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.units.every((unit) => unit.language === language)).toBe(
        true,
      );
      expect(result.units.some((unit) => unit.kind === "file")).toBe(true);
      expect(result.units.some((unit) => unit.kind !== "file")).toBe(true);
    },
  );

  it.each(Object.entries(treeSitterLanguageFixtures))(
    "normalizes %s symbols into the shared semantic stream",
    (language, fixture) => {
      const occurrences = semanticSymbolOccurrences(
        language as keyof typeof treeSitterLanguageFixtures,
        fixture.source,
      );

      expect(Array.isArray(occurrences)).toBe(true);
      for (const occurrence of occurrences) {
        expect(occurrence).toEqual(
          expect.objectContaining({
            name: expect.any(String),
            role: expect.stringMatching(/^(definition|reference)$/),
            startLine: expect.any(Number),
            endLine: expect.any(Number),
            scopeChain: expect.arrayContaining(["<file>"]),
          }),
        );
      }
    },
  );

  it("uses SQL object names for review units", () => {
    const fixture = treeSitterLanguageFixtures.sql;
    const names = analyzeFiles([
      { path: fixture.path, content: fixture.source, changeType: "added" },
    ]).units.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining(["duck", "duck_sound", "duck.sql"]),
    );
  });
});

describe("declarations a grammar names in its own vocabulary", () => {
  it.each([
    ["a table", "CREATE TABLE ducks (id integer);", "ducks"],
    ["an index", "CREATE INDEX duck_idx ON ducks (id);", "duck_idx"],
    [
      "a policy",
      "CREATE POLICY duck_read ON ducks FOR SELECT USING (true);",
      "duck_read",
    ],
    ["a sequence", "CREATE SEQUENCE duck_id_seq;", "duck_id_seq"],
    [
      "a materialized view",
      "CREATE MATERIALIZED VIEW duck_counts AS SELECT count(*) FROM ducks;",
      "duck_counts",
    ],
  ])("reviews %s as a unit named after it", (_what, statement, name) => {
    // A policy, a sequence and a materialized view are objects a reviewer
    // signs off, and each one used to arrive as the whole statement for a
    // name — or, before that, inside one undifferentiated file card.
    const units = analyzeFiles([
      { path: "schema.sql", content: `${statement}\n`, changeType: "added" },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(1);
    expect(units[0]?.name).toBe(name);
  });

  it("gives a Scala declaration the documentation written above it", () => {
    // The grammar spells its comments `block_comment`, which the shape did not
    // list, so a Scaladoc was left outside the declaration it describes.
    const units = analyzeFiles([
      {
        path: "Pond.scala",
        content: "/** Holds water. */\nclass Pond {\n  def depth: Int = 3\n}\n",
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ name: "Pond", startLine: 1 });
    expect(units[0]?.source).toContain("Holds water");
  });
});

describe("a definition written as a run of clauses", () => {
  const haskell = [
    "module M where",
    "",
    "quack :: Int -> String",
    'quack 0 = "none"',
    'quack 1 = "one"',
    'quack _ = "many"',
    "",
    "honk :: Int",
    "honk = 1",
    "",
  ].join("\n");

  it("is one Haskell unit, signature and equations together", () => {
    // A card per equation gives a reviewer a column of cards all called
    // "quack", and nobody confirms one equation without the others.
    const units = analyzeFiles([
      { path: "M.hs", content: haskell, changeType: "added" },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units.map(({ name }) => name)).toEqual(["quack", "honk"]);
    expect(units[0]).toMatchObject({ startLine: 3, endLine: 6 });
    expect(units[0]?.source).toContain('quack _ = "many"');
    expect(units[1]).toMatchObject({ startLine: 8, endLine: 9 });
  });

  it("leaves an overload set of the same name apart", () => {
    // Two C++ overloads share a name and are different functions, so a
    // language that is not written in clauses must keep them separate.
    const units = analyzeFiles([
      {
        path: "f.cpp",
        content: "int f(int a) { return a; }\nint f(double a) { return 1; }\n",
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(2);
  });
});

describe("a Ruby statement that opens a heredoc", () => {
  it("reaches the end of the text it introduced", () => {
    // Ruby puts a heredoc's body after the statement rather than inside it, so
    // the constant ended at the `<<~SQL` and its own text was swept up as a
    // range belonging to nothing.
    const units = analyzeFiles([
      {
        path: "query.rb",
        content:
          "QUERY = <<~SQL\n  select 1\n  from ducks\nSQL\n\ndef run\n  QUERY\nend\n",
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units.map(({ name }) => name)).toEqual(["QUERY", "#run"]);
    expect(units[0]).toMatchObject({ startLine: 1, endLine: 4 });
    expect(units[0]?.source).toContain("from ducks");
  });

  it("keeps two heredocs in two declarations", () => {
    const units = analyzeFiles([
      {
        path: "queries.rb",
        content: "A = <<~X\n  one\nX\n\nB = <<~Y\n  two\nY\n",
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units.map(({ name }) => name)).toEqual(["A", "B"]);
    expect(units[1]).toMatchObject({ startLine: 5, endLine: 7 });
  });
});
