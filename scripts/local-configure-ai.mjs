import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const VERSION = "vault-v1";

/** Derives an isolated workspace key, mirroring src/server/security/vault.ts. */
function workspaceKey(workspaceId) {
  const root = process.env.ENCRYPTION_KEY;
  if (!root) throw new Error("ENCRYPTION_KEY is required");
  return createHmac("sha256", root)
    .update("reviewduck-workspace-key\0")
    .update(workspaceId)
    .digest();
}

/** Encrypts a secret in the same envelope the application vault reads. */
function sealVaultSecret(context, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    workspaceKey(context.workspaceId),
    iv,
  );
  cipher.setAAD(
    Buffer.from(
      `${context.workspaceId}\0${context.recordId}\0${context.provider}`,
      "utf8",
    ),
  );
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

const connectionString = process.env.DATABASE_URL;
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.OPENROUTER_LOCAL_MODEL?.trim() ?? "x-ai/grok-4.5";
const baseUrl = "https://openrouter.ai/api/v1";
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("begin");
  const workspace = await client.query(
    `select id from open_review_duck_workspace order by "createdAt" limit 1`,
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("No workspace found; run the bootstrap first");

  const recordId = randomUUID();
  const encryptedConfiguration = await sealVaultSecret(
    { workspaceId, recordId, provider: "openrouter" },
    JSON.stringify({ apiKey, baseUrl, headers: {} }),
  );

  await client.query(
    `delete from open_review_duck_local_ai_configuration where "workspaceId" = $1`,
    [workspaceId],
  );
  await client.query(
    `insert into open_review_duck_local_ai_configuration
       (id, "workspaceId", provider, model, "encryptedConfiguration", "createdAt", "updatedAt")
     values ($1, $2, 'openrouter', $3, $4, now(), now())`,
    [recordId, workspaceId, model, encryptedConfiguration],
  );
  await client.query(
    `insert into open_review_duck_ai_preference
       ("workspaceId", mode, "selectedModel", "reviewPullRequests", "freeProviderDisclosureAcceptedAt", "createdAt", "updatedAt")
     values ($1, 'on_demand', $2, true, now(), now(), now())
     on conflict ("workspaceId") do update
       set mode = 'on_demand',
           "selectedModel" = excluded."selectedModel",
           "reviewPullRequests" = true,
           "updatedAt" = now()`,
    [workspaceId, model],
  );
  await client.query("commit");
  process.stdout.write(`Configured ${model} for workspace ${workspaceId}\n`);
} catch (cause) {
  await client.query("rollback");
  throw cause;
} finally {
  await client.end();
}
