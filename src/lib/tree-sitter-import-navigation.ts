import { useEffect, useState } from "react";
import type { ImportReference, ImportStatement } from "./import-navigation";
import { withClientSyntaxTree } from "./syntax-highlighting";
import { importStatementsFromTree } from "./tree-sitter-imports";

// A unit and its expanded file context parse the same source, and reviewers
// return to units they have already opened, so the bound has to hold the
// sources one review keeps reachable rather than just the visible one.
const IMPORT_PARSE_CACHE_LIMIT = 200;
const importStatementPromises = new Map<string, Promise<ImportStatement[]>>();

/** Identifies one import parse by its source and grammar. */
function importParseKey(source: string, language: string) {
  return `${language}\0${source}`;
}

/** Parses client-side import statements with the selected Tree-sitter grammar. */
async function parseTreeSitterImportStatements(
  source: string,
  language: string,
) {
  if (language === "text") return [];
  const key = importParseKey(source, language);
  let statements = importStatementPromises.get(key);
  if (!statements) {
    statements = withClientSyntaxTree(source, language, (root) =>
      importStatementsFromTree(source, language, root),
    );
    importStatementPromises.set(key, statements);
    if (importStatementPromises.size > IMPORT_PARSE_CACHE_LIMIT) {
      const oldest = importStatementPromises.keys().next().value;
      if (oldest) importStatementPromises.delete(oldest);
    }
  }
  return statements;
}

/** Flattens client-side import statements into navigable symbol references. */
async function parseTreeSitterImportReferences(
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
    void parse(source, language)
      .then((parsed) => {
        if (current) setItems(parsed);
      })
      .catch(() => {
        if (current) setItems([]);
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
