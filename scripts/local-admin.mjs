import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  formatLocalBootstrapLink,
  LOCAL_BOOTSTRAP_TTL_MINUTES,
} from "./local-bootstrap-output.mjs";

const [command = "status"] = process.argv.slice(2);
const execute = promisify(execFile);
const dataDirectory = process.env.LOCAL_DATA_DIR ?? "/data";
const connectionString =
  process.env.DATABASE_URL ??
  `postgresql://reviewduck:${await readFile(path.join(dataDirectory, "secrets/database"), "utf8")}@localhost/reviewduck?host=${path.join(dataDirectory, "run/postgresql")}`;

if (command === "restore") {
  const target = process.argv[3];
  if (!target) throw new Error("restore requires a backup path");
  await execute("/usr/lib/postgresql/18/bin/pg_restore", ["--list", target]);
  await execute("/usr/lib/postgresql/18/bin/pg_restore", [
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "--no-owner",
    "--dbname",
    connectionString,
    target,
  ]);
  console.log(`Restored ${target}`);
  process.exit(0);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  if (command === "status") {
    const result = await client.query(
      `select
         (select count(*) from open_review_duck_local_session where "revokedAt" is null and "expiresAt" > now()) as sessions,
         (select count(*) from open_review_duck_repository) as repositories,
         (select count(*) from open_review_duck_review_snapshot) as snapshots`,
    );
    const disk = await statfs(dataDirectory);
    console.log({
      ...result.rows[0],
      version: process.env.REVIEWDUCK_VERSION ?? "development",
      freeBytes: disk.bavail * disk.bsize,
    });
  } else if (command === "bootstrap") {
    const token = randomBytes(48).toString("base64url");
    await client.query("begin");
    try {
      await client.query(
        `select pg_advisory_xact_lock(hashtext('reviewduck-local-bootstrap'))`,
      );
      await client.query(
        `update open_review_duck_local_session set "revokedAt" = now() where "revokedAt" is null`,
      );
      await client.query(
        `update open_review_duck_local_bootstrap_token
         set "consumedAt" = now()
         where "consumedAt" is null`,
      );
      await client.query(
        `insert into open_review_duck_local_bootstrap_token
         ("tokenHash", "expiresAt", "createdAt")
         values ($1, now() + ($2 * interval '1 minute'), now())`,
        [
          createHash("sha256").update(token).digest("hex"),
          LOCAL_BOOTSTRAP_TTL_MINUTES,
        ],
      );
      await client.query("commit");
    } catch (cause) {
      await client.query("rollback");
      throw cause;
    }
    process.stdout.write(
      formatLocalBootstrapLink(
        `http://localhost:${process.env.PORT ?? "3000"}/api/local/bootstrap?token=${token}`,
      ),
    );
  } else if (command === "backup") {
    const target =
      process.argv[3] ??
      path.join(
        dataDirectory,
        "backups",
        `reviewduck-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`,
      );
    await execute("/usr/lib/postgresql/18/bin/pg_dump", [
      "--dbname",
      connectionString,
      "--format=custom",
      "--file",
      target,
    ]);
    await execute("/usr/lib/postgresql/18/bin/pg_restore", ["--list", target]);
    console.log(target);
  } else if (command === "verify-backup") {
    const target = process.argv[3] ?? (await latestBackup());
    if (!target) throw new Error("No local backup exists to verify");
    await execute("/usr/lib/postgresql/18/bin/pg_restore", ["--list", target]);
    console.log(`Verified ${target}`);
  } else if (command === "export") {
    const target =
      process.argv[3] ??
      path.join(
        dataDirectory,
        "backups",
        `reviewduck-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
    const tables = [
      "repository",
      "pull_request",
      "review_snapshot",
      "snapshot_file",
      "review_unit",
      "review_unit_dependency",
      "review_comment",
      "review_session",
      "review_wait",
      "sign_off",
      "ai_job",
    ];
    const exported = {};
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid export table");
      const result = await client.query(
        `select row_to_json(value) as value from open_review_duck_${table} value`,
      );
      exported[table] = result.rows.map((row) => row.value);
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      target,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          version: process.env.REVIEWDUCK_VERSION ?? "development",
          data: exported,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(target);
  } else {
    throw new Error(`Unknown local administration command: ${command}`);
  }
} finally {
  await client.end();
}

/** Returns the newest custom-format local backup, if one exists. */
async function latestBackup() {
  const directory = path.join(dataDirectory, "backups");
  const entries = await readdir(directory, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dump"))
    .map((entry) => path.join(directory, entry.name))
    .sort()
    .reverse();
  return backups[0];
}
