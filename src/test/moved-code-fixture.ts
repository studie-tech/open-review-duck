import { randomUUID } from "node:crypto";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  snapshotFiles,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { analyzeFiles } from "~/server/analysis/engine";
import type { SourceFile } from "~/server/analysis/types";
import { db } from "~/server/db";
import { persistSourceBlob } from "~/server/storage/source-blobs";
import { persistSnapshotAnalysis } from "~/server/sync/persist-snapshot-analysis";

const shipping =
  "export function shippingCost(subtotal: number) {\n  if (subtotal >= 50) return 0;\n  return 5;\n}";
const subtotal =
  "export function subtotal(items: Item[]) {\n  return items.reduce((sum, item) =>\n    sum + item.price * item.quantity, 0);\n}";

/** Seeds a real analyzed snapshot with an edited extraction, a pure move and rewired imports. */
export async function createMovedCodeFixture(
  ownerId = `integration-${randomUUID()}`,
) {
  const workspaceId = randomUUID();
  const connectionId = randomUUID();
  const repositoryId = randomUUID();
  const pullRequestId = randomUUID();
  const snapshotId = randomUUID();
  await db.insert(users).values({ id: ownerId }).onConflictDoNothing();
  await db.insert(workspaces).values({
    id: workspaceId,
    ownerId,
    name: "Moved code fixture",
    slug: `moves-${workspaceId}`,
  });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: ownerId, role: "owner" });
  await db.insert(providerConnections).values({
    id: connectionId,
    workspaceId,
    provider: "github",
    externalAccountId: `fixture-${workspaceId}`,
    displayName: "Movement fixture",
  });
  await db.insert(repositories).values({
    id: repositoryId,
    workspaceId,
    connectionId,
    externalId: `fixture-${workspaceId}`,
    owner: "commerce",
    name: "storefront",
    defaultBranch: "main",
    webUrl: "https://github.com/commerce/storefront",
  });
  await db.insert(pullRequests).values({
    id: pullRequestId,
    repositoryId,
    externalId: `fixture-${workspaceId}`,
    number: 184,
    title: "Extract pricing helpers",
    authorLogin: "fixture",
    sourceBranch: "extract-pricing",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/commerce/storefront/pull/184",
  });
  await db.insert(reviewSnapshots).values({
    id: snapshotId,
    pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  const files: SourceFile[] = [
    {
      path: "src/checkout-helpers.ts",
      content: "",
      previousContent: `${shipping}\n\n${subtotal}`,
      changeType: "deleted",
    },
    {
      path: "src/pricing/shipping.ts",
      content: shipping.replace("50", "75"),
      changeType: "added",
    },
    {
      path: "src/pricing/subtotal.ts",
      content: `import type { Item } from "../types";\n\n${subtotal}`,
      changeType: "added",
    },
    {
      path: "src/checkout.ts",
      previousContent:
        'import { shippingCost, subtotal } from "./checkout-helpers";\n\nexport function checkout(items: Item[]) {\n  return subtotal(items) + shippingCost(subtotal(items));\n}',
      content:
        'import { shippingCost } from "./pricing/shipping";\nimport { subtotal } from "./pricing/subtotal";\n\nexport function checkout(items: Item[]) {\n  return subtotal(items) + shippingCost(subtotal(items));\n}',
      changeType: "modified",
    },
  ];
  const analyzed = await analyzeFiles(files);
  const stored = await Promise.all(
    files.map(async (file) => ({
      file,
      currentBlob: await persistSourceBlob(db, {
        workspaceId,
        bytes: Buffer.from(file.content),
      }),
      previousBlob:
        file.previousContent === undefined
          ? undefined
          : await persistSourceBlob(db, {
              workspaceId,
              bytes: Buffer.from(file.previousContent),
            }),
    })),
  );
  await db.transaction(async (tx) => {
    const rows = await tx
      .insert(snapshotFiles)
      .values(
        stored.map(({ file, currentBlob, previousBlob }) => ({
          snapshotId,
          path: file.path,
          language: "typescript",
          changeType: file.changeType ?? "modified",
          currentBlobId: currentBlob.id,
          previousBlobId: previousBlob?.id,
          additions: file.content.split("\n").length,
          deletions: file.previousContent?.split("\n").length ?? 0,
        })),
      )
      .returning();
    await persistSnapshotAnalysis(tx, {
      snapshotId,
      units: analyzed.units,
      snapshotFileByPath: new Map(rows.map((file) => [file.path, file])),
      storedFileByPath: new Map(stored.map((file) => [file.file.path, file])),
      priorByKey: new Map(),
      reviewImpact: new Map(),
      signOffsByUnit: new Map(),
      waitsByUnit: new Map(),
      partitionFiles: files,
      missingLayoutError: "Fixture layout missing",
      missingMemberError: (key) => `Fixture member ${key} missing`,
    });
  });
  return { ownerId, workspaceId, pullRequestId, snapshotId };
}
