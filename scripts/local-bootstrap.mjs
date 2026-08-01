import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("begin");
  await client.query(
    `select pg_advisory_xact_lock(hashtext('reviewduck-local-bootstrap'))`,
  );
  await client.query(
    `insert into open_review_duck_user
       (id, "displayName", "currentStreak", "longestStreak", "experiencePoints", "createdAt", "updatedAt")
     values ('reviewduck-local-user', 'Local reviewer', 0, 0, 0, now(), now())
     on conflict (id) do update set "displayName" = excluded."displayName"`,
  );
  const workspace = await client.query(
    `insert into open_review_duck_workspace
       ("ownerId", name, slug, "aiMode", "aiReviewEnabled", "createdAt", "updatedAt")
     values ('reviewduck-local-user', 'Local workspace', 'local', 'on_demand', false, now(), now())
     on conflict (slug) do update set name = excluded.name
     returning id`,
  );
  const workspaceId = workspace.rows[0]?.id;
  await client.query(
    `insert into open_review_duck_workspace_member ("workspaceId", "userId", role, "createdAt")
     values ($1, 'reviewduck-local-user', 'owner', now())
     on conflict ("workspaceId", "userId") do update set role = 'owner'`,
    [workspaceId],
  );
  const activeSession = await client.query(
    `select 1 from open_review_duck_local_session
     where "revokedAt" is null and "expiresAt" > now() limit 1`,
  );
  let bootstrap;
  if (activeSession.rowCount === 0) {
    await client.query(
      `update open_review_duck_local_bootstrap_token
       set "consumedAt" = now()
       where "consumedAt" is null`,
    );
    bootstrap = randomBytes(48).toString("base64url");
    await client.query(
      `insert into open_review_duck_local_bootstrap_token
        ("tokenHash", "expiresAt", "createdAt")
       values ($1, now() + interval '15 minutes', now())`,
      [createHash("sha256").update(bootstrap).digest("hex")],
    );
  }
  await client.query("commit");
  if (bootstrap) {
    process.stdout.write(
      `Open this one-time owner link within 15 minutes:\nhttp://localhost:${port}/api/local/bootstrap?token=${bootstrap}\n`,
    );
  }
} catch (cause) {
  await client.query("rollback");
  throw cause;
} finally {
  await client.end();
}
