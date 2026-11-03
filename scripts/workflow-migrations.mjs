import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";

export const workflowMigrationsFolder = join(
  dirname(fileURLToPath(import.meta.resolve("@workflow/world-postgres/cli"))),
  "..",
  "src/drizzle/migrations",
);

const backfilledTags = new Set([
  "0011_add_error_code",
  "0012_add_is_system",
  "0013_add_attributes",
  "0014_add_attr_set_event_unique_index",
]);

/**
 * Repairs Workflow 4's backported 0015 checkpoint before Workflow 5 migrates.
 * Drizzle otherwise skips the older 0011–0014 migrations missing from 4.3.4.
 * @param {import("pg").Client} client
 */
export async function backfillWorkflowMigrations(client) {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [1_683_524_536]);
    const existing = await client.query(
      "select to_regclass('workflow_drizzle.workflow_migrations') as journal",
    );
    let count = 0;
    if (existing.rows[0]?.journal) {
      const applied = await client.query(
        "select hash, created_at from workflow_drizzle.workflow_migrations",
      );
      const hashes = new Set(applied.rows.map((row) => row.hash));
      const latest = Math.max(
        0,
        ...applied.rows.map((row) => Number(row.created_at)),
      );
      /** @type {{ entries: Array<{ tag: string }> }} */
      const journal = JSON.parse(
        readFileSync(
          join(workflowMigrationsFolder, "meta/_journal.json"),
          "utf8",
        ),
      );
      const migrations = readMigrationFiles({
        migrationsFolder: workflowMigrationsFolder,
      });
      for (const [index, migration] of migrations.entries()) {
        if (
          !backfilledTags.has(journal.entries[index]?.tag ?? "") ||
          migration.folderMillis > latest ||
          hashes.has(migration.hash)
        ) {
          continue;
        }
        for (const statement of migration.sql) await client.query(statement);
        await client.query(
          "insert into workflow_drizzle.workflow_migrations (hash, created_at) values ($1, $2)",
          [migration.hash, migration.folderMillis],
        );
        count += 1;
      }
    }
    await client.query("commit");
    return count;
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  }
}
