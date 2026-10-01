import type { Node as SyntaxNode } from "web-tree-sitter";

const NAME_FIELDS = new Set([
  "name",
  "declarator",
  "alias",
  "as",
  "key",
  "left",
  "target",
]);

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "simple_identifier",
  "constant",
  "name",
  "ident",
]);

const IMPORTISH_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "import_header",
  "import_directive",
  "import_or_export",
  "using_directive",
  "use_declaration",
  "namespace_use_declaration",
  "preproc_include",
  "preproc_import",
]);

/** Returns the exact source represented by a syntax node. */
function syntaxText(source: string, node: SyntaxNode) {
  return source.slice(node.startIndex, node.endIndex);
}

/** Returns whether a node type is an identifier token across common grammars. */
function isIdentifierType(type: string) {
  return (
    IDENTIFIER_TYPES.has(type) ||
    type.endsWith("_identifier") ||
    type.endsWith("_name")
  );
}

/** Returns whether two nodes occupy the same source range. */
function sameNode(left: SyntaxNode, right: SyntaxNode) {
  return (
    left.startIndex === right.startIndex && left.endIndex === right.endIndex
  );
}

/** Returns whether a node is part of an import rather than a declaration. */
function isInsideImport(node: SyntaxNode) {
  for (let current = node.parent; current; current = current.parent) {
    if (IMPORTISH_TYPES.has(current.type) || current.type.includes("import")) {
      return current.type !== "export_statement";
    }
  }
  return false;
}

/** Returns whether an ancestor contains a descendant node. */
function containsNode(ancestor: SyntaxNode, node: SyntaxNode) {
  return (
    node.startIndex >= ancestor.startIndex &&
    node.endIndex <= ancestor.endIndex &&
    !sameNode(ancestor, node)
  );
}

/** Returns the field name a child occupies on its parent, if the grammar has one. */
function fieldNameOnParent(node: SyntaxNode) {
  const parent = node.parent;
  if (!parent) return undefined;
  for (const field of NAME_FIELDS) {
    const named = parent.childForFieldName(field);
    if (named && (sameNode(named, node) || containsNode(named, node))) {
      return field;
    }
  }
  return undefined;
}

/** Returns whether a node is the name that a declaration binds. */
function isDeclarationName(node: SyntaxNode) {
  if (isInsideImport(node)) return false;
  const field = fieldNameOnParent(node);
  if (field && NAME_FIELDS.has(field)) return true;
  const parent = node.parent;
  if (!parent) return false;
  const type = parent.type.toLowerCase();
  const first = parent.namedChildren[0];
  return (
    (type.includes("declarator") ||
      type.includes("declaration") ||
      type.includes("definition") ||
      type.includes("specifier")) &&
    first != null &&
    sameNode(first, node)
  );
}

/** Walks every named descendant and invokes visit until it returns a value. */
function visitNamed<T>(
  root: SyntaxNode,
  visit: (node: SyntaxNode) => T | undefined,
): T | undefined {
  const cursor = root.walk();
  let complete = false;
  try {
    while (!complete) {
      if (cursor.nodeIsNamed) {
        const found = visit(cursor.currentNode);
        if (found !== undefined) return found;
      }
      if (cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) continue;
      while (true) {
        if (!cursor.gotoParent()) {
          complete = true;
          break;
        }
        if (cursor.gotoNextSibling()) break;
      }
    }
    return undefined;
  } finally {
    cursor.delete();
  }
}

/** Returns the first default export in a syntax tree. */
function defaultExportLine(
  source: string,
  root: SyntaxNode,
  startLine: number,
) {
  return visitNamed(root, (node) => {
    if (
      node.type !== "export_statement" &&
      node.type !== "export_declaration"
    ) {
      return undefined;
    }
    return node.children.some(
      (child) => child !== null && !child.isNamed && child.type === "default",
    ) || /\bexport\s+default\b/.test(syntaxText(source, node))
      ? startLine + node.startPosition.row
      : undefined;
  });
}

/**
 * Finds the first declaration of a name by walking a Tree-sitter tree.
 *
 * Grammars expose declared names through a `name` field or an identifier
 * sitting on a declarator. That is enough to locate functions, types,
 * constants, and re-exports without language-specific regular expressions.
 */
export function findDeclarationLineFromTree(
  source: string,
  root: SyntaxNode,
  imported: string,
  startLine = 1,
) {
  if (imported === "*") return undefined;
  if (imported === "default") {
    return defaultExportLine(source, root, startLine);
  }
  return visitNamed(root, (node) => {
    if (!isIdentifierType(node.type)) return undefined;
    if (syntaxText(source, node) !== imported) return undefined;
    return isDeclarationName(node)
      ? startLine + node.startPosition.row
      : undefined;
  });
}

/**
 * Finds a same-file re-export that forwards the imported name elsewhere.
 *
 * Barrel files declare no body of their own. Following the export's source
 * specifier one hop is how a hover reaches the real declaration.
 */
export function findReexportFromTree(
  source: string,
  root: SyntaxNode,
  imported: string,
): { imported: string; specifier: string } | undefined {
  if (imported === "*") return undefined;
  return visitNamed(root, (node) => {
    if (
      node.type !== "export_statement" &&
      node.type !== "export_declaration"
    ) {
      return undefined;
    }
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) return undefined;
    const specifier = unquote(syntaxText(source, sourceNode));
    const text = syntaxText(source, node);
    if (/export\s+\*\s+from/.test(text)) {
      return { imported, specifier };
    }
    return visitNamed(node, (child) => {
      if (child.type !== "export_specifier") return undefined;
      const nameNode =
        child.childForFieldName("name") ?? child.namedChildren[0];
      const aliasNode = child.childForFieldName("alias");
      if (!nameNode) return undefined;
      const exported = syntaxText(source, aliasNode ?? nameNode);
      return exported === imported
        ? { imported: syntaxText(source, nameNode), specifier }
        : undefined;
    });
  });
}

/** Removes one matching quote pair from a module specifier literal. */
function unquote(value: string) {
  const quote = value[0];
  const closing =
    quote === '"' || quote === "'" || quote === "`" ? quote : undefined;
  return closing && value.endsWith(closing) ? value.slice(1, -1) : value;
}
