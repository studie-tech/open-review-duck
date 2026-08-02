import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { workspaceDataKeys } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";

type Database = typeof database;
const VERSION = "vault-v1";
const keyCache = new Map<string, Buffer>();

interface VaultContext {
  provider: string;
  recordId: string;
  workspaceId: string;
}

/** Encodes the tenant, record, and provider encryption boundary. */
function aad(context: VaultContext) {
  return Buffer.from(
    `${context.workspaceId}\0${context.recordId}\0${context.provider}`,
    "utf8",
  );
}

/** Derives an isolated local workspace key from the volume root secret. */
function localWorkspaceKey(workspaceId: string) {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Local credential vault requires ENCRYPTION_KEY");
  }
  return createHmac("sha256", env.ENCRYPTION_KEY)
    .update("reviewduck-workspace-key\0")
    .update(workspaceId)
    .digest();
}

/** Loads or creates one KMS-wrapped SaaS workspace data key. */
async function saasWorkspaceKey(db: Database, workspaceId: string) {
  const cached = keyCache.get(workspaceId);
  if (cached) return cached;
  if (!env.KMS_KEY_ID)
    throw new Error("SaaS credential vault requires KMS_KEY_ID");
  const { DecryptCommand, GenerateDataKeyCommand, KMSClient } = await import(
    "@aws-sdk/client-kms"
  );
  if (!env.AWS_KMS_ROLE_ARN || !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error("SaaS KMS access requires Vercel OIDC and an AWS role");
  }
  const { fromWebToken } = await import("@aws-sdk/credential-providers");
  const kms = new KMSClient({
    region: env.KMS_REGION,
    credentials: fromWebToken({
      roleArn: env.AWS_KMS_ROLE_ARN,
      roleSessionName: "reviewduck-vercel",
      webIdentityToken: process.env.VERCEL_OIDC_TOKEN,
    }),
  });
  let row = await db.query.workspaceDataKeys.findFirst({
    where: eq(workspaceDataKeys.workspaceId, workspaceId),
  });
  if (!row) {
    const generated = await kms.send(
      new GenerateDataKeyCommand({
        KeyId: env.KMS_KEY_ID,
        KeySpec: "AES_256",
        EncryptionContext: {
          application: "reviewduck",
          workspaceId,
        },
      }),
    );
    if (!generated.Plaintext || !generated.CiphertextBlob) {
      throw new Error("KMS did not return a complete workspace data key");
    }
    const [created] = await db
      .insert(workspaceDataKeys)
      .values({
        workspaceId,
        keyVersion: 1,
        kmsKeyId: env.KMS_KEY_ID,
        encryptedKey: Buffer.from(generated.CiphertextBlob).toString("base64"),
      })
      .onConflictDoNothing({ target: workspaceDataKeys.workspaceId })
      .returning();
    if (created) {
      const plaintext = Buffer.from(generated.Plaintext);
      keyCache.set(workspaceId, plaintext);
      return plaintext;
    }
    generated.Plaintext.fill(0);
    row = await db.query.workspaceDataKeys.findFirst({
      where: eq(workspaceDataKeys.workspaceId, workspaceId),
    });
  }
  if (!row) throw new Error("Workspace data key could not be created");
  const decrypted = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(row.encryptedKey, "base64"),
      KeyId: row.kmsKeyId,
      EncryptionContext: {
        application: "reviewduck",
        workspaceId,
      },
    }),
  );
  if (!decrypted.Plaintext)
    throw new Error("KMS could not decrypt workspace data key");
  const key = Buffer.from(decrypted.Plaintext);
  keyCache.set(workspaceId, key);
  if (keyCache.size > 128) {
    const oldest = keyCache.keys().next().value;
    if (oldest) {
      keyCache.get(oldest)?.fill(0);
      keyCache.delete(oldest);
    }
  }
  return key;
}

/** Selects the deployment-specific workspace-key implementation. */
async function workspaceKey(db: Database, workspaceId: string) {
  return isLocalDeployment()
    ? localWorkspaceKey(workspaceId)
    : saasWorkspaceKey(db, workspaceId);
}

/** Encrypts a secret with workspace- and record-bound authenticated encryption. */
export async function sealVaultSecret(
  db: Database,
  context: VaultContext,
  plaintext: string,
) {
  const key = await workspaceKey(db, context.workspaceId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypts a secret only when its tenant, record, and provider AAD match. */
export async function openVaultSecret(
  db: Database,
  context: VaultContext,
  payload: string,
) {
  const [version, encodedIv, encodedTag, encodedCiphertext] =
    payload.split(".");
  if (version !== VERSION || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Encrypted vault value has an unsupported format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await workspaceKey(db, context.workspaceId),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
