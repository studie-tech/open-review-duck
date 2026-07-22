import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parser } from "@lezer/javascript";

const SOURCE_ROOTS = ["src", ".flue", "drizzle", "scripts"];
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
const IGNORED_DIRECTORIES = new Set([".git", ".next", "node_modules"]);

/** Recursively returns the JavaScript and TypeScript files below a directory. */
function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRECTORIES.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

/** Returns the declaration name when a syntax node represents a named callable. */
function callableName(type, source) {
  if (type === "FunctionDeclaration") {
    return /(?:async\s+)?function\s+([\w$]+)/.exec(source)?.[1] ?? null;
  }
  if (type === "MethodDeclaration") {
    return (
      /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*(?:<[^>]+>)?\s*\(/.exec(
        source,
      )?.[1] ?? null
    );
  }
  if (type !== "VariableDeclaration" && type !== "PropertyDeclaration") {
    return null;
  }
  return (
    /^(?:(?:public|private|protected|static|readonly|declare)\s+)*(?:(?:const|let|var)\s+)?([\w$]+)[?!]?(?:\s*:[^=]+)?\s*=\s*(?:async\s*)?(?:(?:<[^>]+>\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>|function\b)/s.exec(
      source,
    )?.[1] ?? null
  );
}

/** Locates the start of a declaration, including export modifiers on its line. */
function declarationAnchor(source, nodeStart) {
  const lineStart = source.lastIndexOf("\n", nodeStart - 1) + 1;
  const prefix = source.slice(lineStart, nodeStart);
  return /^\s*(?:(?:export|default|declare)\s+)*$/.test(prefix)
    ? lineStart
    : nodeStart;
}

/** Checks whether a declaration is immediately preceded by a JSDoc comment. */
function hasDocstring(source, anchor) {
  const before = source.slice(0, anchor).replace(/\s+$/, "");
  if (!before.endsWith("*/")) return false;
  const commentStart = before.lastIndexOf("/*");
  return commentStart >= 0 && before.startsWith("/**", commentStart);
}

/** Finds named callables in a source file that do not have adjacent JSDoc. */
function undocumentedCallables(path) {
  const source = readFileSync(path, "utf8");
  const tree = parser.configure({ dialect: "ts jsx" }).parse(source);
  const missing = [];
  const cursor = tree.cursor();

  do {
    const snippet = source.slice(
      cursor.from,
      Math.min(cursor.to, cursor.from + 800),
    );
    const name = callableName(cursor.type.name, snippet);
    if (!name) continue;
    const anchor = declarationAnchor(source, cursor.from);
    if (hasDocstring(source, anchor)) continue;
    missing.push({
      line: source.slice(0, cursor.from).split("\n").length,
      name,
      path,
    });
  } while (cursor.next());

  return missing;
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
