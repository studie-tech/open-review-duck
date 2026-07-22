export type ImportReferenceKind = "default" | "module" | "named" | "namespace";

export interface ImportReference {
  specifier: string;
  imported: string;
  local: string;
  kind: ImportReferenceKind;
  from: number;
  to: number;
}

export interface ImportTargetReference {
  specifier: string;
  imported: string;
  kind: ImportReferenceKind;
}

export interface ImportStatement {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  source: string;
  references: ImportReference[];
}

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".php",
  ".rb",
  ".rs",
  ".lua",
  ".go",
  ".kt",
  ".kts",
  ".hcl",
  ".tf",
  ".mk",
] as const;

/** Adds a unique parsed import reference to the result set. */
function addReference(
  references: ImportReference[],
  input: Omit<ImportReference, "from" | "to">,
  source: string,
  searchFrom: number,
  searchTo: number,
  token: string,
) {
  const from = source.indexOf(token, searchFrom);
  if (from < searchFrom || from + token.length > searchTo) return;
  references.push({ ...input, from, to: from + token.length });
}

/** Parses imported bindings from a JavaScript or TypeScript import clause. */
function parseBindings(
  references: ImportReference[],
  source: string,
  bindings: string,
  bindingsFrom: number,
  specifier: string,
) {
  let cursor = bindingsFrom;
  for (const part of bindings.split(",")) {
    const binding =
      /(?:^|\s)type\s+([\w$]+)(?:\s+as\s+([\w$]+))?|([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(
        part.trim(),
      );
    const imported = binding?.[1] ?? binding?.[3];
    const local = binding?.[2] ?? binding?.[4] ?? imported;
    const partFrom = source.indexOf(part, cursor);
    const partTo = partFrom + part.length;
    cursor = partTo + 1;
    if (!imported || !local || partFrom < bindingsFrom) continue;
    addReference(
      references,
      { specifier, imported, local, kind: "named" },
      source,
      partFrom,
      partTo,
      imported,
    );
  }
}

/** Parses navigable imports from JavaScript or TypeScript source. */
function parseJavaScriptImports(source: string) {
  const references: ImportReference[] = [];

  for (const match of source.matchAll(
    /\bimport\s+(?:(?:type\s+)?[\w$]+\s*,\s*)?(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(["'])([^"'`]+)\2/g,
  )) {
    const statementFrom = match.index;
    const bindings = match[1];
    const specifier = match[3];
    if (statementFrom === undefined || !bindings || !specifier) continue;
    const bindingsFrom = source.indexOf(bindings, statementFrom);
    parseBindings(references, source, bindings, bindingsFrom, specifier);
  }

  for (const match of source.matchAll(
    /\bimport\s+(?:type\s+)?([\w$]+)\s*(?:,\s*(?:\{[\s\S]*?\}|\*\s+as\s+[\w$]+))?\s+from\s+(["'])([^"'`]+)\2/g,
  )) {
    const statementFrom = match.index;
    const local = match[1];
    const specifier = match[3];
    if (statementFrom === undefined || !local || !specifier) continue;
    addReference(
      references,
      { specifier, imported: "default", local, kind: "default" },
      source,
      statementFrom,
      statementFrom + match[0].length,
      local,
    );
  }

  for (const match of source.matchAll(
    /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s+(["'])([^"'`]+)\2/g,
  )) {
    const statementFrom = match.index;
    const local = match[1];
    const specifier = match[3];
    if (statementFrom === undefined || !local || !specifier) continue;
    addReference(
      references,
      { specifier, imported: "*", local, kind: "namespace" },
      source,
      statementFrom,
      statementFrom + match[0].length,
      local,
    );
  }

  for (const match of source.matchAll(
    /\bimport\s*(?:\(\s*)?(["'])([^"'`]+)\1\s*\)?/g,
  )) {
    const statementFrom = match.index;
    const quoted = match[0].match(/(["'])[^"'`]+\1/)?.[0];
    const specifier = match[2];
    if (statementFrom === undefined || !quoted || !specifier) continue;
    addReference(
      references,
      { specifier, imported: "*", local: "*", kind: "module" },
      source,
      statementFrom,
      statementFrom + match[0].length,
      quoted,
    );
  }

  for (const match of source.matchAll(
    /\brequire\s*\(\s*(["'])([^"'`]+)\1\s*\)/g,
  )) {
    const statementFrom = match.index;
    const quoted = match[0].match(/(["'])[^"'`]+\1/)?.[0];
    const specifier = match[2];
    if (statementFrom === undefined || !quoted || !specifier) continue;
    addReference(
      references,
      { specifier, imported: "*", local: "*", kind: "module" },
      source,
      statementFrom,
      statementFrom + match[0].length,
      quoted,
    );
  }

  return references;
}

/** Parses navigable imports from Python source. */
function parsePythonImports(source: string) {
  const references: ImportReference[] = [];
  for (const match of source.matchAll(
    /^[ \t]*from\s+([.\w]+)\s+import\s+(?:\(([\s\S]*?)\)|([^\n#]+))/gm,
  )) {
    const statementFrom = match.index;
    const specifier = match[1];
    const bindings = match[2] ?? match[3];
    if (statementFrom === undefined || !specifier || !bindings) continue;
    const bindingsFrom = source.indexOf(bindings, statementFrom);
    let cursor = bindingsFrom;
    for (const part of bindings.split(",")) {
      const partFrom = source.indexOf(part, cursor);
      const partTo = partFrom + part.length;
      cursor = partTo + 1;
      const binding = /^\s*([A-Za-z_]\w*|\*)(?:\s+as\s+([A-Za-z_]\w*))?/.exec(
        part.replace(/#[^\n]*/g, "").trim(),
      );
      const imported = binding?.[1];
      const local = binding?.[2] ?? imported;
      if (!imported || !local || partFrom < bindingsFrom) continue;
      addReference(
        references,
        {
          specifier,
          imported,
          local,
          kind: imported === "*" ? "namespace" : "named",
        },
        source,
        partFrom,
        partTo,
        local,
      );
    }
  }

  for (const match of source.matchAll(/^[ \t]*import\s+([^\n#]+)/gm)) {
    const statementFrom = match.index;
    const modules = match[1];
    if (statementFrom === undefined || !modules) continue;
    let cursor = source.indexOf(modules, statementFrom);
    for (const part of modules.split(",")) {
      const partFrom = source.indexOf(part, cursor);
      const partTo = partFrom + part.length;
      cursor = partTo + 1;
      const binding =
        /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?/.exec(
          part.trim(),
        );
      const specifier = binding?.[1];
      const local = binding?.[2] ?? specifier?.split(".")[0];
      if (!specifier || !local) continue;
      addReference(
        references,
        { specifier, imported: "*", local, kind: "module" },
        source,
        partFrom,
        partTo,
        local,
      );
    }
  }
  return references;
}

/** Parses navigable import references for a supported language. */
export function parseImportReferences(source: string, language: string) {
  const references =
    language === "python"
      ? parsePythonImports(source)
      : parseJavaScriptImports(source);
  return references
    .filter(
      (reference, index) =>
        references.findIndex(
          (candidate) =>
            candidate.from === reference.from && candidate.to === reference.to,
        ) === index,
    )
    .sort((left, right) => left.from - right.from);
}

/** Returns complete static import statements with their source positions. */
export function parseImportStatements(source: string, language: string) {
  const patterns: Partial<Record<string, RegExp>> = {
    python:
      /(?:^|\n)((?:from\s+[.\w]+\s+import\s+(?:\([\s\S]*?\)|[^\n#]+)|import\s+[^\n#]+))/g,
    java: /(?:^|\n)([ \t]*(?:package|import(?:\s+static)?)\s+[^;\n]+;)/g,
    kotlin: /(?:^|\n)([ \t]*(?:package|import)\s+[^\n;]+;?)/g,
    csharp: /(?:^|\n)([ \t]*(?:global\s+)?using\s+[^;\n]+;)/g,
    c: /(?:^|\n)([ \t]*#[ \t]*(?:include|import)\b[^\n]*(?:\\\n[^\n]*)*)/g,
    cpp: /(?:^|\n)([ \t]*(?:#[ \t]*(?:include|import)\b[^\n]*(?:\\\n[^\n]*)*|import\s+[^;\n]+;))/g,
    php: /(?:^|\n)([ \t]*(?:use\s+[^;]+|(?:require|include)(?:_once)?\s+[^;]+);)/g,
    shell: /(?:^|\n)([ \t]*(?:source|\.)[ \t]+[^\n]+)/g,
    ruby: /(?:^|\n)([ \t]*(?:require|require_relative|load)[ \t]+[^\n]+)/g,
    rust: /(?:^|\n)([ \t]*(?:use|extern\s+crate|mod)\s+[\s\S]*?;)/g,
    lua: /(?:^|\n)([ \t]*(?:local\s+[A-Za-z_]\w*\s*=\s*)?require\s*\([^\n]+\))/g,
    go: /(?:^|\n)([ \t]*import\s*(?:\([\s\S]*?\)|"[^"\n]+"|`[^`\n]+`))/g,
    makefile: /(?:^|\n)([ \t]*-?include[ \t]+[^\n]+)/g,
  };
  const pattern =
    patterns[language] ??
    /(?:^|\n)([ \t]*import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:(?:type\s+)?\{[\s\S]*?\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*(?:from\s+)?["'][^"'`\n]+["']\s*;?)/g;
  const references = parseImportReferences(source, language);
  const statements: ImportStatement[] = [];
  for (const match of source.matchAll(pattern)) {
    const statement = match[1];
    if (match.index === undefined || !statement) continue;
    const leadingOffset = match[0].indexOf(statement);
    const from = match.index + leadingOffset;
    const to = from + statement.length;
    statements.push({
      from,
      to,
      startLine: source.slice(0, from).split("\n").length,
      endLine: source.slice(0, to).split("\n").length,
      source: statement,
      references: references.filter(
        (reference) => reference.from >= from && reference.to <= to,
      ),
    });
  }
  return statements;
}

/** Checks whether source contains imports plus only inert module preamble. */
export function isImportOnlySource(source: string, language: string) {
  const statements = parseImportStatements(source, language);
  if (statements.length === 0) return false;
  const remainder = [...source];
  for (const statement of statements) {
    remainder.fill(" ", statement.from, statement.to);
  }
  const withoutComments =
    language === "python"
      ? remainder.join("").replace(/^[ \t]*#[^\n]*/gm, "")
      : remainder
          .join("")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
  const withoutPreamble =
    language === "python"
      ? withoutComments.replace(
          /^\s*(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\n]*"|'[^'\n]*')\s*/,
          "",
        )
      : withoutComments.replace(
          /^[ \t]*(?:"[^"\n]*"|'[^'\n]*')\s*;?[ \t]*$/gm,
          "",
        );
  return withoutPreamble.trim().length === 0;
}

/** Checks whether an imported binding is referenced by the active code unit. */
export function importReferenceIsUsed(
  reference: ImportReference,
  unitSource: string,
) {
  if (reference.kind === "module" && reference.local === "*") return true;
  const escaped = reference.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`).test(unitSource);
}

/** Normalizes a repository path for cross-platform comparison. */
function normalizeRepositoryPath(path: string) {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Returns the parent directory of a normalized repository path. */
function directoryName(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Builds possible repository paths for a relative import specifier. */
function candidateBases(sourcePath: string, specifier: string) {
  const normalizedSource = normalizeRepositoryPath(sourcePath);
  if (!normalizedSource || specifier.includes("\0")) return [];
  const sourceDirectory = directoryName(normalizedSource);
  if (specifier.startsWith(".")) {
    if (normalizedSource.endsWith(".py")) {
      const dotCount = /^\.+/.exec(specifier)?.[0].length ?? 1;
      let directory = sourceDirectory;
      for (let index = 1; index < dotCount; index += 1) {
        directory = directoryName(directory);
      }
      const modulePath = specifier.slice(dotCount).replaceAll(".", "/");
      return [
        normalizeRepositoryPath(
          `${directory}${directory && modulePath ? "/" : ""}${modulePath}`,
        ),
      ].filter((path): path is string => Boolean(path));
    }
    return [
      normalizeRepositoryPath(
        `${sourceDirectory}${sourceDirectory ? "/" : ""}${specifier}`,
      ),
    ].filter((path): path is string => Boolean(path));
  }
  if (normalizedSource.endsWith(".py")) {
    const modulePath = normalizeRepositoryPath(specifier.replaceAll(".", "/"));
    return modulePath ? [modulePath] : [];
  }
  if (specifier.startsWith("~/")) {
    const path = normalizeRepositoryPath(`src/${specifier.slice(2)}`);
    return path ? [path] : [];
  }
  if (specifier.startsWith("@/")) {
    const suffix = specifier.slice(2);
    return [
      normalizeRepositoryPath(suffix),
      normalizeRepositoryPath(`src/${suffix}`),
    ].filter((path): path is string => Boolean(path));
  }
  return [];
}

/** Builds supported file candidates for an imported module path. */
export function importPathCandidates(
  sourcePath: string,
  specifier: string,
  language?: string,
) {
  const languageExtensions: Partial<Record<string, readonly string[]>> = {
    java: [".java"],
    csharp: [".cs"],
    cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    c: [".c", ".h"],
    php: [".php", ".phtml"],
    shell: [".sh", ".bash", ".zsh", ".ksh"],
    ruby: [".rb", ".rake"],
    rust: [".rs"],
    lua: [".lua"],
    go: [".go"],
    kotlin: [".kt", ".kts"],
    hcl: [".hcl", ".tf", ".tfvars"],
    makefile: [".mk"],
  };
  const preferredExtensions =
    language === "python"
      ? [".py"]
      : language === "javascript"
        ? [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]
        : language === "typescript"
          ? [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
          : (languageExtensions[language ?? ""] ?? [...SOURCE_EXTENSIONS]);
  const candidates: string[] = [];
  for (const base of candidateBases(sourcePath, specifier)) {
    if (SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
      candidates.push(base);
    } else {
      candidates.push(
        ...preferredExtensions.map((extension) => `${base}${extension}`),
        ...(language === "python"
          ? [`${base}/__init__.py`]
          : preferredExtensions.map(
              (extension) => `${base}/index${extension}`,
            )),
      );
    }
  }
  return [...new Set(candidates)];
}

/** Resolves an import reference to a file present in the review. */
export function resolveImportPath(
  sourcePath: string,
  specifier: string,
  paths: ReadonlySet<string>,
  language?: string,
) {
  const candidates = importPathCandidates(sourcePath, specifier, language);
  const direct = candidates.find((path) => paths.has(path));
  if (direct || language !== "python") return direct;
  const suffixMatches = [...paths].filter((path) =>
    candidates.some((candidate) => path.endsWith(`/${candidate}`)),
  );
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

/** Resolves a Python binding that may refer to a package submodule. */
export function resolvePythonImportedSubmodulePath(
  sourcePath: string,
  specifier: string,
  imported: string,
  paths: ReadonlySet<string>,
) {
  if (imported === "*") return undefined;
  const submodule = specifier.endsWith(".")
    ? `${specifier}${imported}`
    : `${specifier}.${imported}`;
  return resolveImportPath(sourcePath, submodule, paths, "python");
}

/** Finds the review unit that defines an imported binding. */
export function findImportTargetUnit<
  Unit extends {
    kind: string;
    name: string;
    path: string;
  },
>(
  sourcePath: string,
  language: string,
  reference: ImportTargetReference,
  units: readonly Unit[],
) {
  const targetPath = resolveImportPath(
    sourcePath,
    reference.specifier,
    new Set(units.map((unit) => unit.path)),
    language,
  );
  const submodulePath =
    language === "python" && reference.kind === "named"
      ? resolvePythonImportedSubmodulePath(
          sourcePath,
          reference.specifier,
          reference.imported,
          new Set(units.map((unit) => unit.path)),
        )
      : undefined;
  if (!targetPath && !submodulePath) return undefined;
  const directUnits = units.filter((unit) => unit.path === targetPath);
  const exactUnit =
    reference.kind === "named"
      ? directUnits.find(
          (unit) =>
            unit.kind !== "module" &&
            unit.kind !== "file" &&
            unit.name === reference.imported,
        )
      : undefined;
  const resolvedPath = exactUnit ? targetPath : (submodulePath ?? targetPath);
  if (!resolvedPath) return undefined;
  const pathUnits = units.filter((unit) => unit.path === resolvedPath);
  const moduleUnit =
    pathUnits.find((unit) => unit.kind === "file") ??
    pathUnits.find((unit) => unit.kind === "module");
  return {
    targetPath: resolvedPath,
    exactUnit: reference.kind === "named" ? exactUnit : moduleUnit,
    moduleUnit,
  };
}

/** Finds the declaration line for a binding outside the review path. */
export function findImportedDeclarationLine(
  source: string,
  imported: string,
  language: string,
  startLine = 1,
) {
  if (imported === "*") return undefined;
  const escapedName = imported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration =
    language === "python"
      ? new RegExp(
          `^\\s*(?:async\\s+def|def|class)\\s+${escapedName}\\b|^\\s*${escapedName}\\s*=`,
        )
      : new RegExp(
          `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:type|interface|enum|const|let|var|function|class)\\s+${escapedName}\\b`,
        );
  const index = source.split("\n").findIndex((line) => declaration.test(line));
  return index < 0 ? undefined : startLine + index;
}
