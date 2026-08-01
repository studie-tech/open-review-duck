import "server-only";

import { createHash, createHmac } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";
import { createUploadthing, UTFiles } from "uploadthing/next";
import { UploadThingError, UTApi } from "uploadthing/server";
import { z } from "zod";
import {
  repositories,
  semanticArtifacts,
  semanticUploadCredentials,
  sourceBlobs,
} from "@/drizzle/schema";
import { env } from "~/env";
import { db } from "~/server/db";
import { parseScipIndex } from "./scip";

const upload = createUploadthing();
const input = z.object({
  repositoryId: z.string().uuid(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  declaredSize: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
});

export const semanticFileRouter = {
  scip: upload({
    blob: {
      maxFileCount: 1,
      maxFileSize: "64MB",
      contentDisposition: "attachment",
      acl: "private",
    },
  })
    .input(input)
    .middleware(async ({ input, files, req }) => {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token) throw new UploadThingError("Unauthorized");
      const credentials = await db
        .select({
          id: semanticUploadCredentials.id,
          tokenHash: semanticUploadCredentials.tokenHash,
          workspaceId: repositories.workspaceId,
        })
        .from(semanticUploadCredentials)
        .innerJoin(
          repositories,
          eq(semanticUploadCredentials.repositoryId, repositories.id),
        )
        .where(
          and(
            eq(semanticUploadCredentials.repositoryId, input.repositoryId),
            isNull(semanticUploadCredentials.revokedAt),
          ),
        )
        .limit(20);
      let authorized = credentials[0];
      for (const candidate of credentials) {
        if (await verify(candidate.tokenHash, token)) {
          authorized = candidate;
          break;
        }
      }
      if (
        !authorized ||
        !(await verify(authorized.tokenHash, token)) ||
        files.length !== 1 ||
        files[0]?.size !== input.declaredSize
      ) {
        throw new UploadThingError("Unauthorized or invalid SCIP upload");
      }
      if (!env.STORAGE_ID_KEY) {
        throw new UploadThingError("SCIP storage identity is not configured");
      }
      const customId = createHmac("sha256", env.STORAGE_ID_KEY)
        .update(authorized.workspaceId)
        .update("\0")
        .update(input.repositoryId)
        .update("\0")
        .update(input.commitSha)
        .update("\0")
        .update(input.digest)
        .digest("base64url");
      return {
        credentialId: authorized.id,
        workspaceId: authorized.workspaceId,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        digest: input.digest,
        declaredSize: input.declaredSize,
        [UTFiles]: files.map((file) => ({
          ...file,
          name: "semantic-index.scip",
          customId,
        })),
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      if (!env.UPLOADTHING_TOKEN)
        throw new Error("UploadThing is not configured");
      const api = new UTApi({ token: env.UPLOADTHING_TOKEN });
      const { ufsUrl } = await api.generateSignedURL(file.key, {
        expiresIn: 300,
      });
      const response = await fetch(ufsUrl, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("SCIP artifact could not be verified");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== metadata.declaredSize ||
        digest !== metadata.digest
      ) {
        await api.deleteFiles(file.key);
        throw new Error("SCIP artifact size or digest mismatch");
      }
      let semanticIndex: ReturnType<typeof parseScipIndex>;
      try {
        semanticIndex = parseScipIndex(bytes);
      } catch (cause) {
        await api.deleteFiles(file.key);
        throw new Error(
          cause instanceof Error ? cause.message : "Malformed SCIP artifact",
        );
      }
      const [blob] = await db
        .insert(sourceBlobs)
        .values({
          workspaceId: metadata.workspaceId,
          digest,
          storage: "uploadthing",
          state: "ready",
          objectKey: file.key,
          customId: file.customId ?? undefined,
          byteLength: bytes.byteLength,
          mediaType: "application/scip",
          encoding: "binary",
        })
        .onConflictDoUpdate({
          target: [sourceBlobs.workspaceId, sourceBlobs.digest],
          set: { state: "ready", objectKey: file.key },
        })
        .returning();
      if (!blob) throw new Error("SCIP source object could not be persisted");
      await db
        .insert(semanticArtifacts)
        .values({
          workspaceId: metadata.workspaceId,
          repositoryId: metadata.repositoryId,
          commitSha: metadata.commitSha,
          digest,
          sourceBlobId: blob.id,
          status: "ready",
          byteLength: bytes.byteLength,
          validatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [semanticArtifacts.repositoryId, semanticArtifacts.commitSha],
          set: {
            digest,
            sourceBlobId: blob.id,
            status: "ready",
            byteLength: bytes.byteLength,
            validatedAt: new Date(),
          },
        });
      await db
        .update(semanticUploadCredentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(semanticUploadCredentials.id, metadata.credentialId));
      return {
        accepted: true,
        digest,
        documents: semanticIndex.documentCount,
        occurrences: semanticIndex.occurrenceCount,
      };
    }),
};

export type SemanticFileRouter = typeof semanticFileRouter;
