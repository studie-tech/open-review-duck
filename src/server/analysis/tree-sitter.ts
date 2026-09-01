import { join } from "node:path";
import {
  Language,
  Parser,
  type Node as SyntaxNode,
  type Tree,
} from "web-tree-sitter";
import { grammarAssets, type SupportedLanguage } from "./types";

export type TreeSitterLanguage = Exclude<SupportedLanguage, "text">;

const assetDirectory = join(process.cwd(), "public", "tree-sitter");
let parserInitialization: Promise<void> | undefined;

/** Initializes the Tree-sitter runtime only when a request begins source analysis. */
function initializeParser() {
  parserInitialization ??= Parser.init({
    locateFile: () => join(assetDirectory, "tree-sitter.wasm"),
  });
  return parserInitialization;
}

const MAXIMUM_CACHED_LANGUAGES =
  process.env.NODE_ENV === "test" ? Object.keys(grammarAssets).length : 8;
const languages = new Map<TreeSitterLanguage, Language>();
const pendingLanguages = new Map<TreeSitterLanguage, Promise<Language>>();
const activeLanguageCounts = new Map<TreeSitterLanguage, number>();
const grammarDependencies: Partial<
  Record<TreeSitterLanguage, readonly TreeSitterLanguage[]>
> = {
  makefile: ["shell"],
};

/** Expands requested grammars with parsers used transitively during analysis. */
function requiredLanguages(requested: Iterable<TreeSitterLanguage>) {
  const required = new Set(requested);
  const pending = [...required];
  while (pending.length > 0) {
    const language = pending.shift();
    if (!language) continue;
    for (const dependency of grammarDependencies[language] ?? []) {
      if (required.has(dependency)) continue;
      required.add(dependency);
      pending.push(dependency);
    }
  }
  return required;
}

/** Returns every grammar protected by an active analysis operation. */
function activeLanguages() {
  return new Set(activeLanguageCounts.keys());
}

/** Acquires shared grammar leases for one analysis operation. */
function acquireLanguages(requested: Set<TreeSitterLanguage>) {
  for (const language of requested) {
    activeLanguageCounts.set(
      language,
      (activeLanguageCounts.get(language) ?? 0) + 1,
    );
  }
}

/** Releases shared grammar leases after one analysis operation. */
function releaseLanguages(requested: Set<TreeSitterLanguage>) {
  for (const language of requested) {
    const count = activeLanguageCounts.get(language) ?? 0;
    if (count <= 1) activeLanguageCounts.delete(language);
    else activeLanguageCounts.set(language, count - 1);
  }
}

/** Loads only requested grammars and keeps a bounded least-recently-used cache. */
export async function prepareTreeSitterLanguages(
  requested: Iterable<TreeSitterLanguage>,
) {
  await initializeParser();
  const requestedSet = requiredLanguages(requested);
  for (const language of requestedSet) {
    const cached = languages.get(language);
    if (cached) {
      languages.delete(language);
      languages.set(language, cached);
      continue;
    }
    let pending = pendingLanguages.get(language);
    if (!pending) {
      const fileName = grammarAssets[language];
      if (!fileName)
        throw new Error(`Missing tree-sitter grammar for ${language}`);
      pending = Language.load(join(assetDirectory, fileName));
      pendingLanguages.set(language, pending);
    }
    const grammar = await pending;
    pendingLanguages.delete(language);
    languages.set(language, grammar);
  }
  trimLanguageCache(activeLanguages());
}

/** Reports the bounded warm grammar set for diagnostics and bundle tests. */
export function loadedTreeSitterLanguages() {
  return [...languages.keys()];
}

/** Runs one operation with all requested grammars loaded, then trims the warm cache. */
export async function withPreparedTreeSitterLanguages<T>(
  requested: Iterable<TreeSitterLanguage>,
  operation: () => T | Promise<T>,
) {
  const requestedSet = requiredLanguages(requested);
  acquireLanguages(requestedSet);
  try {
    await prepareTreeSitterLanguages(requestedSet);
    return await operation();
  } finally {
    releaseLanguages(requestedSet);
    trimLanguageCache(activeLanguages());
    if (activeLanguageCounts.size === 0) releaseCachedSyntaxTrees();
  }
}

/** Evicts least-recently-used grammars that are not active in this operation. */
function trimLanguageCache(protectedLanguages = new Set<TreeSitterLanguage>()) {
  for (const language of languages.keys()) {
    if (languages.size <= MAXIMUM_CACHED_LANGUAGES) return;
    if (!protectedLanguages.has(language)) languages.delete(language);
  }
}

if (process.env.NODE_ENV === "test") {
  await prepareTreeSitterLanguages(
    Object.keys(grammarAssets) as TreeSitterLanguage[],
  );
}

/** Parses source with the production grammar registered for its language. */
function parseSource(language: TreeSitterLanguage, source: string) {
  const grammar = languages.get(language);
  if (!grammar) {
    throw new Error(
      `Tree-sitter grammar ${language} was not prepared before analysis`,
    );
  }
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error(`Tree-sitter did not produce a ${language} tree`);
  return tree;
}

interface CachedSyntaxTree {
  tree: Tree;
  bytes: number;
  borrowed: number;
}

/**
 * Bounds the Wasm memory held by reusable syntax trees.
 *
 * Analysis parses the same text repeatedly — a file is read by the declaration
 * extractor, the import scanner, the symbol-occurrence stream and the semantic
 * hash, and each extracted declaration is then hashed from the same bytes its
 * container was parsed from. Retaining the parse for source already seen turns
 * those repeats into lookups. The budget is expressed in source bytes, which
 * scales with tree size, and it is a small fraction of one pull request's
 * source so the cache stays a working set rather than a second copy of the diff.
 */
const MAXIMUM_CACHED_PARSE_BYTES = 2_000_000;
const cachedTrees = new Map<string, CachedSyntaxTree>();
let cachedParseBytes = 0;

/** Discards one cached parse and frees the Wasm memory behind it. */
function evictCachedTree(key: string, entry: CachedSyntaxTree) {
  cachedTrees.delete(key);
  cachedParseBytes -= entry.bytes;
  entry.tree.delete();
}

/** Evicts least-recently-used parses that no traversal is still reading. */
function trimParseCache() {
  for (const [key, entry] of cachedTrees) {
    if (cachedParseBytes <= MAXIMUM_CACHED_PARSE_BYTES) return;
    if (entry.borrowed === 0) evictCachedTree(key, entry);
  }
}

/** Frees every retained parse once no analysis operation is running. */
function releaseCachedSyntaxTrees() {
  for (const [key, entry] of cachedTrees) {
    if (entry.borrowed === 0) evictCachedTree(key, entry);
  }
}

/**
 * Executes a callback with the syntax tree for one source, reusing the parse.
 *
 * A tree is a pure function of its grammar and its bytes, so the same source
 * always yields the same tree and sharing one cannot change a result. The entry
 * records how many traversals are reading it, which keeps a reused tree — and a
 * tree a nested traversal re-entered — alive until every reader has finished.
 */
export function withSyntaxTree<T>(
  language: TreeSitterLanguage,
  source: string,
  callback: (tree: Tree) => T,
) {
  const key = `${language}\0${source}`;
  const cached = cachedTrees.get(key);
  // Re-inserting moves the entry to the most-recently-used end of the map.
  if (cached) cachedTrees.delete(key);
  const entry = cached ?? {
    tree: parseSource(language, source),
    bytes: Buffer.byteLength(source),
    borrowed: 0,
  };
  if (!cached) cachedParseBytes += entry.bytes;
  cachedTrees.set(key, entry);
  entry.borrowed += 1;
  try {
    return callback(entry.tree);
  } finally {
    entry.borrowed -= 1;
    trimParseCache();
  }
}

/** Returns all named descendants, including the supplied root node. */
export function syntaxDescendants(root: SyntaxNode) {
  const nodes: SyntaxNode[] = [];
  const cursor = root.walk();
  let reachedRoot = false;
  while (!reachedRoot) {
    // Every read of the cursor marshals a fresh node across the Wasm boundary,
    // which is the most-executed operation in analysis, so each visited node is
    // materialized once and reused.
    const node = cursor.currentNode;
    if (node.isNamed) nodes.push(node);
    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;
    while (true) {
      if (!cursor.gotoParent()) {
        reachedRoot = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
  }
  cursor.delete();
  return nodes;
}

/** Returns the exact UTF-16 source range represented by a syntax node. */
export function nodeText(source: string, node: SyntaxNode) {
  return source.slice(node.startIndex, node.endIndex);
}

/**
 * Reports the one-based lines that only terminate constructs opened earlier,
 * such as a lone `});`, `}`, `end`, or `fi`.
 *
 * A line qualifies when every token starting on it is an anonymous grammar
 * token — punctuation or a keyword, never an identifier, literal, or comment —
 * whose parent construct started on an earlier line. That makes the test purely
 * structural and therefore identical for all grammars: the line closes syntax
 * without introducing any, so it belongs to the construct it terminates rather
 * than standing alone. Lines that open a construct (`} else {`) keep a token
 * whose parent starts on the same line and are excluded, as are lines carrying
 * no token at all, such as the interior of a multi-line literal.
 */
export function blockCloserLines(language: TreeSitterLanguage, source: string) {
  return withSyntaxTree(language, source, (tree) => {
    const rows = new Map<number, boolean>();
    const cursor = tree.rootNode.walk();
    let reachedRoot = false;
    while (!reachedRoot) {
      const node = cursor.currentNode;
      if (node.childCount === 0) {
        const row = node.startPosition.row;
        const closesEnclosing =
          !node.isNamed &&
          node.parent !== null &&
          node.parent.startPosition.row < row;
        rows.set(row, (rows.get(row) ?? true) && closesEnclosing);
      }
      if (cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) continue;
      while (true) {
        if (!cursor.gotoParent()) {
          reachedRoot = true;
          break;
        }
        if (cursor.gotoNextSibling()) break;
      }
    }
    cursor.delete();
    return new Set(
      [...rows].flatMap(([row, closesEnclosing]) =>
        closesEnclosing ? [row + 1] : [],
      ),
    );
  });
}
