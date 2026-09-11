import "server-only";

import {
  findDeclarationLineFromTree,
  findReexportFromTree,
} from "~/lib/tree-sitter-declarations";
import {
  type TreeSitterLanguage,
  withSyntaxTree,
} from "~/server/analysis/tree-sitter";

/** Finds a declaration line with the same Tree-sitter walk the analyzer uses. */
export function findImportedDeclarationLine(
  source: string,
  imported: string,
  language: string,
  startLine = 1,
) {
  if (imported === "*" || language === "text") return undefined;
  return withSyntaxTree(language as TreeSitterLanguage, source, (tree) =>
    findDeclarationLineFromTree(source, tree.rootNode, imported, startLine),
  );
}

/** Finds a barrel-file re-export that forwards this name to another module. */
export function findImportedReexport(
  source: string,
  imported: string,
  language: string,
) {
  if (imported === "*" || language === "text") return undefined;
  return withSyntaxTree(language as TreeSitterLanguage, source, (tree) =>
    findReexportFromTree(source, tree.rootNode, imported),
  );
}
