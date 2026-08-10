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
