import { createDecipheriv, createHmac } from "node:crypto";
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

/** Decrypts a vault envelope written by the application. */
function openVaultSecret(context, payload) {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION) throw new Error("unsupported vault format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    workspaceKey(context.workspaceId),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(
    Buffer.from(
      `${context.workspaceId}\0${context.recordId}\0${context.provider}`,
      "utf8",
    ),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    `select t.id, t.role, t.sequence, t."encryptedContent", j."workspaceId", i.path
       from open_review_duck_ai_job_turn t
       join open_review_duck_ai_job j on j.id = t."jobId"
       left join open_review_duck_ai_review_item i on i."childJobId" = j.id
      where j."parentJobId" is not null and j.status = 'completed'
      order by j."createdAt", t.sequence
      limit 40`,
  );
  for (const row of rows) {
    const text = openVaultSecret(
      { workspaceId: row.workspaceId, recordId: row.id, provider: "ai-turn" },
      row.encryptedContent,
    );
    const message = JSON.parse(text);
    const content = Array.isArray(message.content)
      ? message.content
          .map((part) =>
            part.type === "text"
              ? part.text
              : `[${part.type}${part.toolName ? ` ${part.toolName}` : ""}]`,
          )
          .join(" ")
      : String(message.content);
    process.stdout.write(
      `--- ${row.path ?? "?"} seq=${row.sequence} ${row.role}\n${content.slice(0, 900)}\n\n`,
    );
  }
} finally {
  await client.end();
}
