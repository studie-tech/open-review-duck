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

await Parser.init({
  locateFile: () => join(assetDirectory, "tree-sitter.wasm"),
});

const MAXIMUM_CACHED_LANGUAGES =
  process.env.NODE_ENV === "test" ? Object.keys(grammarAssets).length : 8;
const languages = new Map<TreeSitterLanguage, Language>();
const pendingLanguages = new Map<TreeSitterLanguage, Promise<Language>>();

/** Loads only requested grammars and keeps a bounded least-recently-used cache. */
export async function prepareTreeSitterLanguages(
  requested: Iterable<TreeSitterLanguage>,
) {
  const requestedSet = new Set(requested);
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
  trimLanguageCache(requestedSet);
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
  const requestedSet = new Set(requested);
  await prepareTreeSitterLanguages(requestedSet);
  try {
    return await operation();
  } finally {
    trimLanguageCache();
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
export function parseSource(language: TreeSitterLanguage, source: string) {
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

/** Executes a callback with a syntax tree and always releases Wasm memory. */
export function withSyntaxTree<T>(
  language: TreeSitterLanguage,
  source: string,
  callback: (tree: Tree) => T,
) {
  const tree = parseSource(language, source);
  try {
    return callback(tree);
  } finally {
    tree.delete();
  }
}

/** Returns all named descendants, including the supplied root node. */
export function syntaxDescendants(root: SyntaxNode) {
  const nodes: SyntaxNode[] = [];
  const cursor = root.walk();
  let reachedRoot = false;
  while (!reachedRoot) {
    if (cursor.currentNode.isNamed) nodes.push(cursor.currentNode);
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
