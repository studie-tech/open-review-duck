import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const SOURCE_ROOTS = ["src", "drizzle", "scripts"];
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".well-known",
  "node_modules",
]);
const CALLABLE_TYPES = new Set(["function_declaration", "method_definition"]);

await Parser.init({
  locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
});
const language = await Language.load(
  require.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm"),
);

/** Recursively returns the JavaScript and TypeScript files below a directory. */
function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRECTORIES.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

/** Returns every named syntax node in depth-first source order. */
function namedNodes(root) {
  const nodes = [];
  const cursor = root.walk();
  let complete = false;
  while (!complete) {
    if (cursor.currentNode.isNamed) nodes.push(cursor.currentNode);
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

/** Returns the name node when a syntax node declares a named callable. */
function callableNameNode(node) {
  if (CALLABLE_TYPES.has(node.type)) {
    if (
      node.type === "method_definition" &&
      !node.parent?.type.includes("class")
    ) {
      return null;
    }
    return node.childForFieldName("name");
  }
  if (
    node.type !== "variable_declarator" &&
    node.type !== "public_field_definition"
  ) {
    return null;
  }
  const value = node.childForFieldName("value");
  if (
    !value ||
    !["arrow_function", "function_expression"].includes(value.type)
  ) {
    return null;
  }
  return node.childForFieldName("name");
}

/** Locates the declaration wrapper whose leading JSDoc documents a callable. */
function declarationAnchor(node) {
  let declaration = node;
  if (node.type === "variable_declarator") {
    while (
      declaration.parent &&
      !["lexical_declaration", "variable_declaration"].includes(
        declaration.type,
      )
    ) {
      declaration = declaration.parent;
    }
  }
  while (
    declaration.parent &&
    ["decorated_definition", "export_statement"].includes(
      declaration.parent.type,
    )
  ) {
    declaration = declaration.parent;
  }
  return declaration.startIndex;
}

/** Checks whether a declaration is immediately preceded by a JSDoc comment. */
function hasDocstring(source, anchor) {
  const before = source.slice(0, anchor).trimEnd();
  if (!before.endsWith("*/")) return false;
  const commentStart = before.lastIndexOf("/*");
  return commentStart >= 0 && before.startsWith("/**", commentStart);
}

/** Finds named callables in a source file that do not have adjacent JSDoc. */
function undocumentedCallables(path) {
  const source = readFileSync(path, "utf8");
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error(`Tree-sitter did not parse ${path}`);
  try {
    return namedNodes(tree.rootNode).flatMap((node) => {
      const nameNode = callableNameNode(node);
      if (!nameNode || hasDocstring(source, declarationAnchor(node))) return [];
      return [
        {
          line: source.slice(0, node.startIndex).split("\n").length,
          name: source.slice(nameNode.startIndex, nameNode.endIndex),
          path,
        },
      ];
    });
  } finally {
    tree.delete();
  }
}

/** Audits every maintained source file and exits unsuccessfully on violations. */
function checkDocstrings() {
  const rootFiles = readdirSync(".")
    .filter((path) => SOURCE_EXTENSIONS.has(extname(path)))
    .sort();
  const sourceFiles = SOURCE_ROOTS.flatMap(collectSourceFiles).sort();
  const missing = [...rootFiles, ...sourceFiles].flatMap(undocumentedCallables);

  if (missing.length === 0) {
    console.log("All named functions and methods have docstrings.");
    return;
  }

  console.error(
    "Named functions and methods must have adjacent JSDoc comments:",
  );
  for (const item of missing) {
    console.error(`- ${item.path}:${item.line} ${item.name}`);
  }
  process.exitCode = 1;
}

checkDocstrings();
