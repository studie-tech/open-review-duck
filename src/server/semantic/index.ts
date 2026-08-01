import "server-only";

import { and, eq } from "drizzle-orm";
import { semanticArtifacts, sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { readSourceBlob } from "~/server/storage/source-blobs";
import { parseScipIndex, type ScipIndex, searchScipIndex } from "./scip";

type Database = typeof database;

const indexCache = new Map<string, ScipIndex>();

/** Searches semantic data only when it exactly matches the requested revision. */
export async function searchExactScipArtifact(
  db: Database,
  input: { commitSha: string; query: string; repositoryId: string },
) {
  const [artifact] = await db
    .select({ artifact: semanticArtifacts, blob: sourceBlobs })
    .from(semanticArtifacts)
    .innerJoin(sourceBlobs, eq(semanticArtifacts.sourceBlobId, sourceBlobs.id))
    .where(
      and(
        eq(semanticArtifacts.repositoryId, input.repositoryId),
        eq(semanticArtifacts.commitSha, input.commitSha),
        eq(semanticArtifacts.status, "ready"),
      ),
    )
    .limit(1);
  if (!artifact) return { available: false as const, matches: [] };
  let index = indexCache.get(artifact.artifact.digest);
  if (!index) {
    index = parseScipIndex(await readSourceBlob(artifact.blob));
    if (indexCache.size >= 8) {
      indexCache.delete(indexCache.keys().next().value ?? "");
    }
    indexCache.set(artifact.artifact.digest, index);
  }
  return {
    available: true as const,
    matches: searchScipIndex(index, input.query),
  };
}
