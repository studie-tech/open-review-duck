import { useEffect, useState } from "react";
import type { ImportReference, ImportStatement } from "./import-navigation";
import { withClientSyntaxTree } from "./syntax-highlighting";
import { importStatementsFromTree } from "./tree-sitter-imports";

/** Parses client-side import statements with the selected Tree-sitter grammar. */
export async function parseTreeSitterImportStatements(
  source: string,
  language: string,
) {
  if (language === "text") return [];
  return withClientSyntaxTree(source, language, (root) =>
    importStatementsFromTree(source, language, root),
  );
}

/** Flattens client-side import statements into navigable symbol references. */
export async function parseTreeSitterImportReferences(
  source: string,
  language: string,
) {
  return (await parseTreeSitterImportStatements(source, language)).flatMap(
    ({ references }) => references,
  );
}

/** React binding for an asynchronous Tree-sitter import parse. */
function useParsedImports<T>(
  source: string,
  language: string,
  parse: (source: string, language: string) => Promise<T[]>,
) {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let current = true;
    setItems([]);
    void parse(source, language).then((parsed) => {
      if (current) setItems(parsed);
    });
    return () => {
      current = false;
    };
  }, [language, parse, source]);
  return items;
}

/** Returns parsed import statements for the current editor source. */
export function useImportStatements(source: string, language: string) {
  return useParsedImports<ImportStatement>(
    source,
    language,
    parseTreeSitterImportStatements,
  );
}

/** Returns parsed import references for the current editor source. */
export function useImportReferences(source: string, language: string) {
  return useParsedImports<ImportReference>(
    source,
    language,
    parseTreeSitterImportReferences,
  );
}
