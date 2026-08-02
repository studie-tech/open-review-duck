import type { ImportReference, ImportStatement } from "~/lib/import-navigation";
import { importStatementsFromTree } from "~/lib/tree-sitter-imports";
import { withSyntaxTree } from "./tree-sitter";
import type { SupportedLanguage } from "./types";

/** Parses complete import statements with the server Tree-sitter runtime. */
export function parseImportStatements(
  source: string,
  language: SupportedLanguage | string,
): ImportStatement[] {
  if (language === "text") return [];
  return withSyntaxTree(
    language as Exclude<SupportedLanguage, "text">,
    source,
    (tree) => importStatementsFromTree(source, language, tree.rootNode),
  );
}

/** Returns deduplicated symbol references from parsed import statements. */
export function parseImportReferences(
  source: string,
  language: SupportedLanguage | string,
): ImportReference[] {
  return parseImportStatements(source, language)
    .flatMap(({ references }) => references)
    .filter(
      (reference, index, references) =>
        references.findIndex(
          (candidate) =>
            candidate.from === reference.from && candidate.to === reference.to,
        ) === index,
    );
}

/** Returns whether source contains only imports, comments, and directives. */
export function isImportOnlySource(
  source: string,
  language: SupportedLanguage | string,
) {
  if (language === "text") return false;
  const statements = parseImportStatements(source, language);
  if (statements.length === 0) return false;
  return withSyntaxTree(
    language as Exclude<SupportedLanguage, "text">,
    source,
    (tree) => {
      const importRanges = statements.map(({ from, to }) => ({ from, to }));
      return tree.rootNode.namedChildren.every((node) => {
        if (!node) return true;
        if (node.type.includes("comment")) return true;
        if (
          (language === "javascript" || language === "typescript") &&
          node.type === "expression_statement" &&
          node.namedChildren.every(
            (child) => child === null || child.type === "string",
          )
        ) {
          return true;
        }
        if (
          language === "python" &&
          node.type === "expression_statement" &&
          node.namedChildren.every(
            (child) => child === null || child.type === "string",
          )
        ) {
          return true;
        }
        return importRanges.some(
          (range) => range.from <= node.startIndex && range.to >= node.endIndex,
        );
      });
    },
  );
}
