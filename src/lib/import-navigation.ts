import { supportedExtensions } from "~/server/analysis/types";
import {
  applyImportMappings,
  emptyImportPathContext,
  type ImportPathContext,
} from "./import-maps";

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
  ...new Set(Object.values(supportedExtensions).flat()),
] as const;

const DOTTED_PACKAGE_LANGUAGES = new Set([
  "python",
  "java",
  "kotlin",
  "groovy",
  "scala",
  "csharp",
]);

const FILE_INCLUDE_LANGUAGES = new Set([
  "c",
  "cpp",
  "objc",
  "php",
  "ruby",
  "lua",
  "shell",
  "makefile",
  "css",
  "scss",
  "protobuf",
  "solidity",
  "erlang",
  "elisp",
]);

const JVM_SOURCE_ROOTS = [
  "",
  "src",
  "src/main/java",
  "src/main/kotlin",
  "src/main/scala",
  "src/main/groovy",
  "lib",
  "app/src/main/java",
  "app/src/main/kotlin",
];

const CSHARP_SOURCE_ROOTS = ["", "src"];

const EXTERNAL_SPECIFIER_PREFIXES: Partial<Record<string, readonly string[]>> =
  {
    csharp: ["System."],
    java: ["java.", "javax.", "jakarta.", "jdk."],
    kotlin: ["java.", "javax.", "jakarta.", "jdk.", "kotlin."],
    scala: ["scala.", "java.", "javax."],
  };

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

/** Returns whether a specifier already looks like a repository file path. */
function specifierLooksLikeFilePath(specifier: string) {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    normalized.includes("/") ||
    SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  );
}

/** Joins a directory and specifier into a repository-relative path. */
function joinFromDirectory(directory: string, specifier: string) {
  return normalizeRepositoryPath(
    `${directory}${directory && specifier ? "/" : ""}${specifier}`,
  );
}

/** Resolves a relative specifier against the file that imported it. */
function relativeCandidateBases(sourcePath: string, specifier: string) {
  const sourceDirectory = directoryName(sourcePath);
  if (sourcePath.endsWith(".py")) {
    const dotCount = /^\.+/.exec(specifier)?.[0].length ?? 1;
    let directory = sourceDirectory;
    for (let index = 1; index < dotCount; index += 1) {
      directory = directoryName(directory);
    }
    const modulePath = specifier.slice(dotCount).replaceAll(".", "/");
    const joined = joinFromDirectory(directory, modulePath);
    return joined ? [joined] : [];
  }
  const joined = joinFromDirectory(sourceDirectory, specifier);
  return joined ? [joined] : [];
}

/** Converts a dotted package name into repository path fragments. */
function dottedPackageBases(specifier: string, language: string) {
  const modulePath = normalizeRepositoryPath(
    specifier.replaceAll(".", "/").replaceAll("\\", "/"),
  );
  if (!modulePath) return [];
  if (language === "python") return [modulePath];
  const roots = language === "csharp" ? CSHARP_SOURCE_ROOTS : JVM_SOURCE_ROOTS;
  return roots.flatMap((root) => {
    const joined = joinFromDirectory(root, modulePath);
    return joined ? [joined] : [];
  });
}

/** Resolves a Rust `crate` / `super` / `self` path onto source files. */
function rustCandidateBases(
  sourcePath: string,
  specifier: string,
  context: ImportPathContext,
) {
  const segments = specifier.split("::").filter(Boolean);
  if (segments.length === 0) return [];
  const crateRoot = rustCrateRoot(sourcePath, context.crateRoots);
  const srcRoot = crateRoot ? `${crateRoot}/src` : "src";
  let directory: string | undefined;
  if (segments[0] === "crate" || specifier.startsWith("::")) {
    const rest = segments[0] === "crate" ? segments.slice(1) : segments;
    directory = rest.length > 0 ? `${srcRoot}/${rest.join("/")}` : srcRoot;
  } else {
    directory = rustModuleDirectory(sourcePath);
    for (const segment of segments) {
      if (segment === "self") continue;
      if (segment === "super") {
        directory = directoryName(directory);
        continue;
      }
      directory = directory ? `${directory}/${segment}` : segment;
    }
  }
  const normalized = normalizeRepositoryPath(directory ?? "");
  return normalized ? [normalized] : [];
}

/** Chooses the Cargo package that contains a Rust source file. */
function rustCrateRoot(sourcePath: string, crateRoots: readonly string[]) {
  const known = crateRoots
    .filter(
      (root) =>
        sourcePath === root || sourcePath.startsWith(root ? `${root}/` : ""),
    )
    .sort((left, right) => right.length - left.length)[0];
  if (known !== undefined) return known;
  if (sourcePath.startsWith("src/")) return "";
  const index = sourcePath.indexOf("/src/");
  return index >= 0 ? sourcePath.slice(0, index) : "";
}

/** Returns the directory a Rust file contributes child modules into. */
function rustModuleDirectory(sourcePath: string) {
  const base = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  const directory = directoryName(sourcePath);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") {
    return directory;
  }
  return sourcePath.replace(/\.[^./]+$/, "");
}

/**
 * Reports whether a specifier belongs to another package, not this repository.
 *
 * Project mappings always win. Bare npm packages, language standard libraries,
 * and Go imports that are not this module stay unresolved so a hover does not
 * spend provider reads on files that cannot exist here.
 */
export function isExternalImportSpecifier(
  specifier: string,
  language: string | undefined,
  context: ImportPathContext = emptyImportPathContext(),
) {
  if (applyImportMappings(specifier, context.mappings).length > 0) {
    return false;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("crate") || specifier.startsWith("super::")) {
    return false;
  }
  if (specifier.startsWith("self::") || specifier.startsWith("::")) {
    return false;
  }
  const prefixes = EXTERNAL_SPECIFIER_PREFIXES[language ?? ""] ?? [];
  if (prefixes.some((prefix) => specifier.startsWith(prefix))) return true;
  if (language === "go") {
    return !context.mappings.some((mapping) =>
      specifier.startsWith(mapping.pattern.replace(/\*$/, "")),
    );
  }
  if (
    language === "javascript" ||
    language === "typescript" ||
    language === undefined
  ) {
    if (specifier.startsWith("#") || specifier.startsWith("@/")) return false;
    if (specifier.startsWith("~/")) return false;
    if (specifier.startsWith("@") && !specifier.startsWith("@/")) return true;
    return !specifierLooksLikeFilePath(specifier);
  }
  return false;
}

/**
 * Ecosystem defaults used only when the project never declared the specifier.
 *
 * `~/` and `@/` remain the usual T3 / Next mappings so a review still works
 * when tsconfig was not fetched. Declared project maps override them.
 */
function fallbackAliasBases(specifier: string, language: string | undefined) {
  if (language !== "javascript" && language !== "typescript") return [];
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

/** Builds possible repository paths for one import specifier. */
function candidateBases(
  sourcePath: string,
  specifier: string,
  language?: string,
  context: ImportPathContext = emptyImportPathContext(),
) {
  const normalizedSource = normalizeRepositoryPath(sourcePath);
  if (!normalizedSource || specifier.includes("\0")) return [];
  if (specifier.startsWith(".")) {
    return relativeCandidateBases(normalizedSource, specifier);
  }
  const mapped = applyImportMappings(specifier, context.mappings)
    .map((path) => normalizeRepositoryPath(path))
    .filter((path): path is string => path !== undefined);
  if (mapped.length > 0) return mapped;
  if (isExternalImportSpecifier(specifier, language, context)) return [];
  if (language === "rust") {
    return rustCandidateBases(normalizedSource, specifier, context);
  }
  if (language && DOTTED_PACKAGE_LANGUAGES.has(language)) {
    return dottedPackageBases(specifier, language);
  }
  if (language === "go" && specifierLooksLikeFilePath(specifier)) {
    const path = normalizeRepositoryPath(specifier);
    return path ? [path] : [];
  }
  if (
    language &&
    FILE_INCLUDE_LANGUAGES.has(language) &&
    specifierLooksLikeFilePath(specifier)
  ) {
    const fromFile = joinFromDirectory(
      directoryName(normalizedSource),
      specifier,
    );
    const fromRoot = normalizeRepositoryPath(specifier);
    return [fromFile, fromRoot].filter((path): path is string => Boolean(path));
  }
  return fallbackAliasBases(specifier, language);
}

/** Extensions a language's modules are usually stored under. */
function preferredImportExtensions(language: string | undefined) {
  if (language === "python") return [".py"] as const;
  if (language === "javascript") {
    return [
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
    ] as const;
  }
  if (language === "typescript") {
    return [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ] as const;
  }
  if (language && language in supportedExtensions) {
    return supportedExtensions[language as keyof typeof supportedExtensions];
  }
  return SOURCE_EXTENSIONS;
}

/** Builds supported file candidates for an imported module path. */
export function importPathCandidates(
  sourcePath: string,
  specifier: string,
  language?: string,
  context: ImportPathContext = emptyImportPathContext(),
) {
  const preferredExtensions = preferredImportExtensions(language);
  const candidates: string[] = [];
  for (const base of candidateBases(
    sourcePath,
    specifier,
    language,
    context,
  ).filter(Boolean)) {
    if (SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
      candidates.push(base);
      continue;
    }
    if (language === "python") {
      candidates.push(
        ...preferredExtensions.map((extension) => `${base}${extension}`),
        `${base}/__init__.py`,
      );
      continue;
    }
    if (language === "go") {
      const packageName = base.slice(base.lastIndexOf("/") + 1);
      candidates.push(`${base}.go`, `${base}/${packageName}.go`);
      continue;
    }
    if (language === "rust") {
      candidates.push(`${base}.rs`, `${base}/mod.rs`);
      continue;
    }
    if (language === "php") {
      candidates.push(`${base}.php`, `${base}.phtml`);
      continue;
    }
    candidates.push(
      ...preferredExtensions.map((extension) => `${base}${extension}`),
      ...preferredExtensions.map((extension) => `${base}/index${extension}`),
    );
  }
  return [...new Set(candidates)];
}

/** Resolves an import reference to a file present in the review. */
export function resolveImportPath(
  sourcePath: string,
  specifier: string,
  paths: ReadonlySet<string>,
  language?: string,
  context: ImportPathContext = emptyImportPathContext(),
) {
  const candidates = importPathCandidates(
    sourcePath,
    specifier,
    language,
    context,
  );
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
  context: ImportPathContext = emptyImportPathContext(),
) {
  const targetPath = resolveImportPath(
    sourcePath,
    reference.specifier,
    new Set(units.map((unit) => unit.path)),
    language,
    context,
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
