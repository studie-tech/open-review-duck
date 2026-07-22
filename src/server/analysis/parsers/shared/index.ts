import type { SyntaxNode, Tree } from "@lezer/common";
import { semanticSource, sha256, stableReviewKey } from "../../hash";
import type {
  AnalyzedUnit,
  SourceFile,
  SupportedLanguage,
  UnitKind,
} from "../../types";

export type SourceRange = Pick<SyntaxNode, "from" | "to">;
/** Returns a syntax-node identity that distinguishes overlapping syntax ranges. */
export function nodeKey(node: SyntaxNode) {
  return `${node.name}:${node.from}:${node.to}`;
}

/** Returns the one-based line number for a source offset. */
export const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;
/** Returns the source text covered by a syntax-tree node. */
export const textOf = (source: string, node: SourceRange) =>
  source.slice(node.from, node.to);

/** Collects syntax-tree descendants whose node names match the requested set. */
export function descendants(tree: Tree, names: Set<string>) {
  return nodeDescendants(tree.topNode, names);
}

/** Collects matching descendants below an arbitrary syntax node. */
export function nodeDescendants(node: SyntaxNode, names: Set<string>) {
  const found: SyntaxNode[] = [];
  const cursor = node.cursor();
  do {
    if (names.has(cursor.name)) found.push(cursor.node);
  } while (cursor.next() && cursor.from < node.to);
  return found;
}

/** Extracts the declared identifier from a syntax-tree node. */
export function identifier(source: string, node: SyntaxNode) {
  const declaration = textOf(source, node);
  const declaredName =
    /(?:function|class|def|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)|\btype\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
      .exec(declaration)
      ?.slice(1)
      .find(Boolean);
  if (declaredName) return declaredName;
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (
        [
          "VariableName",
          "VariableDefinition",
          "PropertyName",
          "PropertyDefinition",
          "Identifier",
          "TypeDefinition",
        ].includes(cursor.name)
      )
        return textOf(source, cursor.node);
    } while (cursor.nextSibling());
  }
  return "anonymous";
}

/** Collects identifiers referenced by a syntax-tree node. */
export function references(
  source: string,
  node: SyntaxNode,
  ownName: string | readonly string[],
  rangeEnd = node.to,
  rangeStart = node.from,
) {
  const found = new Set<string>();
  const ownNames = new Set(typeof ownName === "string" ? [ownName] : ownName);
  const cursor = node.cursor();
  do {
    if (cursor.from >= rangeStart && cursor.name === "MemberExpression") {
      const qualified = textOf(source, cursor.node)
        .match(/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+/)?.[0]
        ?.replace(/\s+/g, "");
      if (qualified && !ownNames.has(qualified)) found.add(qualified);
    }
    if (
      cursor.from >= rangeStart &&
      [
        "VariableName",
        "VariableDefinition",
        "PropertyName",
        "PropertyDefinition",
        "Identifier",
        "TypeName",
      ].includes(cursor.name)
    ) {
      const name = textOf(source, cursor.node);
      if (!ownNames.has(name)) found.add(name);
    }
  } while (cursor.next() && cursor.from < rangeEnd);
  return [...found];
}

/** Builds a declaration name qualified by its enclosing scopes. */
export function qualifiedName(source: string, node: SyntaxNode, name: string) {
  const scopes: string[] = [];
  let parent = node.parent;
  while (parent) {
    if (
      [
        "ClassDeclaration",
        "ClassDefinition",
        "InterfaceDeclaration",
        "NamespaceDeclaration",
        "FunctionDeclaration",
        "FunctionDefinition",
      ].includes(parent.name)
    ) {
      const parentName = identifier(source, parent);
      if (parentName !== "anonymous") scopes.unshift(parentName);
    }
    parent = parent.parent;
  }
  return [...scopes, name].join(".");
}

/** Checks whether a variable declaration belongs to module scope. */
export function isModuleLevelVariable(node: SyntaxNode) {
  if (node.name !== "VariableDeclaration") return true;
  if (node.parent?.name === "Script") return true;
  return (
    node.parent?.name === "ExportDeclaration" &&
    node.parent.parent?.name === "Script"
  );
}

/** Finds the first top-level semicolon after a JavaScript declaration. */
function javascriptStatementEnd(source: string, from: number) {
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return index + 1;
    }
  }
  return undefined;
}

/**
 * Expands a declaration to its export wrapper and repairs parser-truncated
 * module variables using JavaScript's balanced statement boundary.
 */
export function javascriptDeclarationNode(
  source: string,
  node: SyntaxNode,
): SourceRange {
  const declaration =
    node.parent?.name === "ExportDeclaration" ? node.parent : node;
  if (node.name !== "VariableDeclaration") return declaration;
  if (source.slice(declaration.from, declaration.to).trimEnd().endsWith(";")) {
    return declaration;
  }
  const statementEnd = javascriptStatementEnd(source, declaration.from);
  if (!statementEnd || statementEnd <= declaration.to) return declaration;
  const continuation = source.slice(declaration.to, statementEnd);
  return /^\s+(?:is|asserts)\b[\s\S]*?=>/.test(continuation)
    ? { from: declaration.from, to: statementEnd }
    : declaration;
}

/** Expands a source range to include an immediately preceding JSDoc block. */
export function withLeadingDocumentation(source: string, range: SourceRange) {
  const before = source.slice(0, range.from);
  const withoutWhitespace = before.replace(/\s+$/, "");
  if (!withoutWhitespace.endsWith("*/")) return range;
  const commentStart = withoutWhitespace.lastIndexOf("/*");
  if (commentStart < 0 || !withoutWhitespace.startsWith("/**", commentStart)) {
    return range;
  }
  return { from: commentStart, to: range.to };
}

/** Returns a declaration signature without its leading documentation block. */
export function unitSignature(source: string) {
  const declaration = source.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
  return declaration.split(/[\n{]/, 1)[0]?.trim();
}

/** Converts a syntax-tree declaration into a review unit. */
export function makeUnit(
  file: SourceFile,
  language: SupportedLanguage,
  kind: UnitKind,
  name: string,
  node: SourceRange,
  dependencies: string[],
  complexity: number,
  stableName = name,
): Omit<AnalyzedUnit, "depth" | "reviewOrder"> {
  const reviewRange = withLeadingDocumentation(file.content, node);
  const source = textOf(file.content, reviewRange);
  const changeType = file.changeType ?? "modified";
  return {
    stableKey: stableReviewKey(file.path, kind, stableName),
    path: file.path,
    language,
    kind,
    name,
    signature: unitSignature(source),
    startLine: lineAt(file.content, reviewRange.from),
    endLine: lineAt(file.content, reviewRange.to),
    source,
    contentHash: sha256(source),
    semanticHash: sha256(`${changeType}:${semanticSource(source, language)}`),
    changeType,
    complexity,
    dependencies,
  };
}

/** Returns direct syntax children, optionally restricted to named node types. */
export function directChildren(node: SyntaxNode, names?: ReadonlySet<string>) {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!names || names.has(child.name)) found.push(child);
  }
  return found;
}

/** Checks whether a syntax subtree contains a node with a requested name. */
export function containsNode(node: SyntaxNode, names: ReadonlySet<string>) {
  const cursor = node.cursor();
  do {
    if (names.has(cursor.name)) return true;
  } while (cursor.next() && cursor.from < node.to);
  return false;
}

/** Returns a call expression's callee as dotted identifier segments. */
export function callSegments(source: string, node: SyntaxNode) {
  const callee = node.firstChild;
  if (!callee) return [];
  const head = textOf(source, callee).match(
    /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/,
  )?.[0];
  return head?.split(".").map((segment) => segment.trim()) ?? [];
}

/** Returns the direct argument list for a call expression. */
export function callArguments(node: SyntaxNode) {
  return directChildren(node, new Set(["ArgList"]))[0];
}

/** Decodes a static string or template literal for a test display name. */
export function staticLabel(source: string, node: SyntaxNode) {
  const raw = textOf(source, node).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith("`") && raw.endsWith("`") && !raw.includes("${")))
  ) {
    return raw
      .slice(1, -1)
      .replace(/\\([\\'"`])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }
  return undefined;
}

/** Extracts a readable title from a test call's arguments. */
export function testCallLabel(source: string, node: SyntaxNode) {
  const argumentsNode = callArguments(node);
  if (!argumentsNode) return undefined;
  const literal = directChildren(
    argumentsNode,
    new Set(["String", "TemplateString"]),
  )[0];
  const literalLabel = literal ? staticLabel(source, literal) : undefined;
  if (literalLabel) return literalLabel;
  const object = directChildren(
    argumentsNode,
    new Set(["ObjectExpression"]),
  )[0];
  if (object) {
    const objectName = textOf(source, object).match(
      /\bname\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/,
    )?.[2];
    if (objectName) return objectName.replace(/\s+/g, " ").trim();
  }
  const dynamicArgument = directChildren(argumentsNode).find(
    (child) =>
      ![
        "(",
        ")",
        ",",
        "ArrowFunction",
        "FunctionExpression",
        "ObjectExpression",
      ].includes(child.name),
  );
  if (dynamicArgument) {
    const dynamic = textOf(source, dynamicArgument).replace(/\s+/g, " ").trim();
    if (dynamic)
      return dynamic.length > 60 ? `${dynamic.slice(0, 57)}…` : dynamic;
  }
  return undefined;
}

/** Checks whether a call directly receives an executable callback. */
export function hasTestCallback(node: SyntaxNode) {
  const argumentsNode = callArguments(node);
  return Boolean(
    argumentsNode &&
      directChildren(
        argumentsNode,
        new Set(["ArrowFunction", "FunctionExpression"]),
      ).length,
  );
}

/** Checks whether a call supplies at least one argument of any kind. */
export function hasCallArgument(node: SyntaxNode) {
  const argumentsNode = callArguments(node);
  return Boolean(
    argumentsNode &&
      directChildren(argumentsNode).some(
        (child) => !["(", ")", ","].includes(child.name),
      ),
  );
}

/** Recognizes conventional test-file paths without requiring framework imports. */
export function isTestLikePath(path: string) {
  const normalized = path.toLowerCase().replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/.test(normalized) ||
    /(?:\.|_)(?:test|spec)\.[^/]+$/.test(normalized) ||
    /(?:\.|_)bench\.[^/]+$/.test(normalized) ||
    /(?:^|\/)test_[^/]+\.py$/.test(normalized)
  );
}

/** Maps imported test-framework bindings back to their canonical role names. */

export function isSourceTrivia(source: string) {
  return /^(?:\s|#![^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(
    source,
  );
}

/** Groups imports separated only by whitespace or comments into one unit. */
