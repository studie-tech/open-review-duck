import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { env } from "~/env";

const VERSION = "vault-v1";

export interface VaultContext {
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

/** Derives an isolated workspace key from the deployment's shared root. */
function workspaceKey(workspaceId: string) {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Credential vault requires ENCRYPTION_KEY");
  }
  return createHmac("sha256", env.ENCRYPTION_KEY)
    .update("reviewduck-workspace-key\0")
    .update(workspaceId)
    .digest();
}

/** Encrypts a secret with workspace- and record-bound authenticated encryption. */
export async function sealVaultSecret(
  context: VaultContext,
  plaintext: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    workspaceKey(context.workspaceId),
    iv,
  );
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
export async function openVaultSecret(context: VaultContext, payload: string) {
  const [version, encodedIv, encodedTag, encodedCiphertext] =
    payload.split(".");
  if (version !== VERSION || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Encrypted vault value has an unsupported format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    workspaceKey(context.workspaceId),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
