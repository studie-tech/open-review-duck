/**
 * One project-declared mapping from an import specifier onto repository paths.
 *
 * Patterns follow the TypeScript `paths` / Node.js `imports` convention: an
 * optional `*` stands for the unmatched suffix and is substituted into each
 * target. Targets are already repository-relative.
 */
export interface ImportPathMapping {
  pattern: string;
  targets: readonly string[];
}

/**
 * Path knowledge loaded from the reviewed revision's own project files.
 *
 * Hover and import navigation resolve specifiers through this context instead
 * of guessing aliases. An empty context still allows relative imports and each
 * language's ordinary module layout.
 */
export interface ImportPathContext {
  crateRoots: readonly string[];
  mappings: readonly ImportPathMapping[];
}

/** Project files that can contribute import maps. */
export const PROJECT_IMPORT_CONFIG_NAMES = new Set([
  "Cargo.toml",
  "composer.json",
  "go.mod",
  "jsconfig.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
]);

const emptyContext: ImportPathContext = { crateRoots: [], mappings: [] };

/** Returns an empty project import context. */
export function emptyImportPathContext(): ImportPathContext {
  return emptyContext;
}

/** Joins two repository path fragments without leaving the tree. */
function joinRepositoryPath(directory: string, relative: string) {
  const prefix = directory ? `${directory}/` : "";
  return normalizeRepositoryRelative(`${prefix}${relative}`);
}

/** Normalizes a repository-relative path and rejects parent escapes. */
function normalizeRepositoryRelative(path: string) {
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

/** Returns the directory containing a repository path. */
export function importConfigDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";
}

/** Returns the final path segment of a repository path. */
function fileName(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Strips comments and trailing commas from JSONC so tsconfig can be parsed.
 *
 * TypeScript config files are JSON with comments. The walk tracks string
 * state so a `//` inside a path is left alone.
 */
export function parseJsonc(source: string): unknown {
  let result = "";
  let state: "code" | "string" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line") {
      if (character === "\n") {
        state = "code";
        result += character;
      }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      result += character;
      if (character === "\\") {
        result += next;
        index += 1;
        continue;
      }
      if (character === '"') state = "code";
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block";
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "string";
      result += character;
      continue;
    }
    result += character;
  }
  return JSON.parse(result.replace(/,(\s*[}\]])/g, "$1"));
}

/** Reads string values out of a Node conditional exports object. */
function conditionalTargets(
  value: unknown,
  seen = new Set<unknown>(),
): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => conditionalTargets(entry, seen));
  }
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["default", "import", "require", "node", "browser"]) {
    if (key in record) return conditionalTargets(record[key], seen);
  }
  return Object.values(record).flatMap((entry) =>
    conditionalTargets(entry, seen),
  );
}

/** Resolves mapping targets against the directory that declared them. */
function resolveMappingTargets(directory: string, targets: readonly string[]) {
  return [
    ...new Set(
      targets.flatMap((target) => {
        const resolved = joinRepositoryPath(directory, target);
        return resolved === undefined ? [] : [resolved];
      }),
    ),
  ];
}

/** Reads Node.js subpath imports from a package.json document. */
export function mappingsFromPackageJson(
  source: string,
  directory: string,
): ImportPathMapping[] {
  try {
    const parsed = JSON.parse(source) as { imports?: unknown };
    if (!parsed.imports || typeof parsed.imports !== "object") return [];
    return Object.entries(parsed.imports as Record<string, unknown>).flatMap(
      ([pattern, target]) => {
        if (!pattern.startsWith("#")) return [];
        const targets = resolveMappingTargets(
          directory,
          conditionalTargets(target),
        );
        return targets.length > 0 ? [{ pattern, targets }] : [];
      },
    );
  } catch {
    return [];
  }
}

interface TsconfigDocument {
  compilerOptions?: {
    baseUrl?: unknown;
    paths?: unknown;
  };
  extends?: unknown;
}

/** Reads TypeScript path mappings from a tsconfig or jsconfig document. */
export function mappingsFromTsconfig(
  source: string,
  directory: string,
): { extends?: string; mappings: ImportPathMapping[] } {
  try {
    const parsed = parseJsonc(source) as TsconfigDocument;
    const compilerOptions = parsed.compilerOptions ?? {};
    const baseUrl =
      typeof compilerOptions.baseUrl === "string"
        ? compilerOptions.baseUrl
        : ".";
    const baseDirectory = joinRepositoryPath(directory, baseUrl);
    if (baseDirectory === undefined) {
      return { mappings: [] };
    }
    const paths = compilerOptions.paths;
    const mappings =
      paths && typeof paths === "object" && !Array.isArray(paths)
        ? Object.entries(paths as Record<string, unknown>).flatMap(
            ([pattern, target]) => {
              const targets = resolveMappingTargets(
                baseDirectory,
                Array.isArray(target)
                  ? target.filter(
                      (entry): entry is string => typeof entry === "string",
                    )
                  : typeof target === "string"
                    ? [target]
                    : [],
              );
              return targets.length > 0 ? [{ pattern, targets }] : [];
            },
          )
        : [];
    const parent =
      typeof parsed.extends === "string"
        ? parsed.extends
        : Array.isArray(parsed.extends)
          ? parsed.extends.find(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined;
    const resolvedParent =
      parent &&
      !parent.startsWith("@") &&
      (parent.startsWith(".") || parent.startsWith("/"))
        ? joinRepositoryPath(directory, parent)
        : undefined;
    return {
      extends: resolvedParent,
      mappings,
    };
  } catch {
    return { mappings: [] };
  }
}

/** Reads the module path declared by a go.mod file. */
export function mappingsFromGoMod(
  source: string,
  directory: string,
): ImportPathMapping[] {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("module ")) continue;
    const modulePath = trimmed.slice("module ".length).trim();
    if (!modulePath) return [];
    const prefix = directory ? `${directory}/` : "";
    return [
      { pattern: `${modulePath}/*`, targets: [`${prefix}*`] },
      { pattern: modulePath, targets: [directory] },
    ];
  }
  return [];
}

/** Reads PSR-4 prefixes from a composer.json document. */
export function mappingsFromComposerJson(
  source: string,
  directory: string,
): ImportPathMapping[] {
  try {
    const parsed = JSON.parse(source) as {
      autoload?: { "psr-4"?: unknown };
      "autoload-dev"?: { "psr-4"?: unknown };
    };
    const prefixes = {
      ...(asStringRecord(parsed.autoload?.["psr-4"]) ?? {}),
      ...(asStringRecord(parsed["autoload-dev"]?.["psr-4"]) ?? {}),
    };
    return Object.entries(prefixes).flatMap(([prefix, target]) => {
      const pattern = prefix.endsWith("\\")
        ? `${prefix.replaceAll("\\", "/")}*`
        : prefix.replaceAll("\\", "/");
      const targets = resolveMappingTargets(
        directory,
        Array.isArray(target) ? target : [target],
      ).map((entry) =>
        pattern.endsWith("*") && !entry.endsWith("*")
          ? `${entry.endsWith("/") ? entry : `${entry}/`}*`
          : entry,
      );
      return targets.length > 0
        ? [{ pattern: pattern.replaceAll(/\/+/g, "/"), targets }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Narrows a Composer PSR-4 map to string targets. */
function asStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string | string[]> = {};
  for (const [key, target] of Object.entries(value)) {
    if (typeof target === "string") {
      record[key] = target;
      continue;
    }
    if (
      Array.isArray(target) &&
      target.every((entry) => typeof entry === "string")
    ) {
      record[key] = target;
    }
  }
  return record;
}

/**
 * Builds the import context declared by the project files of one revision.
 *
 * Files are applied from the repository root toward the reviewed file so a
 * nested package can override a workspace mapping. `extends` edges are left
 * for the loader to fetch; only documents already in hand are merged here.
 */
export function importMapsFromProjectFiles(
  files: readonly { content: string; path: string }[],
): ImportPathContext {
  const byPath = new Map(
    files.map((file) => [file.path.replaceAll("\\", "/"), file.content]),
  );
  const mappings: ImportPathMapping[] = [];
  const crateRoots: string[] = [];
  const seenTsconfig = new Set<string>();

  /** Applies one already-fetched config document to the growing context. */
  function applyFile(path: string) {
    const content = byPath.get(path);
    if (content === undefined) return;
    const directory = importConfigDirectory(path);
    const name = fileName(path);
    if (name === "package.json") {
      mappings.push(...mappingsFromPackageJson(content, directory));
      return;
    }
    if (
      name === "tsconfig.json" ||
      name === "jsconfig.json" ||
      name === "tsconfig.base.json"
    ) {
      if (seenTsconfig.has(path)) return;
      seenTsconfig.add(path);
      const parsed = mappingsFromTsconfig(content, directory);
      if (parsed.extends) applyFile(parsed.extends);
      mappings.push(...parsed.mappings);
      return;
    }
    if (name === "go.mod") {
      mappings.push(...mappingsFromGoMod(content, directory));
      return;
    }
    if (name === "composer.json") {
      mappings.push(...mappingsFromComposerJson(content, directory));
      return;
    }
    if (name === "Cargo.toml") {
      crateRoots.push(directory);
    }
  }

  for (const path of [...byPath.keys()].sort(
    (left, right) =>
      importConfigDirectory(left).split("/").filter(Boolean).length -
        importConfigDirectory(right).split("/").filter(Boolean).length ||
      left.localeCompare(right),
  )) {
    applyFile(path);
  }
  return { crateRoots, mappings };
}

/** Matches a specifier against one TypeScript/Node path pattern. */
function matchImportPattern(pattern: string, specifier: string) {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return specifier === pattern ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Substitutes a matched suffix into a mapping target. */
function substituteImportTarget(target: string, remainder: string) {
  const wildcard = target.indexOf("*");
  if (wildcard < 0) return remainder ? undefined : target;
  return `${target.slice(0, wildcard)}${remainder}${target.slice(wildcard + 1)}`;
}

/**
 * Applies the longest matching project mapping to one specifier.
 *
 * Equal-length matches prefer the mapping declared closer to the file, which
 * is the last one in the context because files are merged root-to-leaf.
 */
export function applyImportMappings(
  specifier: string,
  mappings: readonly ImportPathMapping[],
) {
  const normalizedSpecifier = specifier.replaceAll("\\", "/");
  let best:
    | { length: number; index: number; remainder: string; targets: string[] }
    | undefined;
  for (const [index, mapping] of mappings.entries()) {
    const remainder = matchImportPattern(mapping.pattern, normalizedSpecifier);
    if (remainder === undefined) continue;
    if (
      best &&
      (mapping.pattern.length < best.length ||
        (mapping.pattern.length === best.length && index < best.index))
    ) {
      continue;
    }
    const targets = mapping.targets.flatMap((target) => {
      const substituted = substituteImportTarget(target, remainder);
      const normalized =
        substituted === undefined
          ? undefined
          : normalizeRepositoryRelative(substituted);
      return normalized === undefined ? [] : [normalized];
    });
    if (targets.length === 0) continue;
    best = {
      length: mapping.pattern.length,
      index,
      remainder,
      targets,
    };
  }
  return best?.targets ?? [];
}

/** Merges two import contexts, with the overlay winning equal prefixes. */
export function mergeImportPathContexts(
  base: ImportPathContext | undefined,
  overlay: ImportPathContext | undefined,
): ImportPathContext {
  if (!base) return overlay ?? emptyContext;
  if (!overlay) return base;
  return {
    crateRoots: [...new Set([...base.crateRoots, ...overlay.crateRoots])],
    mappings: [...base.mappings, ...overlay.mappings],
  };
}
