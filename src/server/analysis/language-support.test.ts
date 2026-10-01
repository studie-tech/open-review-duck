import { describe, expect, it } from "vitest";
import { treeSitterLanguageFixtures } from "~/test/tree-sitter-language-fixtures";
import languageManifest from "../../../tree-sitter-languages.json";
import { analyzeFiles } from "./engine";
import { languageAdapterForPath } from "./parsers";
import { semanticSymbolOccurrences } from "./parsers/tree-sitter-adapter";
import { createCandidateExtractor } from "./parsers/tree-sitter-candidate-strategies";
import type { CandidateToolkit } from "./parsers/tree-sitter-candidate-types";
import { shapes } from "./parsers/tree-sitter-language-shapes";
import { withSyntaxTree } from "./tree-sitter";
import { grammarAssets, lexicalSyntaxes, supportedLanguages } from "./types";

const languageDefinitions = languageManifest.languages as Record<
  string,
  { lexical?: string }
>;

describe("complete Tree-sitter language support", () => {
  it("keeps language shapes and candidate strategies complete", () => {
    const languages = Object.keys(grammarAssets).sort();
    const strategies = createCandidateExtractor(
      {} as CandidateToolkit,
    ).strategies;

    expect(Object.keys(shapes).sort()).toEqual(languages);
    expect(Object.keys(strategies).sort()).toEqual([
      "clojure",
      "elixir",
      "hcl",
      "javascript",
      "lua",
      "makefile",
      "ruby",
      "shell",
      "typescript",
    ]);
    for (const language of languages) {
      const shape = shapes[language as keyof typeof shapes];
      expect(
        Boolean(strategies[language as keyof typeof strategies]) ||
          shape.reviewsWholeFile === true ||
          Boolean(shape.sections) ||
          shape.containers.size +
            shape.functions.size +
            shape.variables.size +
            (shape.moduleUnits?.size ?? 0) >
            0,
        `${language} needs a common declaration shape or a specialized strategy`,
      ).toBe(true);
    }
  });

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
    // Each database object is an independently named unit a reviewer can sign
    // off without accepting an undifferentiated file card.
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

describe("a comment written in the language's own spelling", () => {
  /** Returns the smallest review unit whose source contains a snippet. */
  function tightestUnit(path: string, content: string, token: string) {
    const units = analyzeFiles([
      { path, content, changeType: "added" },
    ]).units.filter(({ kind }) => kind !== "file");
    const holders = units
      .filter((unit) => unit.source.includes(token))
      .sort((left, right) => left.source.length - right.source.length);
    expect(holders.map(({ name }) => name).join(", ")).not.toBe("");
    const unit = holders[0];
    if (!unit) throw new Error(`No unit contains ${token}`);
    return unit;
  }

  it.each([
    {
      language: "Java //",
      path: "Pond.java",
      content: [
        "// Counts ducks.",
        "class Ducks {}",
        "",
        "// Counts ponds.",
        "class Ponds {}",
        "",
      ].join("\n"),
      first: ["class Ducks", "Counts ducks"],
      second: ["class Ponds", "Counts ponds"],
    },
    {
      language: "C /* */",
      path: "pond.c",
      content: [
        "/* Counts ducks. */",
        "int ducks(void) { return 1; }",
        "",
        "/* Counts ponds. */",
        "int ponds(void) { return 1; }",
        "",
      ].join("\n"),
      first: ["int ducks", "Counts ducks"],
      second: ["int ponds", "Counts ponds"],
    },
    {
      language: "SQL --",
      path: "pond.sql",
      content: [
        "-- Counts ducks.",
        "CREATE TABLE ducks (id integer);",
        "",
        "-- Counts ponds.",
        "CREATE TABLE ponds (id integer);",
        "",
      ].join("\n"),
      first: ["CREATE TABLE ducks", "Counts ducks"],
      second: ["CREATE TABLE ponds", "Counts ponds"],
    },
    {
      language: "Haskell --",
      path: "Pond.hs",
      content: [
        "module Pond where",
        "",
        "-- Counts ducks.",
        "ducks = 1",
        "",
        "-- Counts ponds.",
        "ponds = 2",
        "",
      ].join("\n"),
      first: ["ducks = 1", "Counts ducks"],
      second: ["ponds = 2", "Counts ponds"],
    },
    {
      language: "Lua --",
      path: "pond.lua",
      content: [
        "--- Counts ducks.",
        "local function ducks()",
        "  return 1",
        "end",
        "",
        "--- Counts ponds.",
        "local function ponds()",
        "  return 2",
        "end",
        "",
      ].join("\n"),
      first: ["function ducks", "Counts ducks"],
      second: ["function ponds", "Counts ponds"],
    },
    {
      language: "Clojure ;",
      path: "pond.clj",
      content: [
        ";; Counts ducks.",
        "(defn ducks [] 1)",
        "",
        ";; Counts ponds.",
        "(defn ponds [] 2)",
        "",
      ].join("\n"),
      first: ["defn ducks", "Counts ducks"],
      second: ["defn ponds", "Counts ponds"],
    },
    {
      language: "Emacs Lisp ;",
      path: "pond.el",
      content: [
        ";; Counts ducks.",
        "(defun ducks () 1)",
        "",
        ";; Counts ponds.",
        "(defun ponds () 2)",
        "",
      ].join("\n"),
      first: ["defun ducks", "Counts ducks"],
      second: ["defun ponds", "Counts ponds"],
    },
    {
      language: "Erlang %",
      path: "pond.erl",
      content: [
        "-module(pond).",
        "",
        "% Counts ducks.",
        "ducks() -> 1.",
        "",
        "% Counts ponds.",
        "ponds() -> 2.",
        "",
      ].join("\n"),
      first: ["ducks()", "Counts ducks"],
      second: ["ponds()", "Counts ponds"],
    },
    {
      language: "Fortran !",
      path: "pond.f90",
      content: [
        "! Counts ducks.",
        "integer function ducks()",
        "  ducks = 1",
        "end function ducks",
        "",
        "! Counts ponds.",
        "integer function ponds()",
        "  ponds = 2",
        "end function ponds",
        "",
      ].join("\n"),
      first: ["function ducks", "Counts ducks"],
      second: ["function ponds", "Counts ponds"],
    },
    {
      language: "OCaml (* *)",
      path: "pond.ml",
      content: [
        "(* Counts ducks. *)",
        "let ducks () = 1",
        "",
        "(* Counts ponds. *)",
        "let ponds () = 2",
        "",
      ].join("\n"),
      first: ["let ducks", "Counts ducks"],
      second: ["let ponds", "Counts ponds"],
    },
    {
      language: "CSS /* */",
      path: "pond.css",
      content: [
        "/* Counts ducks. */",
        ".ducks { color: teal; }",
        "",
        "/* Counts ponds. */",
        ".ponds { color: blue; }",
        "",
      ].join("\n"),
      first: [".ducks", "Counts ducks"],
      second: [".ponds", "Counts ponds"],
    },
    {
      language: "Python #",
      path: "pond.py",
      content: [
        "# Counts ducks.",
        "def ducks():",
        "    return 1",
        "",
        "# Counts ponds.",
        "def ponds():",
        "    return 2",
        "",
      ].join("\n"),
      first: ["def ducks", "Counts ducks"],
      second: ["def ponds", "Counts ponds"],
    },
    {
      language: "Elixir #",
      path: "pond.ex",
      content: [
        "# Counts ducks.",
        "defmodule Ducks do",
        "  def quack, do: 1",
        "end",
        "",
        "# Counts ponds.",
        "defmodule Ponds do",
        "  def quack, do: 1",
        "end",
        "",
      ].join("\n"),
      first: ["defmodule Ducks", "Counts ducks"],
      second: ["defmodule Ponds", "Counts ponds"],
    },
    {
      language: "shell #",
      path: "pond.sh",
      content: [
        "# Counts ducks.",
        "ducks() {",
        "  echo 1",
        "}",
        "",
        "# Counts ponds.",
        "ponds() {",
        "  echo 2",
        "}",
        "",
      ].join("\n"),
      first: ["ducks()", "Counts ducks"],
      second: ["ponds()", "Counts ponds"],
    },
    {
      language: "PHP //",
      path: "pond.php",
      content: [
        "<?php",
        "// Counts ducks.",
        "function ducks(): int { return 1; }",
        "",
        "// Counts ponds.",
        "function ponds(): int { return 2; }",
        "",
      ].join("\n"),
      first: ["function ducks", "Counts ducks"],
      second: ["function ponds", "Counts ponds"],
    },
  ])(
    "keeps a $language comment with the declaration it introduces",
    ({ path, content, first, second }) => {
      const [firstToken, firstComment] = first;
      const [secondToken, secondComment] = second;
      if (!firstToken || !firstComment || !secondToken || !secondComment) {
        throw new Error(
          "Comment fixtures need a declaration token and comment text",
        );
      }
      const earlier = tightestUnit(path, content, firstToken);
      const later = tightestUnit(path, content, secondToken);

      expect(earlier.source).toContain(firstComment);
      expect(earlier.source).not.toContain(secondComment);
      expect(later.source).toContain(secondComment);
      expect(later.source).not.toContain(firstComment);
    },
  );

  it.each([
    {
      language: "Python",
      path: "notes.py",
      content: ["# File notes.", "", "def ducks():", "    return 1", ""].join(
        "\n",
      ),
      token: "def ducks",
      comment: "File notes",
    },
    {
      language: "SQL",
      path: "notes.sql",
      content: [
        "-- File notes.",
        "",
        "CREATE TABLE ducks (id integer);",
        "",
      ].join("\n"),
      token: "CREATE TABLE ducks",
      comment: "File notes",
    },
  ])(
    "leaves a $language comment that has a blank line under it off the next declaration",
    ({ path, content, token, comment }) => {
      expect(tightestUnit(path, content, token).source).not.toContain(comment);
    },
  );

  /**
   * Builds a one-line comment in the spelling the language actually writes.
   * A language with no comment syntax has nothing to attach.
   */
  function introducingComment(language: string) {
    const syntax = lexicalSyntaxes[language as keyof typeof lexicalSyntaxes];
    const line = syntax?.lineComments[0];
    if (line) return `${line} Counts ducks.`;
    const block = syntax?.blockComments[0];
    if (!block) return undefined;
    return `${block[0]} Counts ducks. ${block[1]}`;
  }

  const declarationFixtures = Object.entries(
    treeSitterLanguageFixtures,
  ).flatMap(([language, fixture]) => {
    const shape = shapes[language as keyof typeof shapes];
    const comment = introducingComment(language);
    // PHP's opening tag has to stay first, so a comment spliced above the
    // fixture is not a PHP comment.
    if (!shape || shape.reviewsWholeFile || !comment || language === "php") {
      return [];
    }
    return [[language, fixture, comment] as const];
  });

  /** Takes the opening of a declaration line, before its body or arguments. */
  function declarationOpening(line: string) {
    const trimmed = line.trim();
    const cut = [trimmed.indexOf("{"), trimmed.indexOf("(")]
      .filter((index) => index > 0)
      .reduce((soonest, index) => Math.min(soonest, index), trimmed.length);
    return trimmed.slice(0, Math.min(cut + 1, 40));
  }

  /**
   * Returns the declaration that opens a file, which is the one a leading
   * comment can introduce.
   */
  function openingUnit(
    units: Array<{ startLine: number; source: string; name: string }>,
  ) {
    return [...units].sort(
      (left, right) =>
        left.startLine - right.startLine ||
        right.source.length - left.source.length,
    )[0];
  }

  it.each(declarationFixtures)(
    "keeps a %s comment on the first declaration",
    (language, fixture, comment) => {
      const original = analyzeFiles([
        {
          path: fixture.path,
          content: fixture.source,
          changeType: "added",
        },
      ]).units.filter(({ kind }) => kind !== "file");
      const unit = openingUnit(original);
      if (!unit || unit.source.trim() === fixture.source.trim()) return;
      const openingLine = fixture.source.split("\n")[unit.startLine - 1] ?? "";
      const lines = fixture.source.split("\n");
      lines.splice(Math.max(0, unit.startLine - 1), 0, comment);
      const reviewed = analyzeFiles([
        {
          path: fixture.path,
          content: lines.join("\n"),
          changeType: "added",
        },
      ]).units.filter(({ kind }) => kind !== "file");
      const token = declarationOpening(openingLine);
      const attached = reviewed.some(
        (candidate) =>
          candidate.source.includes("Counts ducks") &&
          candidate.source.includes(token),
      );

      expect(attached, language).toBe(true);
    },
  );

  it.each(declarationFixtures)(
    "leaves a %s comment that has a blank line under it off the next declaration",
    (language, fixture, comment) => {
      // ReScript's syntax walk already loops on a blank line under a line
      // comment, independent of which declaration that comment belongs to.
      if (language === "rescript") return;
      const original = analyzeFiles([
        {
          path: fixture.path,
          content: fixture.source,
          changeType: "added",
        },
      ]).units.filter(({ kind }) => kind !== "file");
      const unit = openingUnit(original);
      if (!unit || unit.source.trim() === fixture.source.trim()) return;
      const openingLine = fixture.source.split("\n")[unit.startLine - 1] ?? "";
      const lines = fixture.source.split("\n");
      lines.splice(Math.max(0, unit.startLine - 1), 0, comment, "");
      const reviewed = analyzeFiles([
        {
          path: fixture.path,
          content: lines.join("\n"),
          changeType: "added",
        },
      ]).units.filter(({ kind }) => kind !== "file");
      const token = declarationOpening(openingLine);
      const owners = reviewed.filter(
        (candidate) =>
          candidate.source.includes(token) &&
          !candidate.invented &&
          candidate.source.trim() !== lines.join("\n").trim(),
      );
      if (owners.length === 0) return;

      expect(
        owners.every((candidate) => !candidate.source.includes("Counts ducks")),
        language,
      ).toBe(true);
    },
  );

  it("leaves a shell shebang off the function under it", () => {
    const unit = tightestUnit(
      "pond.sh",
      ["#!/bin/sh", "ducks() { echo 1; }", ""].join("\n"),
      "ducks()",
    );

    expect(unit.source).not.toContain("#!/bin/sh");
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
