import { useEffect, useState } from "react";
import type { Language, Parser, Node as SyntaxNode } from "web-tree-sitter";
import {
  grammarAssets,
  type SupportedLanguage,
  supportedLanguages,
} from "~/server/analysis/types";

export interface SyntaxToken {
  className: string;
  text: string;
  from: number;
  to: number;
}

export interface HighlightedLine {
  text: string;
  tokens: SyntaxToken[];
}

const parserLanguages = supportedLanguages.filter(
  (language): language is Exclude<SupportedLanguage, "text"> =>
    language !== "text",
);

const parserLanguageSet = new Set<string>(parserLanguages);
const languagePromises = new Map<string, Promise<Language>>();
const highlightPromises = new Map<string, Promise<HighlightedLine[]>>();
type ClientTreeSitterRuntime = {
  Language: typeof Language;
  Parser: typeof Parser;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __openReviewDuckTreeSitter?: ClientTreeSitterRuntime;
  __openReviewDuckTreeSitterAssetRoot?: string;
};
let runtimePromise: Promise<ClientTreeSitterRuntime> | undefined;
let initializationPromise: Promise<ClientTreeSitterRuntime> | undefined;

/** Resolves a grammar asset from the application's prepared public directory. */
function assetPath(fileName: string) {
  return runtimeGlobal.__openReviewDuckTreeSitterAssetRoot
    ? `${runtimeGlobal.__openReviewDuckTreeSitterAssetRoot}/${fileName}`
    : `/tree-sitter/${fileName}`;
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
  initializationPromise ??= loadRuntime().then(async (runtime) => {
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

const keywords = new Set([
  "abstract",
  "alias",
  "and",
  "as",
  "async",
  "await",
  "begin",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "do",
  "else",
  "elseif",
  "elsif",
  "end",
  "enum",
  "except",
  "export",
  "extends",
  "extern",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "foreach",
  "from",
  "fun",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "internal",
  "is",
  "lambda",
  "let",
  "local",
  "match",
  "mod",
  "module",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "operator",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "record",
  "repeat",
  "require",
  "rescue",
  "return",
  "sealed",
  "static",
  "struct",
  "switch",
  "then",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typedef",
  "union",
  "unless",
  "until",
  "use",
  "using",
  "val",
  "var",
  "virtual",
  "when",
  "where",
  "while",
  "with",
  "yield",
]);

const builtinTypes = new Set([
  "any",
  "bool",
  "boolean",
  "byte",
  "char",
  "decimal",
  "double",
  "float",
  "int",
  "integer",
  "long",
  "never",
  "number",
  "object",
  "short",
  "str",
  "string",
  "symbol",
  "uint",
  "ulong",
  "unknown",
  "ushort",
  "void",
]);

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

/** Maps a Tree-sitter leaf token to the application's syntax class. */
function tokenClass(node: SyntaxNode, source: string) {
  const value = source.slice(node.startIndex, node.endIndex);
  const lower = value.toLowerCase();
  const types = ancestors(node);
  if (types.some((type) => type.includes("comment"))) return "tok-comment";
  if (types.some((type) => type.startsWith("preproc"))) return "tok-meta";
  if (types.some((type) => type.includes("keyword"))) return "tok-keyword";
  if (
    types.some(
      (type) =>
        type.includes("string") ||
        type.includes("heredoc") ||
        type.includes("template") ||
        type === "char_literal" ||
        type === "character",
    )
  ) {
    return types.some((type) => type.includes("formatted_string")) ||
      /^f["']/i.test(value)
      ? "tok-string2"
      : "tok-string";
  }
  if (
    /^(?:0[xob])?[\d_]+(?:\.[\d_]+)?(?:e[+-]?[\d_]+)?$/i.test(value) &&
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
  if (keywords.has(lower)) {
    return lower === "true" || lower === "false" ? "tok-bool" : "tok-keyword";
  }
  if (builtinTypes.has(lower)) return "tok-typeName";
  if (
    node.type.includes("type_identifier") ||
    node.type.includes("predefined_type") ||
    node.type.includes("primitive_type") ||
    /^[A-Z][\w$]*$/.test(value)
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
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return "tok-variableName";
  if (/^\s+$/.test(value)) return "";
  return "tok-operator";
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

/** Splits unparsed source into unstyled highlighted lines. */
function plainLines(source: string) {
  let offset = 0;
  return source.split("\n").map((text) => {
    const line: HighlightedLine = {
      text,
      tokens: text
        ? [{ className: "", text, from: offset, to: offset + text.length }]
        : [],
    };
    offset += text.length + 1;
    return line;
  });
}

/** Projects classified syntax leaves onto line-local token spans. */
function highlightedLines(source: string, root: SyntaxNode) {
  const spans = leafNodes(root)
    .map((node) => ({
      from: node.startIndex,
      to: node.endIndex,
      className: tokenClass(node, source),
    }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const lines: HighlightedLine[] = [];
  let absoluteOffset = 0;
  for (const text of source.split("\n")) {
    const lineStart = absoluteOffset;
    const lineEnd = lineStart + text.length;
    const tokens: SyntaxToken[] = [];
    let cursor = lineStart;
    for (const span of spans) {
      const from = Math.max(lineStart, span.from);
      const to = Math.min(lineEnd, span.to);
      if (to <= from) continue;
      if (from > cursor) {
        tokens.push({
          className: "",
          text: source.slice(cursor, from),
          from: cursor,
          to: from,
        });
      }
      const previous = tokens.at(-1);
      const value = source.slice(from, to);
      if (previous?.className === span.className && previous.to === from) {
        previous.text += value;
        previous.to = to;
      } else {
        tokens.push({ className: span.className, text: value, from, to });
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < lineEnd) {
      tokens.push({
        className: "",
        text: source.slice(cursor, lineEnd),
        from: cursor,
        to: lineEnd,
      });
    }
    lines.push({ text, tokens });
    absoluteOffset = lineEnd + 1;
  }
  return lines;
}

/** Parses and syntax-highlights source using its tree-sitter grammar. */
export async function highlightSource(source: string, language: string) {
  if (language === "text") return plainLines(source);
  return withClientSyntaxTree(source, language, (root) =>
    highlightedLines(source, root),
  );
}

/** Returns a bounded cached highlighting operation for source and language. */
function highlightedSourcePromise(source: string, language: string) {
  const key = `${language}\0${source}`;
  let promise = highlightPromises.get(key);
  if (!promise) {
    promise = highlightSource(source, language);
    highlightPromises.set(key, promise);
    if (highlightPromises.size > 40) {
      const oldest = highlightPromises.keys().next().value;
      if (oldest) highlightPromises.delete(oldest);
    }
  }
  return promise;
}

/** React binding that updates once the lazily loaded grammar has parsed source. */
export function useHighlightedSource(source: string, language: string) {
  const [lines, setLines] = useState<HighlightedLine[]>(() =>
    plainLines(source),
  );
  useEffect(() => {
    let current = true;
    setLines(plainLines(source));
    void highlightedSourcePromise(source, language)
      .then((highlighted) => {
        if (current) setLines(highlighted);
      })
      .catch(() => {
        if (current) setLines(plainLines(source));
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
