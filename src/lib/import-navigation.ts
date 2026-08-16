type ImportReferenceKind = "default" | "module" | "named" | "namespace";

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

export type PairedImportStatement =
  | {
      kind: "unchanged" | "added" | "modified";
      current: ImportStatement;
      previous?: ImportStatement;
    }
  | {
      kind: "deleted";
      previous: ImportStatement;
    };

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

/** Scores how closely two import statements describe the same dependency edge. */
function importStatementMatchScore(
  previous: ImportStatement,
  current: ImportStatement,
) {
  if (previous.source === current.source) return 1_000;
  const previousLocals = new Set(
    previous.references.map((reference) => reference.local),
  );
  const currentLocals = new Set(
    current.references.map((reference) => reference.local),
  );
  let sharedLocals = 0;
  for (const local of currentLocals) {
    if (previousLocals.has(local)) sharedLocals += 1;
  }
  const previousSpecifiers = new Set(
    previous.references.map((reference) => reference.specifier),
  );
  const currentSpecifiers = new Set(
    current.references.map((reference) => reference.specifier),
  );
  let sharedSpecifiers = 0;
  for (const specifier of currentSpecifiers) {
    if (previousSpecifiers.has(specifier)) sharedSpecifiers += 1;
  }
  return (
    sharedLocals * 100 +
    sharedSpecifiers * 20 -
    Math.abs(previous.startLine - current.startLine)
  );
}

/**
 * Pairs base/head import statements so context can render rewrites as changes
 * instead of bare additions.
 */
export function pairImportStatements(
  previous: readonly ImportStatement[],
  current: readonly ImportStatement[],
): PairedImportStatement[] {
  const previousUsed = new Array<boolean>(previous.length).fill(false);
  const pairs: PairedImportStatement[] = [];

  for (const statement of current) {
    const exactIndex = previous.findIndex(
      (candidate, index) =>
        !previousUsed[index] && candidate.source === statement.source,
    );
    if (exactIndex >= 0) {
      previousUsed[exactIndex] = true;
      pairs.push({
        kind: "unchanged",
        current: statement,
        previous: previous[exactIndex],
      });
      continue;
    }

    const candidates = previous.flatMap((candidate, index) => {
      if (previousUsed[index]) return [];
      const score = importStatementMatchScore(candidate, statement);
      return score > 0 ? [{ index, candidate, score }] : [];
    });
    candidates.sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.startLine - right.candidate.startLine,
    );
    const best = candidates[0];
    if (best && best.score !== candidates[1]?.score) {
      previousUsed[best.index] = true;
      pairs.push({
        kind: "modified",
        current: statement,
        previous: best.candidate,
      });
      continue;
    }

    pairs.push({ kind: "added", current: statement });
  }

  for (const [index, statement] of previous.entries()) {
    if (previousUsed[index] || !statement) continue;
    pairs.push({ kind: "deleted", previous: statement });
  }

  return pairs.sort((left, right) => {
    const leftLine =
      left.kind === "deleted"
        ? left.previous.startLine
        : left.current.startLine;
    const rightLine =
      right.kind === "deleted"
        ? right.previous.startLine
        : right.current.startLine;
    return leftLine - rightLine;
  });
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
