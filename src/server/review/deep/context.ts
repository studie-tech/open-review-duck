import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import {
  bigPickleIgnoreMatcher,
  bigPickleSourceDecision,
} from "~/server/ai/source-policy";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import {
  persistSourceBlob,
  readSourceText,
} from "~/server/storage/source-blobs";

type Database = typeof database;

/** The revision tree is bounded exactly as the single-agent context bounds it. */
const MAX_TREE_PATHS = 20_000;
const MAX_UNITS = 5_000;
const IGNORE_FILE_LIMIT = 100;
const IGNORE_FILE_BYTES = 256_000;

/**
 * How much file text one run may keep resident.
 *
 * The cache exists so twenty-four children reading the same shared module cost
 * one provider request instead of twenty-four; it is not a correctness device,
 * so overflowing it simply stops caching rather than evicting mid-run.
 */
const MAX_CACHED_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * A run's context outlives its steps but not the process.
 *
 * Losing a cached entry costs one extra tree request, so an aggressive idle
 * sweep is always safe and an unbounded map never is.
 */
const CONTEXT_IDLE_MS = 15 * 60 * 1000;
const MAX_CACHED_RUNS = 8;

export type DeepReviewUnit = typeof reviewUnits.$inferSelect & {
  blobDigest: string | null;
  source: string;
  previousSource: string | null;
};

export interface DeepReviewSourceFile {
  blob: typeof sourceBlobs.$inferSelect;
  snapshotFileId?: string;
  source: string;
}

export interface DeepReviewChangedFile {
  snapshotFileId: string;
  path: string;
  previousPath: string | null;
  language: string;
  changeType: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  currentBlob: typeof sourceBlobs.$inferSelect | null;
  previousBlob: typeof sourceBlobs.$inferSelect | null;
}

export interface DeepReviewSearchInput {
  query: string;
  pathPrefix?: string;
  limit?: number;
}

export interface DeepReviewSearchHit {
  path: string;
  unitId: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  source: string;
}

export type DeepReviewSourceDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "protected_path" | "secret_detected" | "binary" | "ignored";
    };

export interface DeepReviewContext {
  /** The parent job every child of this run shares. */
  readonly runJobId: string;
  readonly snapshot: typeof reviewSnapshots.$inferSelect;
  readonly repository: typeof repositories.$inferSelect;
  listFiles(): Promise<readonly string[]>;
  readFile(
    path: string,
    maximumBytes: number,
  ): Promise<DeepReviewSourceFile | undefined>;
  readPreviousSource(path: string): Promise<string | undefined>;
  searchCode(input: DeepReviewSearchInput): Promise<DeepReviewSearchHit[]>;
  units(): Promise<readonly DeepReviewUnit[]>;
  changedFile(path: string): DeepReviewChangedFile | undefined;
  changedFiles(): readonly DeepReviewChangedFile[];
  sourceDecision(
    path: string,
    source: string,
  ): Promise<DeepReviewSourceDecision>;
  dispose(): void;
}

export interface DeepReviewContextInput {
  /** The parent job, or any child of it — both resolve to the same run. */
  job: typeof aiJobs.$inferSelect;
  /**
   * The revision the run is pinned to.
   *
   * A webhook re-sync mid-run creates a newer snapshot, so the run carries its
   * own snapshot rather than re-resolving the newest one per child.
   */
  snapshot?: typeof reviewSnapshots.$inferSelect;
}

interface CachedRunContext {
  context: Promise<DeepReviewContext>;
  lastUsedAt: number;
}

const runContexts = new Map<string, CachedRunContext>();

/** Identifies the run a job belongs to, which is its parent when it has one. */
export function deepReviewRunId(job: typeof aiJobs.$inferSelect): string {
  return job.parentJobId ?? job.id;
}

/** Keys the shared context by run and revision so a re-sync cannot alias it. */
function runContextKey(input: DeepReviewContextInput): string {
  return `${deepReviewRunId(input.job)}\0${input.snapshot?.id ?? input.job.snapshotId}`;
}

/** Drops idle and surplus runs so a long-lived worker cannot accumulate trees. */
function pruneRunContexts(now: number): void {
  for (const [key, entry] of runContexts) {
    if (now - entry.lastUsedAt > CONTEXT_IDLE_MS) runContexts.delete(key);
  }
  while (runContexts.size >= MAX_CACHED_RUNS) {
    const oldest = [...runContexts.entries()].sort(
      (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
    )[0];
    if (!oldest) return;
    runContexts.delete(oldest[0]);
  }
}

/** Forgets every cached run, used when a worker tears a deployment down. */
export function clearDeepReviewContexts(): void {
  runContexts.clear();
}

/**
 * Returns the one repository context shared by every child of a run.
 *
 * `createAiRepositoryContext` memoizes its file tree per instance, so building
 * one per child per turn would issue a recursive tree request against the
 * provider for every file in the run. The cache stores the in-flight promise,
 * so children dispatched in parallel wait on one build instead of racing to
 * duplicate it.
 */
export async function createDeepReviewContext(
  db: Database,
  input: DeepReviewContextInput,
): Promise<DeepReviewContext> {
  const key = runContextKey(input);
  const now = Date.now();
  const cached = runContexts.get(key);
  if (cached) {
    cached.lastUsedAt = now;
    return cached.context;
  }
  pruneRunContexts(now);
  const entry: CachedRunContext = {
    context: undefined as unknown as Promise<DeepReviewContext>,
    lastUsedAt: now,
  };
  // Disposing an old context must not evict a rebuilt one that took its key.
  const context = buildDeepReviewContext(db, input, () => {
    if (runContexts.get(key) === entry) runContexts.delete(key);
  });
  entry.context = context;
  runContexts.set(key, entry);
  // A failed build must not be remembered: the next child would inherit the
  // rejection forever instead of retrying against a transient provider error.
  context.catch(() => runContexts.delete(key));
  return context;
}

/** Builds the run-scoped repository accessors against one pinned revision. */
async function buildDeepReviewContext(
  db: Database,
  input: DeepReviewContextInput,
  evict: () => void,
): Promise<DeepReviewContext> {
  const { job } = input;
  if (input.snapshot && input.snapshot.id !== job.snapshotId) {
    throw new Error("Deep review job and snapshot disagree on the revision");
  }
  const snapshotId = input.snapshot?.id ?? job.snapshotId;
  const [scope] = await db
    .select({
      repository: repositories,
      snapshot: reviewSnapshots,
      connection: providerConnections,
    })
    .from(reviewSnapshots)
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .where(
      and(
        eq(reviewSnapshots.id, snapshotId),
        eq(repositories.workspaceId, job.workspaceId),
      ),
    )
    .limit(1);
  if (!scope) throw new Error("Deep review repository scope not found");

  const previousBlobs = alias(sourceBlobs, "deep_review_previous_blob");
  const changedRows = await db
    .select({
      file: snapshotFiles,
      currentBlob: sourceBlobs,
      previousBlob: previousBlobs,
    })
    .from(snapshotFiles)
    .leftJoin(sourceBlobs, eq(snapshotFiles.currentBlobId, sourceBlobs.id))
    .leftJoin(previousBlobs, eq(snapshotFiles.previousBlobId, previousBlobs.id))
    .where(eq(snapshotFiles.snapshotId, snapshotId));
  const changedByPath = new Map<string, DeepReviewChangedFile>(
    changedRows.map((row) => [
      row.file.path,
      {
        snapshotFileId: row.file.id,
        path: row.file.path,
        previousPath: row.file.previousPath,
        language: row.file.language,
        changeType: row.file.changeType,
        additions: row.file.additions,
        deletions: row.file.deletions,
        isBinary: row.file.isBinary,
        currentBlob: row.currentBlob,
        previousBlob: row.previousBlob,
      },
    ]),
  );

  // Memoizing the promise rather than its result is what makes the sharing
  // real: children run concurrently, so a value memoized after the await would
  // still let every child in flight issue its own provider request.
  let paths: Promise<string[]> | undefined;
  let connected: ReturnType<typeof providerForConnection> | undefined;
  let hydratedUnits: Promise<readonly DeepReviewUnit[]> | undefined;
  let ignored: Promise<(path: string) => boolean> | undefined;
  const fileCache = new Map<string, DeepReviewSourceFile>();
  const previousCache = new Map<string, string>();
  let cachedBytes = 0;

  /** Authenticates against the provider once for every child of the run. */
  const connect = () => {
    connected ??= providerForConnection(db, scope.connection);
    return connected;
  };

  /** Resolves the revision tree once for the whole run rather than per turn. */
  const listFiles = () => {
    paths ??= (async () => {
      const provider = await connect();
      const revisionPaths = await provider.listRepositoryFiles(
        scope.repository.externalId,
        scope.snapshot.headSha,
      );
      return [...new Set([...revisionPaths, ...changedByPath.keys()])]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, MAX_TREE_PATHS);
    })();
    return paths;
  };

  /** Keeps a bounded amount of file text resident for the rest of the run. */
  const cacheFile = (path: string, file: DeepReviewSourceFile) => {
    const bytes = Buffer.byteLength(file.source);
    if (cachedBytes + bytes > MAX_CACHED_SOURCE_BYTES) return file;
    cachedBytes += bytes;
    fileCache.set(path, file);
    return file;
  };

  /** Reads one file at the pinned revision, preferring the snapshot's own blob. */
  const readFile = async (path: string, maximumBytes: number) => {
    const cachedFile = fileCache.get(path);
    // A later caller with a smaller ceiling must still be refused, so the cap
    // is applied to the cached text rather than only at fetch time.
    if (cachedFile) {
      return Buffer.byteLength(cachedFile.source) > maximumBytes
        ? undefined
        : cachedFile;
    }
    if (!(await listFiles()).includes(path)) return undefined;
    const changed = changedByPath.get(path);
    if (changed?.currentBlob) {
      const source = await readSourceText(changed.currentBlob);
      if (Buffer.byteLength(source) > maximumBytes) return undefined;
      return cacheFile(path, {
        blob: changed.currentBlob,
        snapshotFileId: changed.snapshotFileId,
        source,
      });
    }
    const provider = await connect();
    const source = await provider.getFileContent(
      scope.repository.externalId,
      path,
      scope.snapshot.headSha,
      maximumBytes,
    );
    if (source === undefined) return undefined;
    const blob = await persistSourceBlob(db, {
      workspaceId: job.workspaceId,
      bytes: Buffer.from(source),
    });
    return cacheFile(path, { blob, source });
  };

  /** Reads the pre-merge text of a modified or deleted file from its snapshot. */
  const readPreviousSource = async (path: string) => {
    const cachedSource = previousCache.get(path);
    if (cachedSource !== undefined) return cachedSource;
    const blob = changedByPath.get(path)?.previousBlob;
    if (!blob) return undefined;
    const source = await readSourceText(blob);
    const bytes = Buffer.byteLength(source);
    if (cachedBytes + bytes <= MAX_CACHED_SOURCE_BYTES) {
      cachedBytes += bytes;
      previousCache.set(path, source);
    }
    return source;
  };

  /** Hydrates the snapshot's units once, not once per child agent turn. */
  const units = () => {
    hydratedUnits ??= db.query.reviewUnits
      .findMany({
        where: eq(reviewUnits.snapshotId, snapshotId),
        orderBy: [asc(reviewUnits.reviewOrder)],
        limit: MAX_UNITS,
      })
      .then((stored) => hydrateReviewUnits(db, stored));
    return hydratedUnits;
  };

  /** Loads the repository's ignore rules once for the free-tier source policy. */
  const ignoreMatcher = () => {
    ignored ??= (async () => {
      const candidates = (await listFiles())
        .filter(
          (path) =>
            path === ".gitignore" ||
            path === ".openreviewignore" ||
            path.endsWith("/.gitignore") ||
            path.endsWith("/.openreviewignore"),
        )
        .slice(0, IGNORE_FILE_LIMIT);
      const files = (
        await Promise.all(
          candidates.map(async (path) => {
            const file = await readFile(path, IGNORE_FILE_BYTES);
            return file ? { path, source: file.source } : undefined;
          }),
        )
      ).filter((file) => file !== undefined);
      return bigPickleIgnoreMatcher(files);
    })();
    return ignored;
  };

  return {
    runJobId: deepReviewRunId(job),
    snapshot: scope.snapshot,
    repository: scope.repository,
    listFiles,
    readFile,
    readPreviousSource,
    units,
    changedFile: (path) => changedByPath.get(path),
    changedFiles: () => [...changedByPath.values()],
    async searchCode(input) {
      const query = input.query.toLowerCase();
      return (await units())
        .filter(
          (unit) =>
            (!input.pathPrefix || unit.path.startsWith(input.pathPrefix)) &&
            unit.source.toLowerCase().includes(query),
        )
        .slice(0, Math.max(1, Math.min(input.limit ?? 100, 100)))
        .map((unit) => ({
          path: unit.path,
          unitId: unit.id,
          symbol: unit.name,
          kind: unit.kind,
          startLine: unit.startLine,
          endLine: unit.endLine,
          source: unit.source,
        }));
    },
    async sourceDecision(path, source) {
      // Deep review runs on a local appliance's free tier by default, where the
      // single-agent loop already refuses protected paths and detected secrets.
      // A new prompt path that skipped the check would leak what today's path
      // withholds.
      if (job.provider !== "opencode") return { allowed: true };
      if ((await ignoreMatcher())(path)) {
        return { allowed: false, reason: "ignored" };
      }
      const decision = bigPickleSourceDecision(path, source);
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, reason: decision.reason };
    },
    dispose: evict,
  };
}
