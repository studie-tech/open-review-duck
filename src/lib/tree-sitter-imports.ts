import type { Node as SyntaxNode } from "web-tree-sitter";
import type { TreeSitterLanguage } from "~/server/analysis/tree-sitter";
import type { ImportReference, ImportStatement } from "./import-navigation";

const statementTypes = {
  javascript: new Set(["import_statement"]),
  typescript: new Set(["import_statement"]),
  python: new Set(["import_statement", "import_from_statement"]),
  java: new Set(["package_declaration", "import_declaration"]),
  kotlin: new Set(["package_header", "import_header"]),
  csharp: new Set(["using_directive"]),
  c: new Set(["preproc_include"]),
  cpp: new Set(["preproc_include", "import_declaration"]),
  php: new Set([
    "namespace_use_declaration",
    "include_expression",
    "include_once_expression",
    "require_expression",
    "require_once_expression",
  ]),
  shell: new Set(["command"]),
  ruby: new Set(["call"]),
  rust: new Set(["use_declaration", "extern_crate_declaration", "mod_item"]),
  lua: new Set([
    "function_call",
    "variable_declaration",
    "assignment_statement",
  ]),
  go: new Set(["import_declaration"]),
  makefile: new Set(["include_directive"]),
  hcl: new Set(),
  css: new Set(["import_statement"]),
  dart: new Set(["import_or_export", "part_declaration"]),
  elisp: new Set(["feature_require"]),
  elixir: new Set(),
  elm: new Set(["import_clause"]),
  embedded_template: new Set(),
  html: new Set(),
  json: new Set(),
  objc: new Set(["preproc_include", "preproc_import"]),
  ocaml: new Set(["open_module", "include_module"]),
  ql: new Set(["importDirective"]),
  rescript: new Set(["open_statement", "include_statement"]),
  scala: new Set(["import_declaration", "export_declaration"]),
  solidity: new Set(["import_directive"]),
  swift: new Set(["import_declaration"]),
  systemrdl: new Set(),
  tlaplus: new Set(["extends", "instance"]),
  toml: new Set(),
  vue: new Set(),
  yaml: new Set(),
  zig: new Set(),
  sql: new Set(),
  markdown: new Set(),
  mdx: new Set(["mdx_esm_block"]),
  dockerfile: new Set(["from_instruction", "copy_instruction"]),
  graphql: new Set(),
  prisma: new Set(),
  protobuf: new Set(["import"]),
  xml: new Set(),
  scss: new Set(["import_statement", "use_statement", "forward_statement"]),
  svelte: new Set(),
  astro: new Set(),
  r: new Set(["namespace_operator"]),
  julia: new Set(["import_statement", "using_statement"]),
  haskell: new Set(["import"]),
  clojure: new Set(),
  erlang: new Set([
    "import_attribute",
    "include_attribute",
    "include_lib_attribute",
  ]),
  fsharp: new Set(["open_statement"]),
  powershell: new Set(["using_statement", "requires_statement"]),
  fortran: new Set(["use_statement", "include_statement"]),
  perl: new Set(["use_statement", "require_expression"]),
  groovy: new Set(["import_declaration"]),
  nix: new Set(),
  latex: new Set(["package_include", "class_include"]),
  systemverilog: new Set([
    "package_import_declaration",
    "include_compiler_directive",
  ]),
  assembly: new Set(["include"]),
} satisfies Record<TreeSitterLanguage, ReadonlySet<string>>;

/** Returns every named syntax node in depth-first source order. */
function descendants(root: SyntaxNode) {
  const nodes: SyntaxNode[] = [];
  const cursor = root.walk();
  let complete = false;
  while (!complete) {
    const node = cursor.currentNode;
    if (node.isNamed) nodes.push(node);
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
  cursor.delete();
  return nodes;
}

/** Returns the exact source represented by a syntax node. */
function syntaxText(source: string, node: SyntaxNode) {
  return source.slice(node.startIndex, node.endIndex);
}

/** Removes one matching quote or include-delimiter pair from a literal. */
function literalValue(source: string, node: SyntaxNode) {
  const raw = syntaxText(source, node);
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    "`": "`",
    "<": ">",
  };
  const closing = pairs[raw[0] ?? ""];
  return closing && raw.endsWith(closing) ? raw.slice(1, -1) : raw;
}

/** Builds a navigable import reference from an exact binding node. */
function reference(
  node: SyntaxNode,
  input: Omit<ImportReference, "from" | "to">,
): ImportReference {
  return {
    ...input,
    from: node.startIndex,
    to: node.endIndex,
  };
}

/** Extracts ECMAScript bindings directly from an import statement tree. */
function javascriptReferences(source: string, node: SyntaxNode) {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return [];
  const specifier = literalValue(source, sourceNode);
  const clause = node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null && child.type === "import_clause",
  );
  if (!clause) {
    return [
      reference(sourceNode, {
        specifier,
        imported: "*",
        local: "*",
        kind: "module",
      }),
    ];
  }

  const references: ImportReference[] = [];
  for (const specifierNode of descendants(clause).filter(
    (child) => child.type === "import_specifier",
  )) {
    const importedNode = specifierNode.childForFieldName("name");
    const localNode = specifierNode.childForFieldName("alias") ?? importedNode;
    if (!importedNode || !localNode) continue;
    references.push(
      reference(localNode, {
        specifier,
        imported: syntaxText(source, importedNode),
        local: syntaxText(source, localNode),
        kind: "named",
      }),
    );
  }
  const namespace = descendants(clause).find(
    (child) => child.type === "namespace_import",
  );
  const namespaceName = namespace?.namedChildren.find(
    (child): child is SyntaxNode => child !== null,
  );
  if (namespaceName) {
    references.push(
      reference(namespaceName, {
        specifier,
        imported: "*",
        local: syntaxText(source, namespaceName),
        kind: "namespace",
      }),
    );
  }
  const defaultName = clause.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null && child.type === "identifier",
  );
  if (defaultName) {
    references.push(
      reference(defaultName, {
        specifier,
        imported: "default",
        local: syntaxText(source, defaultName),
        kind: "default",
      }),
    );
  }
  return references;
}

/** Extracts Python bindings directly from import statement fields. */
function pythonReferences(source: string, node: SyntaxNode) {
  const references: ImportReference[] = [];
  if (node.type === "import_from_statement") {
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) return references;
    const specifier = syntaxText(source, moduleNode);
    for (const binding of node.childrenForFieldName("name")) {
      if (!binding) continue;
      const importedNode =
        binding.type === "aliased_import"
          ? binding.childForFieldName("name")
          : binding;
      const localNode =
        binding.type === "aliased_import"
          ? binding.childForFieldName("alias")
          : binding;
      if (!importedNode || !localNode) continue;
      const imported = syntaxText(source, importedNode);
      references.push(
        reference(localNode, {
          specifier,
          imported,
          local: syntaxText(source, localNode),
          kind: imported === "*" ? "namespace" : "named",
        }),
      );
    }
    return references;
  }

  for (const binding of node.childrenForFieldName("name")) {
    if (!binding) continue;
    const importedNode =
      binding.type === "aliased_import"
        ? binding.childForFieldName("name")
        : binding;
    const aliasNode =
      binding.type === "aliased_import"
        ? binding.childForFieldName("alias")
        : undefined;
    if (!importedNode) continue;
    const specifier = syntaxText(source, importedNode);
    const localNode =
      aliasNode ??
      descendants(importedNode).find((child) => child.type === "identifier") ??
      importedNode;
    references.push(
      reference(localNode, {
        specifier,
        imported: "*",
        local: syntaxText(source, localNode),
        kind: "module",
      }),
    );
  }
  return references;
}

/** Extracts a module reference from the literal carried by an import node. */
function staticModuleReference(source: string, node: SyntaxNode) {
  const literal = descendants(node).find((candidate) => {
    const type = candidate.type.toLowerCase();
    return type.includes("string") || type === "system_lib_string";
  });
  if (!literal) return [];
  return [
    reference(literal, {
      specifier: literalValue(source, literal),
      imported: "*",
      local: "*",
      kind: "module",
    }),
  ];
}

/** Returns whether a node type can carry an import for its language. */
function isImportStatementType(language: string, type: string) {
  return Boolean(statementTypes[language as TreeSitterLanguage]?.has(type));
}

/**
 * Returns whether a node of an import type is an actual import.
 *
 * Several languages spell imports with the same node they use for ordinary
 * calls or declarations, so the type alone only narrows the candidates.
 */
function isLanguageImport(language: string, source: string, node: SyntaxNode) {
  if (language === "shell") {
    const name = node.childForFieldName("name");
    return Boolean(name && [".", "source"].includes(syntaxText(source, name)));
  }
  if (language === "ruby") {
    const method = node.childForFieldName("method");
    return Boolean(
      method &&
        !node.childForFieldName("receiver") &&
        ["load", "require", "require_relative"].includes(
          syntaxText(source, method),
        ),
    );
  }
  if (language === "lua") {
    const call =
      node.type === "function_call"
        ? node
        : descendants(node).find(
            (candidate) => candidate.type === "function_call",
          );
    const callee = call?.childForFieldName("name");
    return Boolean(callee && syntaxText(source, callee) === "require");
  }
  if (language === "rust" && node.type === "mod_item") {
    return !node.childForFieldName("body");
  }
  return true;
}

/**
 * Returns the outermost import nodes in depth-first source order.
 *
 * A file holds tens of thousands of named nodes and only a handful of imports,
 * so the walk reads each node's type off the cursor and builds a node object
 * only for the candidates. An import never nests inside another, so a match
 * ends that branch and the result excludes anything a wider statement covers.
 */
function importNodes(source: string, language: string, root: SyntaxNode) {
  const nodes: SyntaxNode[] = [];
  const cursor = root.walk();
  let complete = false;
  while (!complete) {
    let imported = false;
    if (
      isImportStatementType(language, cursor.nodeType) &&
      cursor.nodeIsNamed
    ) {
      const node = cursor.currentNode;
      imported = isLanguageImport(language, source, node);
      if (imported) nodes.push(node);
    }
    if (!imported && cursor.gotoFirstChild()) continue;
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
  return nodes;
}

/** Extracts complete import statements from a Tree-sitter syntax tree. */
export function importStatementsFromTree(
  source: string,
  language: string,
  root: SyntaxNode,
) {
  return importNodes(source, language, root).map((node): ImportStatement => {
    const references =
      language === "python"
        ? pythonReferences(source, node)
        : language === "javascript" || language === "typescript"
          ? javascriptReferences(source, node)
          : staticModuleReference(source, node);
    return {
      from: node.startIndex,
      to: node.endIndex,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      source: syntaxText(source, node),
      references,
    };
  });
}
