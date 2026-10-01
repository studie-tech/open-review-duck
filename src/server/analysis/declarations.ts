import "server-only";

import {
  findDeclarationLineFromTree,
  findReexportFromTree,
} from "~/lib/tree-sitter-declarations";
import {
  type TreeSitterLanguage,
  withPreparedTreeSitterLanguages,
  withSyntaxTree,
} from "~/server/analysis/tree-sitter";
import { grammarAssets } from "~/server/analysis/types";

/** Reports whether a language has a Tree-sitter grammar this process can load. */
function preparedDeclarationLanguage(
  language: string,
): TreeSitterLanguage | undefined {
  if (language === "text" || !(language in grammarAssets)) return undefined;
  return language as TreeSitterLanguage;
}

/** Finds a declaration line with the same Tree-sitter walk the analyzer uses. */
export async function findImportedDeclarationLine(
  source: string,
  imported: string,
  language: string,
  startLine = 1,
) {
  if (imported === "*") return undefined;
  const prepared = preparedDeclarationLanguage(language);
  if (!prepared) return undefined;
  return withPreparedTreeSitterLanguages([prepared], () =>
    withSyntaxTree(prepared, source, (tree) =>
      findDeclarationLineFromTree(source, tree.rootNode, imported, startLine),
    ),
  );
}

/** Finds a barrel-file re-export that forwards this name to another module. */
export async function findImportedReexport(
  source: string,
  imported: string,
  language: string,
) {
  if (imported === "*") return undefined;
  const prepared = preparedDeclarationLanguage(language);
  if (!prepared) return undefined;
  return withPreparedTreeSitterLanguages([prepared], () =>
    withSyntaxTree(prepared, source, (tree) =>
      findReexportFromTree(source, tree.rootNode, imported),
    ),
  );
}
