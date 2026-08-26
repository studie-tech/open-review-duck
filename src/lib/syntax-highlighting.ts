import { useEffect, useState } from "react";
import type { Language, Parser, Node as SyntaxNode } from "web-tree-sitter";
import {
  grammarAssets,
  type SupportedLanguage,
  supportedLanguages,
} from "~/server/analysis/types";
import {
  type HighlightedLine,
  lexicalValueClass,
  linesFromSpans,
  numericLiteralPattern,
  plainLines,
  type TokenSpan,
} from "./highlight-tokens";
import { lexicalLines } from "./lexical-highlighting";

export type { HighlightedLine };

const parserLanguages = supportedLanguages.filter(
  (language): language is Exclude<SupportedLanguage, "text"> =>
    language !== "text",
);

const parserLanguageSet = new Set<string>(parserLanguages);
const languagePromises = new Map<string, Promise<Language>>();
// One review concept highlights every member plus both diff sides at once, so
// the bound has to exceed the largest concept or on-screen sources evict each
// other and are reparsed on every revisit.
const HIGHLIGHT_CACHE_LIMIT = 200;
const highlightPromises = new Map<string, Promise<HighlightedLine[]>>();
const highlightLines = new Map<string, HighlightedLine[]>();
type ClientTreeSitterRuntime = {
  Language: typeof Language;
  Parser: typeof Parser;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __openReviewDuckTreeSitter?: ClientTreeSitterRuntime;
  __openReviewDuckTreeSitterAssetRoot?: string;
  __openReviewDuckTreeSitterVersion?: string;
};
let runtimePromise: Promise<ClientTreeSitterRuntime> | undefined;
let initializationPromise: Promise<ClientTreeSitterRuntime> | undefined;
let idlePromise: Promise<void> | undefined;
// A busy or hidden tab may never report an idle period, so the deadline is what
// guarantees the grammar upgrade still arrives shortly after the page loads.
const GRAMMAR_IDLE_DEADLINE_MS = 2_000;

/**
 * Resolves a grammar asset from the application's prepared public directory.
 *
 * The loader publishes the identifier of the prepared asset set, and every URL
 * built after it has loaded carries that identifier, so the served files may be
 * cached immutably and still change the moment a grammar is rebuilt.
 */
function assetPath(fileName: string) {
  if (runtimeGlobal.__openReviewDuckTreeSitterAssetRoot) {
    return `${runtimeGlobal.__openReviewDuckTreeSitterAssetRoot}/${fileName}`;
  }
  const version = runtimeGlobal.__openReviewDuckTreeSitterVersion;
  return version
    ? `/tree-sitter/${fileName}?v=${version}`
    : `/tree-sitter/${fileName}`;
}

/**
 * Resolves once the document has loaded and the browser has spare time.
 *
 * Grammars are an upgrade over the lexical highlighting a reviewer already
 * sees, so they must never compete for bandwidth with the review's own data.
 */
function whenBrowserIdle() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve();
  }
  idlePromise ??= new Promise<void>((resolve) => {
    /** Waits for the first idle period, but never past the deadline. */
    const settle = () => {
      window.setTimeout(resolve, GRAMMAR_IDLE_DEADLINE_MS);
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => {
          resolve();
        });
      }
    };
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
  });
  return idlePromise;
}

/** Loads the browser runtime as a native module outside the application bundle. */
function loadRuntime() {
  if (runtimeGlobal.__openReviewDuckTreeSitter) {
    return Promise.resolve(runtimeGlobal.__openReviewDuckTreeSitter);
  }
  if (typeof document === "undefined") {
    return Promise.reject(
      new Error("The client Tree-sitter runtime is unavailable"),
    );
  }
  runtimePromise ??= new Promise<ClientTreeSitterRuntime>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-tree-sitter-runtime="open-review-duck"]',
    );
    const script = existing ?? document.createElement("script");
    /** Completes runtime loading after the native module initializes. */
    const loaded = () => {
      const runtime = runtimeGlobal.__openReviewDuckTreeSitter;
      if (runtime) resolve(runtime);
      else reject(new Error("Tree-sitter runtime module did not initialize"));
    };
    /** Reports a failed static runtime request. */
    const failed = () => {
      reject(new Error("Unable to load the Tree-sitter runtime module"));
    };
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.type = "module";
      script.src = assetPath("tree-sitter-browser-loader.js");
      script.dataset.treeSitterRuntime = "open-review-duck";
      document.head.append(script);
    }
  });
  return runtimePromise;
}

/** Initializes the shared browser Tree-sitter runtime once. */
function initializeRuntime() {
  initializationPromise ??= whenBrowserIdle()
    .then(loadRuntime)
    .then(async (runtime) => {
      await runtime.Parser.init({
        locateFile: () => assetPath("tree-sitter.wasm"),
      });
      return runtime;
    });
  return initializationPromise;
}

/** Lazily loads and caches one supported language grammar. */
async function grammarFor(language: string) {
  if (!parserLanguageSet.has(language)) {
    throw new Error(`Unsupported syntax language: ${language}`);
  }
  let grammar = languagePromises.get(language);
  if (!grammar) {
    grammar = initializeRuntime().then((runtime) =>
      runtime.Language.load(
        assetPath(grammarAssets[language as keyof typeof grammarAssets]),
      ),
    );
    languagePromises.set(language, grammar);
  }
  return grammar;
}

/** Runs a callback against a lazily loaded browser-compatible syntax tree. */
export async function withClientSyntaxTree<T>(
  source: string,
  language: string,
  callback: (root: SyntaxNode) => T,
) {
  const [runtime, grammar] = await Promise.all([
    initializeRuntime(),
    grammarFor(language),
  ]);
  const parser = new runtime.Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error(`Tree-sitter could not parse ${language}`);
  try {
    return callback(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Returns normalized ancestor types used for token classification. */
function ancestors(node: SyntaxNode) {
  const types: string[] = [];
  for (
    let current: SyntaxNode | null = node;
    current;
    current = current.parent
  ) {
    types.push(current.type.toLowerCase());
  }
  return types;
}

/**
 * Reports a Tree-sitter node that embeds evaluated code in a string.
 *
 * Grammars name these interpolation, substitution, or expansion nodes. The
 * walk stops inheriting the outer string class here so `${name}`, `#{name}`,
 * and f-string `{name}` highlight as code in every language that exposes them.
 */
export function isInterpolationContext(type: string) {
  return (
    type.includes("interpolation") ||
    type.includes("interpolated") ||
    type.includes("substitution") ||
    type === "expansion" ||
    type.endsWith("_expansion")
  );
}

/**
 * Reports a Tree-sitter reserved-word node, including SQL `keyword_create`.
 *
 * A bare "keyword" substring would also paint Python `keyword_argument`
 * values — imported constants used as `name=VALUE` — as keywords, which
 * both colours them wrong and drops them from definition hover.
 */
export function isKeywordContext(type: string) {
  if (type.includes("argument") || type.includes("parameter")) return false;
  return (
    type === "keyword" ||
    type.startsWith("keyword_") ||
    type.endsWith("_keyword")
  );
}

/**
 * Reports a Tree-sitter node that is itself string or template text.
 *
 * A bare "template" match would also paint C++ template parameters as
 * strings, so only template nodes that carry string or literal text count.
 */
export function isStringContext(type: string) {
  if (type === "char_literal" || type === "character") return true;
  if (type.includes("heredoc")) return true;
  if (type.includes("string")) return true;
  return (
    type.includes("template") &&
    (type.includes("literal") ||
      type.includes("chars") ||
      type.includes("fragment"))
  );
}

/** Maps a Tree-sitter leaf token to the application's syntax class. */
function tokenClass(node: SyntaxNode, source: string) {
  const value = source.slice(node.startIndex, node.endIndex);
  const types = ancestors(node);
  for (const type of types) {
    if (type.includes("comment")) return "tok-comment";
    // Embedded expressions keep the outer string from swallowing their
    // identifiers, calls, and nested quotes.
    if (isInterpolationContext(type)) break;
    if (type.startsWith("preproc")) return "tok-meta";
    if (isKeywordContext(type)) return "tok-keyword";
    if (isStringContext(type)) {
      return types.some((ancestor) => ancestor.includes("formatted_string")) ||
        /^f["']/i.test(value)
        ? "tok-string2"
        : "tok-string";
    }
  }
  if (
    numericLiteralPattern.test(value) &&
    types.some(
      (type) =>
        type.includes("number") ||
        type.includes("integer") ||
        type.includes("float") ||
        type.includes("literal"),
    )
  ) {
    return "tok-number";
  }
  // The token's own text decides keywords, booleans and capitalized type names
  // before the tree is consulted; only the remaining classes depend on nodes.
  const identified = lexicalValueClass(value);
  if (
    identified === "tok-keyword" ||
    identified === "tok-bool" ||
    identified === "tok-typeName"
  ) {
    return identified;
  }
  if (
    node.type.includes("type_identifier") ||
    node.type.includes("predefined_type") ||
    node.type.includes("primitive_type")
  ) {
    return "tok-typeName";
  }
  if (
    node.parent &&
    (node.parent.type.includes("function") ||
      node.parent.type.includes("method")) &&
    node.parent.childForFieldName("name")?.id === node.id
  ) {
    return "tok-function";
  }
  return identified;
}

/** Returns every concrete leaf token in source order. */
function leafNodes(root: SyntaxNode) {
  const leaves: SyntaxNode[] = [];
  const cursor = root.walk();
  let complete = false;
  while (!complete) {
    if (cursor.gotoFirstChild()) continue;
    const node = cursor.currentNode;
    if (node.endIndex > node.startIndex) leaves.push(node);
    if (cursor.gotoNextSibling()) continue;
    while (true) {
      if (!cursor.gotoParent()) {
        complete = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
  }
  cursor.delete();
  return leaves;
}

/** Projects classified syntax leaves onto line-local token spans. */
function highlightedLines(source: string, root: SyntaxNode) {
  const spans: TokenSpan[] = leafNodes(root)
    .map((node) => ({
      from: node.startIndex,
      to: node.endIndex,
      className: tokenClass(node, source),
    }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return linesFromSpans(source, spans);
}

/** Parses and syntax-highlights source using its tree-sitter grammar. */
export async function highlightSource(source: string, language: string) {
  if (language === "text") return plainLines(source);
  return withClientSyntaxTree(source, language, (root) =>
    highlightedLines(source, root),
  );
}

/** Identifies one highlighting result by its source and grammar. */
function highlightKey(source: string, language: string) {
  return `${language}\0${source}`;
}

/** Returns a bounded cached highlighting operation for source and language. */
function highlightedSourcePromise(source: string, language: string) {
  const key = highlightKey(source, language);
  let promise = highlightPromises.get(key);
  if (!promise) {
    promise = highlightSource(source, language).then((highlighted) => {
      if (highlightPromises.has(key)) highlightLines.set(key, highlighted);
      return highlighted;
    });
    highlightPromises.set(key, promise);
    if (highlightPromises.size > HIGHLIGHT_CACHE_LIMIT) {
      const oldest = highlightPromises.keys().next().value;
      if (oldest) {
        highlightPromises.delete(oldest);
        highlightLines.delete(oldest);
      }
    }
  }
  return promise;
}

/**
 * React binding that paints lexically first and upgrades to grammar output.
 * Sources highlighted earlier resolve from cache during render, so revisiting a
 * concept member neither reparses its grammar nor flashes unhighlighted code.
 * A reviewer can therefore read and sign off code before any grammar arrives.
 */
export function useHighlightedSource(source: string, language: string) {
  const [lines, setLines] = useState<HighlightedLine[]>(
    () =>
      highlightLines.get(highlightKey(source, language)) ??
      lexicalLines(source, language),
  );
  useEffect(() => {
    const cached = highlightLines.get(highlightKey(source, language));
    if (cached) {
      setLines(cached);
      return;
    }
    let current = true;
    const lexical = lexicalLines(source, language);
    setLines(lexical);
    void highlightedSourcePromise(source, language)
      .then((highlighted) => {
        if (current) setLines(highlighted);
      })
      .catch(() => {
        if (current) setLines(lexical);
      });
    return () => {
      current = false;
    };
  }, [language, source]);
  return lines;
}

/** Loads a grammar ahead of an anticipated navigation. */
export async function preloadSyntaxLanguage(language: string) {
  if (language !== "text") await grammarFor(language);
}

/** Checks whether syntax highlighting supports a language identifier. */
export function knownLanguage(language: string) {
  return supportedLanguages.includes(language as SupportedLanguage)
    ? (language as SupportedLanguage)
    : undefined;
}

/**
 * Names a language the grammars cover, or throws.
 *
 * `review_unit.language` is stored unconstrained, so a value that predates a
 * grammar being renamed or removed can reach the client. Callers that only
 * want to know whether a feature applies ask `knownLanguage` instead.
 */
export function supportedLanguage(language: string) {
  const known = knownLanguage(language);
  if (known) return known;
  throw new Error(`Unsupported review language: ${language}`);
}
