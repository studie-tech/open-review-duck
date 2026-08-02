import "server-only";

import { and, eq } from "drizzle-orm";
import {
  type aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import { searchExactScipArtifact } from "~/server/semantic";
import {
  persistSourceBlob,
  readSourceText,
} from "~/server/storage/source-blobs";

type Database = typeof database;

interface RepositoryContext {
  listFiles(): Promise<string[]>;
  searchSemantics(query: string): ReturnType<typeof searchExactScipArtifact>;
  readFile(
    path: string,
    maximumBytes: number,
  ): Promise<
    | {
        blob: typeof sourceBlobs.$inferSelect;
        snapshotFileId?: string;
        source: string;
      }
    | undefined
  >;
}

/** Builds exact-revision repository tools for one authorized AI job. */
export async function createAiRepositoryContext(
  db: Database,
  job: typeof aiJobs.$inferSelect,
): Promise<RepositoryContext> {
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
        eq(reviewSnapshots.id, job.snapshotId),
        eq(repositories.workspaceId, job.workspaceId),
      ),
    )
    .limit(1);
  if (!scope) throw new Error("AI repository scope not found");

  const changedFiles = await db
    .select({
      id: snapshotFiles.id,
      path: snapshotFiles.path,
      blob: sourceBlobs,
    })
    .from(snapshotFiles)
    .leftJoin(sourceBlobs, eq(snapshotFiles.currentBlobId, sourceBlobs.id))
    .where(eq(snapshotFiles.snapshotId, job.snapshotId));
  const changedByPath = new Map(
    changedFiles.map((file) => [file.path, file] as const),
  );
  let paths: string[] | undefined;
  let provider: Awaited<ReturnType<typeof providerForConnection>> | undefined;

  /** Resolves the revision tree once and keeps it bounded for the current turn. */
  const listFiles = async () => {
    if (paths) return paths;
    provider ??= await providerForConnection(db, scope.connection);
    const revisionPaths = await provider.listRepositoryFiles(
      scope.repository.externalId,
      scope.snapshot.headSha,
    );
    paths = [...new Set([...revisionPaths, ...changedByPath.keys()])]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 20_000);
    return paths;
  };

  return {
    listFiles,
    searchSemantics: (query) =>
      searchExactScipArtifact(db, {
        commitSha: scope.snapshot.headSha,
        query,
        repositoryId: scope.repository.id,
      }),
    async readFile(path, maximumBytes) {
      if (!(await listFiles()).includes(path)) return undefined;
      const changed = changedByPath.get(path);
      if (changed?.blob) {
        const source = await readSourceText(changed.blob);
        if (Buffer.byteLength(source) > maximumBytes) return undefined;
        return {
          blob: changed.blob,
          snapshotFileId: changed.id,
          source,
        };
      }
      provider ??= await providerForConnection(db, scope.connection);
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
      return { blob, source };
    },
  };
}
