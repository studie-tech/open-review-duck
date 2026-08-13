import { createDecipheriv, createHmac } from "node:crypto";
import pg from "pg";

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
  if (version !== "vault-v1") throw new Error("unsupported vault format");
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
  if (process.env.RAW_TOOL_INPUT === "1") {
    const { rows } = await client.query(
      `select c.id, c."encryptedInput", j."workspaceId"
         from open_review_duck_ai_job_tool_call c
         join open_review_duck_ai_job j on j.id = c."jobId"
        where c."toolName" = 'report_finding' limit 6`,
    );
    for (const row of rows) {
      const raw = openVaultSecret(
        { workspaceId: row.workspaceId, recordId: row.id, provider: "ai-tool-input" },
        row.encryptedInput,
      );
      const parsed = JSON.parse(raw);
      for (const finding of parsed.findings ?? []) {
        process.stdout.write(
          `RAW severity=${finding.severity} category=${finding.category} title=${String(finding.title).slice(0, 70)}\n`,
        );
      }
    }
  }
  const { rows } = await client.query(
    `select f.id, f."workspaceId", f.path, f.severity, f.category, f.state,
            f.verdict, f."anchorTier", f."anchorSide", f."startLine", f."endLine",
            f."encryptedContent"
       from open_review_duck_ai_review_finding f
      order by f."orderIndex" nulls last, f."createdAt" limit 200`,
  );
  for (const row of rows) {
    const body = JSON.parse(
      openVaultSecret(
        { workspaceId: row.workspaceId, recordId: row.id, provider: "ai-review-finding" },
        row.encryptedContent,
      ),
    );
    process.stdout.write(
      `\n[${row.severity}/${row.category}] ${row.path}:${row.startLine ?? "?"}-${row.endLine ?? "?"} ` +
        `(${row.state}/${row.verdict}/${row.anchorTier}/${row.anchorSide})\n` +
        `  ${body.title}\n  ${String(body.body).replace(/\s+/g, " ").slice(0, 260)}\n` +
        `  snippet: ${String(body.existingCode).replace(/\s+/g, " ").slice(0, 120)}\n`,
    );
  }
} finally {
  await client.end();
}
