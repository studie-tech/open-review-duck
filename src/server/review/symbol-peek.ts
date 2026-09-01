import "server-only";

import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { z } from "zod";
import { type providerConnections, reviewUnits } from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import {
  findImportedDeclarationLine,
  importPathCandidates,
} from "~/lib/import-navigation";
import { SYMBOL_PEEK_MAXIMUM_LINES } from "~/lib/symbol-peek";
import { analyzeFiles } from "~/server/analysis/engine";
import { parseImportReferences } from "~/server/analysis/imports";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import {
  ProviderError,
  type PullRequestProvider,
} from "~/server/providers/types";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import type { symbolDefinitionSchema } from "~/validators/review";

type SymbolDefinitionInput = z.infer<typeof symbolDefinitionSchema>;

/** Shapes one declaration as the definition card the reviewer reads. */
function symbolDefinitionOf(
  unit: {
    endLine: number;
    kind: string;
    language: string;
    name: string;
    path: string;
    signature?: string | null;
    source: string;
    startLine: number;
  },
  focusLine: number | undefined,
  unitId?: string,
) {
  const lines = unit.source.split("\n");
  return {
    kind: "definition" as const,
    endLine: unit.startLine + Math.max(0, lines.length - 1),
    focusLine: focusLine ?? unit.startLine,
    language: unit.language,
    name: unit.name,
    path: unit.path,
    signature: unit.signature ?? undefined,
    source: unit.source,
    startLine: unit.startLine,
    unitId,
    unitKind: unit.kind,
  };
}

/**
 * Looks the name up among the declarations the snapshot already stores.
 *
 * The reviewed file's own declarations answer first, because a name used in a
 * file usually belongs to it; a name declared exactly once anywhere else in
 * the change answers next, and an ambiguous one is left to the file parse
 * rather than guessed at.
 */
export async function declaredSymbolInSnapshot(
  db: typeof database,
  snapshotId: string,
  input: SymbolDefinitionInput,
) {
  const matches = await db.query.reviewUnits.findMany({
    where: and(
      eq(reviewUnits.snapshotId, snapshotId),
      eq(reviewUnits.name, input.symbol),
      notInArray(reviewUnits.kind, ["file", "module", "binary"]),
    ),
    orderBy: [reviewUnits.reviewOrder],
    limit: 25,
  });
  const own = matches.filter(({ path }) => path === input.sourcePath);
  const chosen = own[0] ?? (matches.length === 1 ? matches[0] : undefined);
  if (!chosen) return undefined;
  // Every candidate had to be read to know which one answers; only the one
  // that does needs its source pulled out of storage.
  const [target] = await hydrateReviewUnits(db, [chosen]);
  return target
    ? symbolDefinitionOf(target, target.startLine, target.id)
    : undefined;
}

/**
 * How many parsed files the symbol lookup keeps declarations for.
 *
 * Each entry holds the declarations of one file at one immutable snapshot
 * revision. One reviewer moves between a handful of files, but the ring is
 * shared by everyone an instance is serving, so it is sized for several of
 * them at once rather than for one: too small and concurrent reviewers evict
 * each other's files and pay for the parse again on the next name.
 */
const SYMBOL_FILE_CACHE_LIMIT = 64;

/**
 * How much source the parse cache may hold across every file it remembers.
 *
 * Entry count alone bounds nothing useful: sixty-four files at the read limit
 * is far more memory than sixty-four small ones, and the ring is shared by
 * everyone an instance serves.
 */
const SYMBOL_FILE_CACHE_CHARACTERS = 2_000_000;

/**
 * How many candidate paths of each shape one name may read from the provider.
 *
 * A specifier without an extension stands for a file under any of its
 * language's extensions and for a directory's index under each of them, and
 * every candidate that misses is a request. The two shapes are bounded
 * separately so a bound can never put a directory import out of reach.
 */
const MAXIMUM_IMPORT_READS = 8;

const DIRECTORY_IMPORT = /\/(?:index\.[^./]+|__init__\.py)$/;

/**
 * How many candidate paths one wave of import probes may hold open at once.
 *
 * A wave is what the provider is asked for before any of it is judged, so it
 * is the most a resolution can overspend by, and it is held to the same bound
 * the reads for a single name are given.
 */
const IMPORT_PROBE_WAVE = 8;

/** One candidate path's read: its content, a 404, or the failure. */
type ImportCandidateRead =
  | { kind: "content"; content: string | undefined; path: string }
  | { kind: "failed"; cause: unknown; path: string }
  | { kind: "missing" };

/**
 * Reads import candidates in waves, yielding each read in candidate order.
 *
 * At most one candidate is the file, so every path ahead of it is a 404 a
 * hover waits through. Probing a wave at a time overlaps those misses while
 * the order the runtime itself resolves in still decides the answer, and
 * leaving the iterator early means the waves behind it are never requested.
 */
export async function* importCandidateReads(
  provider: Pick<PullRequestProvider, "getFileContent">,
  repositoryExternalId: string,
  headSha: string,
  candidates: string[],
) {
  for (let start = 0; start < candidates.length; start += IMPORT_PROBE_WAVE) {
    yield* await mapWithLimit(
      candidates.slice(start, start + IMPORT_PROBE_WAVE),
      IMPORT_PROBE_WAVE,
      async (path): Promise<ImportCandidateRead> => {
        try {
          return {
            kind: "content",
            content: await provider.getFileContent(
              repositoryExternalId,
              path,
              headSha,
              150_000,
            ),
            path,
          };
        } catch (cause) {
          if (cause instanceof ProviderError && cause.status === 404) {
            return { kind: "missing" };
          }
          return { kind: "failed", cause, path };
        }
      },
    );
  }
}

interface ParsedSymbolFile {
  declarations: Map<string, ReturnType<typeof symbolDefinitionOf>>;
  imports: ReturnType<typeof parseImportReferences>;
  language: string;
  source: string;
}

/**
 * Narrows a whole file to the lines a definition card can actually show.
 *
 * A module answers when no declaration in it does, and the file behind it may
 * run to the read limit while the card shows under twenty lines. Sending the
 * rest would spend the payload of every hover on lines nobody reads.
 */
function windowedModuleSource<
  Unit extends { source: string; startLine: number },
>(unit: Unit, focusLine: number | undefined) {
  const lines = unit.source.split("\n");
  const lead = 2;
  const offset = Math.min(
    Math.max(0, (focusLine ?? unit.startLine) - unit.startLine - lead),
    Math.max(0, lines.length - 1),
  );
  return {
    ...unit,
    source: lines
      .slice(offset, offset + SYMBOL_PEEK_MAXIMUM_LINES + lead * 2)
      .join("\n"),
    startLine: unit.startLine + offset,
  };
}

const symbolFileCache = new Map<string, ParsedSymbolFile>();
const symbolFileCacheWeights = new Map<string, number>();
let symbolFileCacheCharacters = 0;

/**
 * Parses the whole reviewed file to find a declaration the diff left out.
 *
 * Only changed declarations become review units, so a helper the reviewer is
 * calling is often present in the file and absent from the snapshot's units.
 * The file's stored source is already at hand, so this needs no provider call.
 *
 * Peek fires on hover, and one parse answers every name in the file, so the
 * declarations and imports are kept against the snapshot revision they came
 * from instead of running the analysis again for the next name on the same
 * line.
 */
export async function parsedSymbolFile(
  db: typeof database,
  snapshotId: string,
  input: SymbolDefinitionInput,
) {
  const key = `${snapshotId}\0${input.sourcePath}`;
  const cached = symbolFileCache.get(key);
  if (cached) {
    // Re-inserting keeps the files a reviewer is moving between at the end of
    // the ring, so the one evicted next is the one longest unused.
    symbolFileCache.delete(key);
    symbolFileCache.set(key, cached);
    return cached;
  }

  const [file] = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshotId),
        eq(reviewUnits.path, input.sourcePath),
        eq(reviewUnits.kind, "file"),
      ),
      limit: 1,
    }),
  );
  if (!file?.source) return undefined;
  const declarations: ParsedSymbolFile["declarations"] = new Map();
  for (const unit of analyzeFiles([
    {
      path: input.sourcePath,
      content: file.source,
      changeType: "modified",
      reviewWholeFile: true,
    },
  ]).units) {
    if (unit.kind === "file" || unit.kind === "module") continue;
    // The first declaration of a name wins, the same way a single `find` did.
    if (!declarations.has(unit.name)) {
      declarations.set(unit.name, symbolDefinitionOf(unit, unit.startLine));
    }
  }
  // Two hovers on the same file can both miss while the first is still
  // reading it, and both arrive here. The entry they overwrite has to leave
  // the total, or it keeps a surplus that eventually empties the ring on
  // every insert and quietly costs a parse per hover.
  symbolFileCacheCharacters -= symbolFileCacheWeights.get(key) ?? 0;
  const parsed = {
    declarations,
    imports: parseImportReferences(file.source, input.sourceLanguage),
    language: input.sourceLanguage,
    source: file.source,
  } satisfies ParsedSymbolFile;
  symbolFileCache.set(key, parsed);
  symbolFileCacheCharacters += file.source.length;
  symbolFileCacheWeights.set(key, file.source.length);
  while (
    symbolFileCache.size > SYMBOL_FILE_CACHE_LIMIT ||
    symbolFileCacheCharacters > SYMBOL_FILE_CACHE_CHARACTERS
  ) {
    const oldest = symbolFileCache.keys().next().value;
    if (oldest === undefined) break;
    symbolFileCache.delete(oldest);
    symbolFileCacheCharacters -= symbolFileCacheWeights.get(oldest) ?? 0;
    symbolFileCacheWeights.delete(oldest);
  }
  return parsed;
}

/**
 * Follows the file's own import of a name into the file that declares it.
 *
 * Reached only once the change itself has nothing to say about the name, and
 * only when the reviewer's file names where it came from, so the one provider
 * read this can cost is spent on a name that has no cheaper answer.
 */
export async function importedSymbolDefinition(
  db: typeof database,
  userId: string,
  snapshot: { headSha: string; id: string },
  scope: {
    connection: typeof providerConnections.$inferSelect;
    pullRequestId: string;
    repositoryExternalId: string;
  },
  input: SymbolDefinitionInput,
) {
  if (!input.specifier) return undefined;
  const imported = input.imported ?? input.symbol;
  const candidates = importPathCandidates(
    input.sourcePath,
    input.specifier,
    input.sourceLanguage,
  );
  if (candidates.length === 0) return undefined;

  const stored = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshot.id),
        inArray(reviewUnits.path, candidates),
        eq(reviewUnits.name, imported),
      ),
      orderBy: [reviewUnits.reviewOrder],
      limit: 1,
    }),
  );
  const [known] = stored;
  if (known) return symbolDefinitionOf(known, known.startLine, known.id);

  // Only now does a hover become provider traffic, and one unresolved name can
  // try every extension the specifier could carry. The repository pays for that
  // fan-out, so it is gated per pull request the way every other
  // provider-backed procedure in this router is.
  await enforceRateLimit(
    db,
    `review-symbol-resource:${userId}:${scope.pullRequestId}`,
    30,
    60_000,
  );
  const provider = await providerForConnection(db, scope.connection);
  // A file answers before the directory of the same name, the way the runtime
  // resolves it, so the two are bounded apart rather than as one list: a flat
  // bound would spend itself on extensions and never reach an index at all.
  const reads = [
    ...candidates
      .filter((path) => !DIRECTORY_IMPORT.test(path))
      .slice(0, MAXIMUM_IMPORT_READS),
    ...candidates
      .filter((path) => DIRECTORY_IMPORT.test(path))
      .slice(0, MAXIMUM_IMPORT_READS),
  ];
  for await (const read of importCandidateReads(
    provider,
    scope.repositoryExternalId,
    snapshot.headSha,
    reads,
  )) {
    if (read.kind === "missing") continue;
    if (read.kind === "failed") {
      // A peek must not break the review, so a refused or rate-limited
      // provider is answered softly — but it is not the same answer as "this
      // name has no declaration", and an expired token has to be diagnosable.
      console.error("Symbol definition lookup could not read the source", {
        path: read.path,
        pullRequestId: scope.pullRequestId,
        status:
          read.cause instanceof ProviderError ? read.cause.status : undefined,
        message:
          read.cause instanceof Error ? read.cause.message : String(read.cause),
      });
      return { kind: "unresolved" as const, reason: "unavailable" as const };
    }
    if (read.content === undefined) {
      return { kind: "unresolved" as const, reason: "too_large" as const };
    }
    const analyzed = analyzeFiles([
      { path: read.path, content: read.content, changeType: "modified" },
    ]).units;
    const declaration = analyzed.find(
      (unit) =>
        unit.name === imported &&
        unit.kind !== "file" &&
        unit.kind !== "module",
    );
    if (declaration) {
      return symbolDefinitionOf(declaration, declaration.startLine);
    }
    const module = analyzed.find((unit) => unit.kind === "file");
    if (module) {
      const focusLine = findImportedDeclarationLine(
        module.source,
        imported,
        module.language,
        module.startLine,
      );
      const windowed = windowedModuleSource(module, focusLine);
      return symbolDefinitionOf(windowed, focusLine ?? windowed.startLine);
    }
  }
  return undefined;
}
