import "server-only";

import { mapWithLimit } from "~/lib/concurrency";
import {
  emptyImportPathContext,
  type ImportPathContext,
  importConfigDirectory,
  importMapsFromProjectFiles,
  mappingsFromTsconfig,
  PROJECT_IMPORT_CONFIG_NAMES,
} from "~/lib/import-maps";
import {
  ProviderError,
  type PullRequestProvider,
} from "~/server/providers/types";

const MAXIMUM_CONFIG_BYTES = 80_000;
const MAXIMUM_TSCONFIG_EXTENDS = 3;
const CONFIG_CACHE_LIMIT = 32;

const ROOT_CONFIGS = [
  "Cargo.toml",
  "composer.json",
  "go.mod",
  "jsconfig.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
] as const;

const NESTED_CONFIGS = [
  "Cargo.toml",
  "jsconfig.json",
  "package.json",
  "tsconfig.json",
] as const;

interface CachedProjectFiles {
  files: Map<string, string | null>;
  contexts: Map<string, ImportPathContext>;
}

const projectFileCache = new Map<string, CachedProjectFiles>();

/** Returns ancestor directories from the repository root to a source file. */
function ancestorDirectories(sourcePath: string) {
  const normalized = sourcePath.replaceAll("\\", "/");
  const directory = importConfigDirectory(normalized);
  const directories = [""];
  if (!directory) return directories;
  let current = "";
  for (const segment of directory.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    directories.push(current);
  }
  return directories;
}

/**
 * Names the project files that can describe imports for one source path.
 *
 * The repository root is always consulted. Every ancestor directory is asked
 * for a package or tsconfig so a monorepo workspace can override the root.
 */
export function projectImportConfigPaths(sourcePath: string) {
  const paths = new Set<string>(ROOT_CONFIGS);
  for (const directory of ancestorDirectories(sourcePath).filter(Boolean)) {
    for (const name of NESTED_CONFIGS) {
      paths.add(`${directory}/${name}`);
    }
  }
  return [...paths];
}

/** Reads one set of project files through the provider's cheapest API. */
async function readProjectFiles(
  provider: Pick<PullRequestProvider, "getFileContent" | "getFileContents">,
  repositoryExternalId: string,
  headSha: string,
  paths: readonly string[],
) {
  if (paths.length === 0) return [] as { content: string; path: string }[];
  if (provider.getFileContents) {
    const batch = await provider.getFileContents(
      repositoryExternalId,
      [...paths],
      headSha,
      MAXIMUM_CONFIG_BYTES,
    );
    return batch.flatMap((file) =>
      file.content ? [{ path: file.path, content: file.content }] : [],
    );
  }
  const reads = await mapWithLimit([...paths], 8, async (path) => {
    try {
      const content = await provider.getFileContent(
        repositoryExternalId,
        path,
        headSha,
        MAXIMUM_CONFIG_BYTES,
      );
      return content ? { path, content } : undefined;
    } catch (cause) {
      if (cause instanceof ProviderError && cause.status === 404) {
        return undefined;
      }
      throw cause;
    }
  });
  return reads.filter(
    (file): file is { content: string; path: string } => file !== undefined,
  );
}

/** Remembers fetched project files against one snapshot revision. */
function cachedSnapshotFiles(snapshotId: string) {
  const cached = projectFileCache.get(snapshotId);
  if (cached) {
    projectFileCache.delete(snapshotId);
    projectFileCache.set(snapshotId, cached);
    return cached;
  }
  const created = {
    files: new Map<string, string | null>(),
    contexts: new Map<string, ImportPathContext>(),
  } satisfies CachedProjectFiles;
  projectFileCache.set(snapshotId, created);
  while (projectFileCache.size > CONFIG_CACHE_LIMIT) {
    const oldest = projectFileCache.keys().next().value;
    if (oldest === undefined) break;
    projectFileCache.delete(oldest);
  }
  return created;
}

/** Follows relative tsconfig `extends` edges that have not been fetched yet. */
function missingTsconfigExtends(files: Map<string, string | null>): string[] {
  const missing: string[] = [];
  for (const [path, content] of files) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (
      content === null ||
      content === undefined ||
      !PROJECT_IMPORT_CONFIG_NAMES.has(name) ||
      (!name.includes("tsconfig") && name !== "jsconfig.json")
    ) {
      continue;
    }
    const parent = mappingsFromTsconfig(
      content,
      importConfigDirectory(path),
    ).extends;
    if (parent && !files.has(parent)) missing.push(parent);
  }
  return missing;
}

/**
 * Loads the import maps declared beside a reviewed file at this snapshot.
 *
 * Results are cached per snapshot and source path. A missing or unreadable
 * config is treated as an empty context so a hover still falls back to
 * relative imports and language layout.
 */
export async function projectImportMaps(
  provider: Pick<PullRequestProvider, "getFileContent" | "getFileContents">,
  repositoryExternalId: string,
  headSha: string,
  snapshotId: string,
  sourcePath: string,
): Promise<ImportPathContext> {
  const cache = cachedSnapshotFiles(snapshotId);
  const cached = cache.contexts.get(sourcePath);
  if (cached) return cached;
  try {
    const wanted = new Set(projectImportConfigPaths(sourcePath));
    for (let hop = 0; hop <= MAXIMUM_TSCONFIG_EXTENDS; hop += 1) {
      const unread = [...wanted].filter((path) => !cache.files.has(path));
      if (unread.length === 0) break;
      const fetched = await readProjectFiles(
        provider,
        repositoryExternalId,
        headSha,
        unread,
      );
      const found = new Set(fetched.map((file) => file.path));
      for (const file of fetched) {
        cache.files.set(file.path, file.content);
      }
      for (const path of unread) {
        if (!found.has(path)) cache.files.set(path, null);
      }
      for (const path of missingTsconfigExtends(cache.files)) {
        wanted.add(path);
      }
    }
    const context = importMapsFromProjectFiles(
      [...cache.files].flatMap(([path, content]) =>
        content ? [{ path, content }] : [],
      ),
    );
    cache.contexts.set(sourcePath, context);
    return context;
  } catch (cause) {
    console.error("Project import maps could not be loaded", {
      sourcePath,
      snapshotId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    cache.contexts.set(sourcePath, emptyImportPathContext());
    return emptyImportPathContext();
  }
}
